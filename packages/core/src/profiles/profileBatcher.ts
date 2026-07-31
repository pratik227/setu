/**
 * Batched profile and relay-list loading.
 *
 * The naive approach does not survive contact with a relay: relays cap concurrent
 * subscriptions (`max_subscriptions` in NIP-11 is often 20), and a timeline of 50
 * notes by 40 authors asking for each author's profile as it scrolls into view is
 * 40 subscriptions the relay will simply refuse.
 *
 * So all demand across the entire app funnels through one debounced, chunked,
 * de-duplicated queue:
 *  - **debounce** so a screen full of avatars mounting produces one request;
 *  - **chunk** so no single filter exceeds a relay's author limit;
 *  - **dedupe** against what is already stored and already in flight;
 *  - **cool down** failures, so a pubkey with no discoverable profile is not
 *    re-requested on every render forever.
 */

import type { Hex32, RelayBasedFilter } from "@setu/protocol";
import type {
  EventStore,
  ProfileBatcher,
  SubscriptionManager,
} from "../contracts";
import { normalizeRelayUrls } from "../relay/normalize";
import type { OutboxRouter } from "../relay/outboxRouter";
import { KIND_METADATA, KIND_RELAY_LIST } from "../store/kinds";

/** Construction options for {@link DefaultProfileBatcher}. */
export interface ProfileBatcherOptions {
  readonly store: EventStore;
  readonly subscriptions: SubscriptionManager;
  /** Relays used when no router is supplied, or when routing yields nothing. */
  readonly relays: readonly string[];
  /** Optional outbox router; profiles are best fetched from the author's relays. */
  readonly router?: OutboxRouter;
  /** Debounce window in ms. Default 250. */
  readonly debounceMs?: number;
  /** Max authors per filter. Default 100. */
  readonly maxAuthorsPerFilter?: number;
  /** How long before a pubkey that yielded nothing may be retried. Default 60s. */
  readonly failureCooldownMs?: number;
  /** Kinds requested per pubkey. Default `[0, 10002]`. */
  readonly kinds?: readonly number[];
  /** Millisecond clock, injectable for tests. */
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/** Queue and cache counters, for a debug UI. */
export interface ProfileBatcherStats {
  /** Pubkeys whose metadata we hold. */
  readonly loaded: number;
  /** Pubkeys queued for the next flush. */
  readonly queued: number;
  /** Pubkeys in a request that has not resolved. */
  readonly inFlight: number;
  /** Pubkeys in failure cooldown. */
  readonly cooling: number;
}

/** The app-wide profile loader. One instance per account. */
export class DefaultProfileBatcher implements ProfileBatcher {
  private readonly loaded = new Set<Hex32>();
  private readonly inFlight = new Set<Hex32>();
  private readonly failedAt = new Map<Hex32, number>();
  private queued = new Set<Hex32>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: ProfileBatcherOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Current queue and cache sizes. */
  stats(): ProfileBatcherStats {
    return {
      loaded: this.loaded.size,
      queued: this.queued.size,
      inFlight: this.inFlight.size,
      cooling: this.failedAt.size,
    };
  }

  /**
   * Registers interest in some pubkeys. Returns immediately; results arrive in
   * the store, where the caller is already observing.
   *
   * Cheap enough to call from a render path — everything already known, in flight
   * or cooling down is discarded here rather than becoming network traffic.
   */
  request(pubkeys: readonly Hex32[]): void {
    let added = false;
    for (const pubkey of pubkeys) {
      if (pubkey === "" || this.loaded.has(pubkey)) continue;
      if (this.inFlight.has(pubkey) || this.queued.has(pubkey)) continue;
      if (this.isCoolingDown(pubkey)) continue;
      this.queued.add(pubkey);
      added = true;
    }
    if (added) this.schedule();
  }

  /** Runs the queue now and resolves once every in-flight request has settled. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.running = this.running.then(() => this.drain());
    await this.running;
  }

  /** Forgets everything. Call on account switch. */
  reset(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.loaded.clear();
    this.inFlight.clear();
    this.failedAt.clear();
    this.queued.clear();
  }

  private get kinds(): readonly number[] {
    return this.options.kinds ?? [KIND_METADATA, KIND_RELAY_LIST];
  }

