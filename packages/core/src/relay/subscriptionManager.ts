/**
 * The single read API for the whole app.
 *
 * Everything above this line reads the store; everything below it is transport.
 * The manager's job is the three things that must happen to every inbound event,
 * in this order, with no way to skip a step:
 *
 *   relay → **verify** → **store** → (observers) → UI
 *
 * Consequences worth stating:
 *  - An event that fails verification never reaches the store, so it can never be
 *    rendered. Drops are counted rather than silently discarded so a debug UI can
 *    show "37 events dropped from wss://sketchy.relay".
 *  - Verification and storage are batched off the receive path, so a 500-event
 *    backfill is a handful of store writes and a handful of observer callbacks.
 *  - `publish` writes locally *first*. The author's own note appears through the
 *    ordinary store→observe path, which is why this codebase needs no
 *    optimistic-UI special case anywhere in the view layer.
 */

import type {
  Filter,
  Hex32,
  NostrEvent,
  RelayBasedFilter,
  Timestamp,
} from "@setu/protocol";
import type {
  EventStore,
  EventVerifier,
  PublishResult,
  ReadMode,
  ReadRequest,
  RelayPool,
  SubscriptionHandle,
  SubscriptionManager,
} from "../contracts";
import { BatchQueue } from "../internal/batchQueue";
import type { MatchesFilterFn } from "../internal/filterMatch";
import { matchesFilter as defaultMatchesFilter } from "../internal/filterMatch";
import type { Scheduler } from "../internal/scheduler";
import { frameScheduler } from "../internal/scheduler";
import {
  mayPublish,
  ProtectedEventPublishError,
  UnverifiedPublishError,
} from "../store/protection";
import { normalizeRelayUrl, normalizeRelayUrls } from "./normalize";
import { clampLimit, type RelayInfo } from "./relayInfo";
import type { PoolSubscriptionCallbacks } from "./relayPool";
import { DEFAULT_OVERLAP_SECONDS, SinceTracker } from "./sinceTracker";

/** Ingest counters, safe to poll for a debug overlay. */
export interface IngestStats {
  /** Events handed to us by the pool. */
  readonly received: number;
  /** Events that passed verification. */
  readonly verified: number;
  /** Events dropped because verification failed. */
  readonly dropped: number;
  /** Events the store actually accepted (dedup/LWW/tombstones reject the rest). */
  readonly stored: number;
}