  private isCoolingDown(pubkey: Hex32): boolean {
    const failed = this.failedAt.get(pubkey);
    if (failed === undefined) return false;
    const cooldown = this.options.failureCooldownMs ?? 60_000;
    if (this.now() - failed < cooldown) return true;
    this.failedAt.delete(pubkey);
    return false;
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.running.then(() => this.drain());
      void this.running.catch((error) => this.options.onError?.(error));
    }, this.options.debounceMs ?? 250);
  }

  private async drain(): Promise<void> {
    while (this.queued.size > 0) {
      const batch = [...this.queued];
      this.queued = new Set();
      const wanted = await this.dropAlreadyStored(batch);
      const chunkSize = Math.max(1, this.options.maxAuthorsPerFilter ?? 100);
      for (let i = 0; i < wanted.length; i += chunkSize) {
        await this.fetchChunk(wanted.slice(i, i + chunkSize));
      }
    }
  }

  /** Marks anything already in the store as loaded without asking a relay. */
  private async dropAlreadyStored(
    pubkeys: readonly Hex32[],
  ): Promise<readonly Hex32[]> {
    if (pubkeys.length === 0) return [];
    const held = await this.heldPubkeys(pubkeys);
    const remaining: Hex32[] = [];
    for (const pubkey of pubkeys) {
      if (held.has(pubkey)) this.loaded.add(pubkey);
      else remaining.push(pubkey);
    }
    return remaining;
  }

  private async heldPubkeys(
    pubkeys: readonly Hex32[],
  ): Promise<ReadonlySet<Hex32>> {
    const rows = await this.options.store.query({
      kinds: [KIND_METADATA],
      authors: [...pubkeys],
    });
    const held = new Set<Hex32>();
    for (const row of rows) held.add(row.event.pubkey);
    return held;
  }

  private async fetchChunk(chunk: readonly Hex32[]): Promise<void> {
    if (chunk.length === 0) return;
    for (const pubkey of chunk) this.inFlight.add(pubkey);
    try {
      const filters = await this.filtersFor(chunk);
      if (filters.length > 0) {
        await this.options.subscriptions.fetch({ filters });
      }
      const held = await this.heldPubkeys(chunk);
      const now = this.now();
      for (const pubkey of chunk) {
        if (held.has(pubkey)) {
          this.loaded.add(pubkey);
          this.failedAt.delete(pubkey);
        } else {
          // Nothing came back. Remember, so a missing profile does not become an
          // infinite retry loop driven by the render path.
          this.failedAt.set(pubkey, now);
        }
      }
    } catch (error) {
      this.options.onError?.(error);
      const now = this.now();
      for (const pubkey of chunk) this.failedAt.set(pubkey, now);
    } finally {
      for (const pubkey of chunk) this.inFlight.delete(pubkey);
    }
  }

  /**
   * The bound for one profile request: an exact one.
   *
   * Every kind requested here is replaceable, so a relay can legitimately hold at
   * most one event per (author, kind) — `authors × kinds` is therefore the largest
   * honest answer, not a guess. Sending it matters because an unbounded filter
   * invites a relay that kept older versions to serve all of them, and because a
   * relay that caps unbounded queries silently would rather be told a number it can
   * honour.
   */
  private limitFor(authorCount: number): number {
    return Math.max(1, authorCount) * Math.max(1, this.kinds.length);
  }

  private async filtersFor(
    chunk: readonly Hex32[],
  ): Promise<readonly RelayBasedFilter[]> {
    const router = this.options.router;
    if (router !== undefined) {
      const routed = await router.route(chunk, { kinds: [...this.kinds] });
      // Routing splits the chunk per relay, so each filter is bounded by the
      // authors *it* asks for rather than by the whole batch.
      if (routed.length > 0) {
        return routed.map((rf) => ({
          relay: rf.relay,
          filter: {
            ...rf.filter,
            limit: this.limitFor(rf.filter.authors?.length ?? chunk.length),
          },
        }));
      }
    }
    const filter = {
      kinds: [...this.kinds],
      authors: [...chunk],
      limit: this.limitFor(chunk.length),
    };
    return normalizeRelayUrls(this.options.relays).map((relay) => ({
      relay,
      filter,
    }));
  }
}