/** Construction options for {@link DefaultSubscriptionManager}. */
export interface SubscriptionManagerOptions {
  readonly pool: RelayPool;
  readonly store: EventStore;
  /** Always required. There is no "skip verification" configuration. */
  readonly verifier: EventVerifier;
  /** Shared watermark tracker; one is created if omitted. */
  readonly sinceTracker?: SinceTracker;
  /** Clock-skew tolerance for incremental reads. Default 120s. */
  readonly overlapSeconds?: number;
  /** Tick source for ingest batching. Defaults to one flush per frame. */
  readonly scheduler?: Scheduler;
  /** Relays used by `publish` when the caller does not name any. */
  readonly defaultRelays?: () => readonly string[] | Promise<readonly string[]>;
  /**
   * Per-relay NIP-11 capabilities, consulted to clamp each filter's `limit`.
   *
   * Optional, and absence changes nothing except that limits go out unclamped. A
   * relay whose `max_limit` is below what we asked truncates the result *silently*,
   * so asking for more than it will give means a short answer can no longer be read
   * as "that is everything" — which is precisely what `until`-based pagination
   * relies on to decide it has reached the end.
   */
  readonly relayInfo?: (relay: string) => RelayInfo | undefined;
  /**
   * The pubkey this client can legitimately claim authorship of, or `undefined`
   * when there is no signed-in identity.
   *
   * Read on every `publish` rather than captured once, so signing in or switching
   * accounts needs no re-wiring. Its only use is the NIP-70 check: with no
   * identity configured, every protected event is treated as someone else's,
   * which is the safe reading (see `store/protection.mayPublish`).
   */
  readonly ownPubkey?: () => Hex32 | undefined;
  /** Injected NIP-01 matcher, used to attribute events to filters. */
  readonly matchesFilter?: MatchesFilterFn;
  /** Backstop for `fetch` if a pool ever fails to complete. Default 20s. */
  readonly fetchTimeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

interface IngestItem {
  readonly event: NostrEvent;
  readonly relay: string;
  /** The filters this relay was asked, for watermark attribution. */
  readonly filters: readonly Filter[];
}

interface ManagedSubscription {
  closed: boolean;
  inner: SubscriptionHandle | undefined;
}

const DEFAULT_MODE: ReadMode = { type: "localAndNetworkParallel" };

/** The one read API. See the module doc. */
export class DefaultSubscriptionManager implements SubscriptionManager {
  private readonly ingest: BatchQueue<IngestItem>;
  private readonly since: SinceTracker;
  private readonly matches: MatchesFilterFn;
  private counts = { received: 0, verified: 0, dropped: 0, stored: 0 };
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: SubscriptionManagerOptions) {
    this.since =
      options.sinceTracker ??
      new SinceTracker(options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS);
    this.matches = options.matchesFilter ?? defaultMatchesFilter;
    this.ingest = new BatchQueue<IngestItem>({
      onFlush: (items) => this.absorb(items),
      scheduler: options.scheduler ?? frameScheduler,
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  /** Cumulative ingest counters, including the verification drop count. */
  stats(): IngestStats {
    return { ...this.counts };
  }

  /** The shared watermark tracker, exposed for account-scope resets. */
  get sinceTracker(): SinceTracker {
    return this.since;
  }

  /**
   * Opens a live subscription. Events land in the store; the caller observes the
   * store, never this handle.
   *
   * `mode` matters here only insofar as `localOnly` opens no socket at all — for a
   * live subscription there is no ordering between "local" and "network" to
   * choose, because local data is already in the store the caller is observing.
   */
  subscribe(request: ReadRequest): SubscriptionHandle {
    const id = `read-${this.nextId++}`;
    const state: ManagedSubscription = { closed: false, inner: undefined };
    const handle: SubscriptionHandle = {
      id,
      close: () => {
        state.closed = true;
        state.inner?.close();
        state.inner = undefined;
      },
    };
    const mode = request.mode ?? DEFAULT_MODE;
    if (mode.type === "localOnly") return handle;

    // Filter preparation is async (it reads the store for watermarks) but the
    // handle must be returned synchronously, so closing before the socket opens
    // has to be honoured.
    void this.prepare(request)
      .then((filters) => {
        if (state.closed || this.closed || filters.length === 0) return;
        state.inner = this.openPoolSubscription(filters, {});
      })
      .catch((error) => this.options.onError?.(error));
    return handle;
  }

  /**
   * One-shot read.
   *
   * Mode semantics (the contract leaves the exact resolution point open, so they
   * are pinned here):
   *  - `localOnly` — resolves with local matches; no socket is opened.
   *  - `localThenNetwork` — resolves with local matches as soon as they are read;
   *    the network read continues in the background and lands in the store, where
   *    observers pick it up.
   *  - `localAndNetworkParallel` (default) — starts both immediately and resolves
   *    with the union once every relay has EOSE'd, failed or timed out.
   */
  async fetch(request: ReadRequest): Promise<readonly NostrEvent[]> {
    const mode = request.mode ?? DEFAULT_MODE;
    const localPromise = this.readLocal(request.filters);

    if (mode.type === "localOnly") return localPromise;

    const filters = await this.prepare(request);
    if (filters.length === 0) return localPromise;

    if (mode.type === "localThenNetwork") {
      const local = await localPromise;
      void this.collectFromNetwork(filters).catch((error) =>
        this.options.onError?.(error),
      );
      return local;
    }

    const [local, network] = await Promise.all([
      localPromise,
      this.collectFromNetwork(filters),
    ]);
    return dedupeById([...local, ...network]);
  }

  /**
   * Publishes with a local echo first.
   *
   * The store write happens before any socket traffic and is awaited, so by the
   * time this function has yielded once the author's own note is already visible
   * through the normal observe path.
   *
   * The echoed event **is** verified first. It is a single event, not a batch, so
   * the cost is one signature check rather than the queue wait the local echo
   * exists to avoid. Skipping it would leave one path into the store that trusts
   * its caller: an event carrying a valid `(id, sig)` pair lifted from a real
   * event with the content swapped passes a signature-only check, and would reach
   * the UI as genuine. "Every event in the store is verified" has to be true on
   * every path or it is not a property the rest of the client can rely on.
   *
   * @throws {ProtectedEventPublishError} when `event` carries a NIP-70 `-` tag and
   * is not ours to publish. The check runs before the local echo, so a refused
   * publish has no side effects at all — a caller cannot end up with a note in the
   * store that no relay will ever hold.
   */
  async publish(
    event: NostrEvent,
    relays?: readonly string[],
  ): Promise<readonly PublishResult[]> {
    // NIP-70. Refusing loudly is the point: a silent drop would leave the caller's
    // UI showing a post no relay ever saw, and sending it anyway would move the
    // author's note to a relay they deliberately kept it off.
    if (!mayPublish(event, this.options.ownPubkey?.())) {
      throw new ProtectedEventPublishError(event);
    }
    // Verified before the echo, and before any relay traffic, so a rejected
    // event has no side effects.
    if (!(await this.options.verifier.verify(event))) {
      throw new UnverifiedPublishError(event);
    }
    await this.options.store.put(event);
    const targets = normalizeRelayUrls(
      relays ?? (await this.resolveDefaultRelays()),
    );
    if (targets.length === 0) return [];
    return this.options.pool.publish(event, targets);
  }

  /** Drains the ingest queue. Tests and shutdown. */
  async flushIngest(): Promise<void> {
    await this.ingest.flush();
  }

  /** Stops accepting new work. Does not close the pool or the store. */
  close(): void {
    this.closed = true;
    this.ingest.clear();
  }

  // --- filter preparation ----------------------------------------------

  /**
   * Applies incremental `since` rewriting, per relay.
   *
   * The watermark comes from {@link SinceTracker} — which is keyed by
   * (relay, filter) — falling back to the store's global newest timestamp for a
   * relay we have no history with. See that module for why a global `since` is
   * wrong.
   */
  private async prepare(
    request: ReadRequest,
  ): Promise<readonly RelayBasedFilter[]> {
    const normalized = request.filters
      .map((rf) => {
        const relay = normalizeRelayUrl(rf.relay);
        return { relay, filter: this.clampToRelay(relay, rf.filter) };
      })
      .filter((rf) => rf.relay !== "");
    if (request.incremental !== true) return normalized;

    const localNewest = new Map<Filter, Timestamp | undefined>();
    const out: RelayBasedFilter[] = [];
    for (const rf of normalized) {
      if (!localNewest.has(rf.filter)) {
        localNewest.set(
          rf.filter,
          await this.options.store.newestTimestamp(rf.filter),
        );
      }
      out.push(this.since.applyTo(rf, localNewest.get(rf.filter)));
    }
    return out;
  }

  /**
   * Lower a filter's `limit` to what this relay will actually honour.
   *
   * Returns the same object when nothing changes, so filter identity — which the
   * ingest path uses to attribute events back to the filter that asked for them —
   * survives untouched for the common case.
   */
  private clampToRelay(relay: string, filter: Filter): Filter {
    if (filter.limit === undefined) return filter;
    const info = this.options.relayInfo?.(relay);
    const clamped = clampLimit(filter.limit, info);
    return clamped === filter.limit ? filter : { ...filter, limit: clamped };
  }

  // --- network plumbing -------------------------------------------------

  private openPoolSubscription(
    filters: readonly RelayBasedFilter[],
    extra: PoolSubscriptionCallbacks,
  ): SubscriptionHandle {
    const filtersByRelay = groupFilters(filters);
    const callbacks: PoolSubscriptionCallbacks = {
      ...extra,
      onEvent: (event, relay) => {
        extra.onEvent?.(event, relay);
        this.ingest.push({
          event,
          relay,
          filters: filtersByRelay.get(relay) ?? [],
        });
      },
    };
    return this.options.pool.subscribe(filters, callbacks);
  }

  /**
   * Runs a network read to completion, resolving with the verified events it
   * produced.
   *
   * Every exit is bounded: the pool completes on EOSE, failure or its own
   * timeout, and this adds a further backstop so a pool bug cannot hang a caller.
   */
  private async collectFromNetwork(
    filters: readonly RelayBasedFilter[],
  ): Promise<readonly NostrEvent[]> {
    const collected: NostrEvent[] = [];
    return new Promise<readonly NostrEvent[]>((resolve) => {
      let settled = false;
      let handle: SubscriptionHandle | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        handle?.close();
        // Make sure everything collected is verified and stored before the
        // caller reads the store.
        void this.ingest.flush().then(() => resolve(collected));
      };
      const timer = setTimeout(finish, this.options.fetchTimeoutMs ?? 20_000);
      handle = this.openPoolSubscription(filters, {
        onEvent: (event) => collected.push(event),
        onComplete: finish,
      });
    });
  }

  private async readLocal(
    filters: readonly RelayBasedFilter[],
  ): Promise<readonly NostrEvent[]> {
    const seenFingerprints = new Set<string>();
    const results: NostrEvent[] = [];
    for (const { filter } of filters) {
      const key = JSON.stringify(filter);
      if (seenFingerprints.has(key)) continue;
      seenFingerprints.add(key);
      const stored = await this.options.store.query(filter);
      for (const row of stored) results.push(row.event);
    }
    return dedupeById(results);
  }

  private async resolveDefaultRelays(): Promise<readonly string[]> {
    const provider = this.options.defaultRelays;
    if (provider === undefined) return [];
    return provider();
  }

  // --- ingest -----------------------------------------------------------

  /**
   * The verify-then-store step. Runs once per tick over everything that arrived.
   *
   * Unverified events are counted and dropped here and nowhere else, which is why
   * there is no path from a socket to the store that bypasses verification.
   */
  private async absorb(items: readonly IngestItem[]): Promise<void> {
    if (items.length === 0) return;
    this.counts.received += items.length;

    const verified = await this.options.verifier.verifyAll(
      items.map((item) => item.event),
    );
    const verifiedIds = new Set(verified.map((event) => event.id));
    this.counts.verified += verified.length;
    this.counts.dropped += items.length - verified.length;

    const byRelay = new Map<string, NostrEvent[]>();
    for (const item of items) {
      if (!verifiedIds.has(item.event.id)) continue;
      const bucket = byRelay.get(item.relay);
      if (bucket === undefined) byRelay.set(item.relay, [item.event]);
      else bucket.push(item.event);
      // Watermarks are attributed to the specific filters the event matches, not
      // to every filter this relay was asked — otherwise a busy filter would
      // drag an unrelated one's `since` forward and lose events.
      for (const filter of item.filters) {
        if (!this.matches(item.event, filter)) continue;
        this.since.record(item.relay, filter, item.event.created_at);
      }
    }
    for (const [relay, events] of byRelay) {
      this.counts.stored += await this.options.store.putAll(events, relay);
    }
  }
}

function groupFilters(
  filters: readonly RelayBasedFilter[],
): Map<string, Filter[]> {
  const grouped = new Map<string, Filter[]>();
  for (const { relay, filter } of filters) {
    const url = normalizeRelayUrl(relay);
    const bucket = grouped.get(url);
    if (bucket === undefined) grouped.set(url, [filter]);
    else bucket.push(filter);
  }
  return grouped;
}

function dedupeById(events: readonly NostrEvent[]): readonly NostrEvent[] {
  const seen = new Set<string>();
  const out: NostrEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out;
}
