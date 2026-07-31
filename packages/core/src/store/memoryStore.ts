/**
 * In-memory {@link EventStore} — the reference implementation.
 *
 * Every semantic rule the app depends on (dedup with provenance merging,
 * replaceable/addressable last-write-wins with the NIP-01 lexical-id tiebreaker,
 * NIP-09 tombstones as insert-blocking rules, ephemeral drop, NIP-40 expiry,
 * NIP-70 protection marking, coalesced live queries, index selection) is
 * implemented here first and shared with
 * {@link ../store/dexieStore.DexieEventStore} through the sibling modules. The
 * conformance suite runs against both, so this is the definition of correct.
 */

import type { Filter, Hex32, NostrEvent, Timestamp } from "@setu/protocol";
import type { EventStore, StoredEvent, Unsubscribe } from "../contracts";
import type {
  IsValidEventShapeFn,
  MatchesFilterFn,
} from "../internal/filterMatch";
import {
  isValidEventShape as defaultIsValidEventShape,
  matchesFilter as defaultMatchesFilter,
} from "../internal/filterMatch";
import type { Scheduler } from "../internal/scheduler";
import { ExpirationIndex, isExpiredAt } from "./expiration";
import { addressOf, isEphemeralKind, KIND_DELETION } from "./kinds";
import { ObserverRegistry } from "./observers";
import { isProtected } from "./protection";
import type { IndexStats } from "./queryPlan";
import { chooseIndex, sortAndLimit, tagIndexKeysOf } from "./queryPlan";
import {
  compareStoredNewestFirst,
  initialProvenance,
  mergeProvenance,
  shouldReplace,
} from "./replaceable";
import { TombstoneIndex } from "./tombstones";

/** Construction options common to both store implementations. */
export interface EventStoreOptions {
  /**
   * Injected NIP-01 matcher. Defaults to the local fallback in
   * `internal/filterMatch` — swap in `@setu/protocol`'s once it ships.
   */
  readonly matchesFilter?: MatchesFilterFn;
  /** Injected structural validator. Same injection rationale as above. */
  readonly isValidEventShape?: IsValidEventShapeFn;
  /** Tick source for coalescing `observe` callbacks. */
  readonly scheduler?: Scheduler;
  /**
   * Clock for `provenance.firstSeen` and for NIP-40 expiry, in unix seconds.
   *
   * Injected rather than read from `Date.now()` inline so expiry is testable
   * without sleeping, and so a host with a corrected clock (or a fixture) can
   * supply one. Every expiry decision in this store reads it.
   */
  readonly now?: () => Timestamp;
  /** Receives errors thrown by observer callbacks. */
  readonly onError?: (error: unknown) => void;
}

/** In-memory event store. See the module doc for the semantics it defines. */
export class MemoryEventStore implements EventStore {
  private readonly byId = new Map<Hex32, StoredEvent>();
  private readonly byKind = new Map<number, Set<Hex32>>();
  private readonly byAuthor = new Map<Hex32, Set<Hex32>>();
  private readonly byTag = new Map<string, Set<Hex32>>();
  /** Newest-first, maintained by binary insertion — never re-sorted wholesale. */
  private readonly createdOrder: StoredEvent[] = [];
  /** `kind:pubkey:dTag` -> the id of the version currently held. */
  private readonly byAddress = new Map<string, Hex32>();
  private readonly tombstones = new TombstoneIndex();
  /** Soonest-first deadlines of the events that carry a NIP-40 expiration. */
  private readonly expirations = new ExpirationIndex();
  private readonly observers: ObserverRegistry;
  private readonly matches: MatchesFilterFn;
  private readonly isValidShape: IsValidEventShapeFn;
  private readonly now: () => Timestamp;

  constructor(options: EventStoreOptions = {}) {
    this.matches = options.matchesFilter ?? defaultMatchesFilter;
    this.isValidShape = options.isValidEventShape ?? defaultIsValidEventShape;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.observers = new ObserverRegistry({
      evaluate: (filter) => this.query(filter),
      matchesFilter: this.matches,
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  /** Number of events currently held. Diagnostics only. */
  get size(): number {
    return this.byId.size;
  }

  /** Number of tombstones currently held. Diagnostics only. */
  get tombstoneCount(): number {
    return this.tombstones.size;
  }

  /** Number of events carrying a NIP-40 deadline. Diagnostics only. */
  get expiringCount(): number {
    return this.expirations.size;
  }

  async put(event: NostrEvent, relay?: string): Promise<boolean> {
    const now = this.now();
    // Sweeping before the write keeps expiry cheap: a live client writes
    // constantly, so the row of an expired event rarely outlives it by long.
    const expired = this.sweepInternal(now);
    const { accepted, touched } = this.putInternal(event, relay, now);
    this.observers.notify([...expired, ...touched]);
    return accepted;
  }

  async putAll(events: readonly NostrEvent[], relay?: string): Promise<number> {
    // One observer flush for the whole batch, however many events it contains.
    return this.observers.runBatch(() => {
      // One clock reading for the batch, so a 500-event backfill cannot have
      // two events disagree about what "now" was.
      const now = this.now();
      let accepted = 0;
      const touched: NostrEvent[] = [...this.sweepInternal(now)];
      for (const event of events) {
        const result = this.putInternal(event, relay, now);
        if (result.accepted) accepted += 1;
        touched.push(...result.touched);
      }
      this.observers.notify(touched);
      return accepted;
    });
  }

  async get(id: Hex32): Promise<StoredEvent | undefined> {
    const stored = this.byId.get(id);
    if (stored === undefined) return undefined;
    // Expired but not yet swept: hidden from reads immediately, so no caller can
    // observe an event past its deadline regardless of sweep timing.
    return isExpiredAt(stored.event, this.now()) ? undefined : stored;
  }

  async query(filter: Filter): Promise<readonly StoredEvent[]> {
    const now = this.now();
    const matched: StoredEvent[] = [];
    for (const stored of this.candidates(filter)) {
      if (isExpiredAt(stored.event, now)) continue;
      if (this.matches(stored.event, filter)) matched.push(stored);
    }
    return sortAndLimit(matched, filter);
  }

  observe(
    filter: Filter,
    onChange: (events: readonly StoredEvent[]) => void,
  ): Unsubscribe {
    return this.observers.register(filter, onChange);
  }

  async newestTimestamp(filter: Filter): Promise<Timestamp | undefined> {
    // No sort and no array build: this runs on every incremental reconnect.
    const now = this.now();
    let newest: Timestamp | undefined;
    for (const stored of this.candidates(filter)) {
      // An expired event must not drag the watermark forward, or a reconnect
      // would skip the window it occupied.
      if (isExpiredAt(stored.event, now)) continue;
      if (!this.matches(stored.event, filter)) continue;
      if (newest === undefined || stored.event.created_at > newest) {
        newest = stored.event.created_at;
      }
    }
    return newest;
  }

  async count(filter: Filter): Promise<number> {
    // `limit` is deliberately ignored: a count of "how many match" is more useful
    // than a count capped at the page size.
    const now = this.now();
    let total = 0;
    for (const stored of this.candidates(filter)) {
      if (isExpiredAt(stored.event, now)) continue;
      if (this.matches(stored.event, filter)) total += 1;
    }
    return total;
  }

  async sweepExpired(): Promise<number> {
    const removed = this.sweepInternal(this.now());
    this.observers.notify(removed);
    return removed.length;
  }

  async nextExpirationAt(): Promise<Timestamp | undefined> {
    return this.expirations.earliest();
  }

  async clear(): Promise<void> {
    this.byId.clear();
    this.byKind.clear();
    this.byAuthor.clear();
    this.byTag.clear();
    this.byAddress.clear();
    this.createdOrder.length = 0;
    this.tombstones.clear();
    this.expirations.clear();
    this.observers.notifyAll();
  }

  /** Drops every observer. Call when tearing down an account scope. */
  close(): void {
    this.observers.close();
  }

  /** Resolves once all pending observer callbacks have fired. Tests only. */
  async settle(): Promise<void> {
    await this.observers.settle();
  }

  // --- write path -------------------------------------------------------

  /**
   * Removes every event whose deadline has arrived, returning them so the caller
   * can wake the observers that were showing them.
   */
  private sweepInternal(now: Timestamp): readonly NostrEvent[] {
    const removed: NostrEvent[] = [];
    for (const id of this.expirations.takeDue(now)) {
      const stored = this.byId.get(id);
      if (stored === undefined) continue;
      this.removeById(id);
      removed.push(stored.event);
    }
    return removed;
  }

  private putInternal(
    event: NostrEvent,
    relay: string | undefined,
    now: Timestamp,
  ): { accepted: boolean; touched: readonly NostrEvent[] } {
    if (!this.isValidShape(event)) return { accepted: false, touched: [] };
    // Ephemeral events are never persisted, so they can never appear in a query
    // and therefore are not routed through the store at all.
    if (isEphemeralKind(event.kind)) return { accepted: false, touched: [] };
    // NIP-40: an event that is already past its deadline never enters the store,
    // so there is no window in which a query could return it.
    if (isExpiredAt(event, now)) return { accepted: false, touched: [] };

    const touched: NostrEvent[] = [];

    // Ingest deletions before the block check so a kind-5 both takes effect and
    // is itself stored (it is a normal event that other clients may need).
    if (event.kind === KIND_DELETION) {
      const targets = this.tombstones.ingest(event);
      for (const id of targets.ids) {
        const stored = this.byId.get(id);
        // Author check at eviction time as well as at ingest time.
        if (stored === undefined || stored.event.pubkey !== event.pubkey) {
          continue;
        }
        this.removeById(id);
        touched.push(stored.event);
      }
      for (const address of targets.addresses) {
        const currentId = this.byAddress.get(address);
        if (currentId === undefined) continue;
        const stored = this.byId.get(currentId);
        if (stored === undefined) continue;
        if (stored.event.created_at > targets.createdAt) continue;
        this.removeById(currentId);
        touched.push(stored.event);
      }
    }

    if (this.tombstones.blocks(event)) return { accepted: false, touched };

    const existing = this.byId.get(event.id);
    if (existing !== undefined) {
      const provenance = mergeProvenance(existing.provenance, relay);
      if (provenance !== existing.provenance) {
        // Same row, richer provenance. Not a content change, so observers are
        // not woken: nothing they render has changed.
        const updated: StoredEvent = { ...existing, provenance };
        this.byId.set(event.id, updated);
        this.replaceInOrder(existing, updated);
      }
      return { accepted: false, touched };
    }

    const address = addressOf(event);
    if (address !== undefined) {
      const currentId = this.byAddress.get(address);
      const current =
        currentId === undefined ? undefined : this.byId.get(currentId);
      if (current !== undefined) {
        if (!shouldReplace(event, current.event)) {
          return { accepted: false, touched };
        }
        this.removeById(current.event.id);
        touched.push(current.event);
      }
    }

    const stored: StoredEvent = {
      event,
      provenance: initialProvenance(relay, now),
      // NIP-70 marking, derived from the tags the signature already covers.
      ...(isProtected(event) ? { protected: true as const } : {}),
    };
    this.insert(stored, address);
    touched.push(event);
    return { accepted: true, touched };
  }

  private insert(stored: StoredEvent, address: string | undefined): void {
    const { event } = stored;
    this.byId.set(event.id, stored);
    this.expirations.add(event);
    addTo(this.byKind, event.kind, event.id);
    addTo(this.byAuthor, event.pubkey, event.id);
    for (const key of tagIndexKeysOf(event.tags)) {
      addTo(this.byTag, key, event.id);
    }
    if (address !== undefined) this.byAddress.set(address, event.id);
    this.createdOrder.splice(this.orderInsertionIndex(stored), 0, stored);
  }

  private removeById(id: Hex32): void {
    const stored = this.byId.get(id);
    if (stored === undefined) return;
    const { event } = stored;
    this.byId.delete(id);
    this.expirations.remove(id);
    removeFrom(this.byKind, event.kind, id);
    removeFrom(this.byAuthor, event.pubkey, id);
    for (const key of tagIndexKeysOf(event.tags)) {
      removeFrom(this.byTag, key, id);
    }
    const address = addressOf(event);
    if (address !== undefined && this.byAddress.get(address) === id) {
      this.byAddress.delete(address);
    }
    const index = this.orderIndexOf(stored);
    if (index >= 0) this.createdOrder.splice(index, 1);
  }

  // --- created_at ordering ---------------------------------------------

  /** Binary search for the newest-first insertion point. */
  private orderInsertionIndex(stored: StoredEvent): number {
    let low = 0;
    let high = this.createdOrder.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareStoredNewestFirst(this.createdOrder[mid]!, stored) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /** Exact index of a held event, or -1. Binary search plus a local walk. */
  private orderIndexOf(stored: StoredEvent): number {
    const start = this.orderInsertionIndex(stored);
    for (let i = start; i < this.createdOrder.length; i += 1) {
      const candidate = this.createdOrder[i]!;
      if (candidate.event.id === stored.event.id) return i;
      if (candidate.event.created_at !== stored.event.created_at) break;
    }
    return -1;
  }

  private replaceInOrder(previous: StoredEvent, next: StoredEvent): void {
    const index = this.orderIndexOf(previous);
    if (index >= 0) this.createdOrder[index] = next;
  }

  // --- read path --------------------------------------------------------

  private get stats(): IndexStats {
    return {
      totalEvents: this.byId.size,
      countForTagKey: (key) => this.byTag.get(key)?.size ?? 0,
      countForAuthor: (pubkey) => this.byAuthor.get(pubkey)?.size ?? 0,
      countForKind: (kind) => this.byKind.get(kind)?.size ?? 0,
    };
  }

  /**
   * Yields a superset of the matching events, read from the narrowest index the
   * planner could find. Never a full scan when the filter names ids, tags,
   * authors or kinds.
   */
  private *candidates(filter: Filter): Generator<StoredEvent> {
    const plan = chooseIndex(filter, this.stats);
    switch (plan.index) {
      case "ids": {
        for (const id of plan.ids) {
          const stored = this.byId.get(id);
          if (stored !== undefined) yield stored;
        }
        return;
      }
      case "tag": {
        yield* this.union(plan.tagKeys.map((key) => this.byTag.get(key)));
        return;
      }
      case "author": {
        yield* this.union(plan.authors.map((a) => this.byAuthor.get(a)));
        return;
      }
      case "kind": {
        yield* this.union(plan.kinds.map((k) => this.byKind.get(k)));
        return;
      }
      case "scan": {
        yield* this.createdOrder;
        return;
      }
    }
  }

  private *union(
    buckets: readonly (Set<Hex32> | undefined)[],
  ): Generator<StoredEvent> {
    if (buckets.length === 1) {
      const only = buckets[0];
      if (only === undefined) return;
      for (const id of only) {
        const stored = this.byId.get(id);
        if (stored !== undefined) yield stored;
      }
      return;
    }
    const seen = new Set<Hex32>();
    for (const bucket of buckets) {
      if (bucket === undefined) continue;
      for (const id of bucket) {
        if (seen.has(id)) continue;
        seen.add(id);
        const stored = this.byId.get(id);
        if (stored !== undefined) yield stored;
      }
    }
  }
}

function addTo<K>(map: Map<K, Set<Hex32>>, key: K, id: Hex32): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, new Set([id]));
  else existing.add(id);
}

function removeFrom<K>(map: Map<K, Set<Hex32>>, key: K, id: Hex32): void {
  const existing = map.get(key);
  if (existing === undefined) return;
  existing.delete(id);
  if (existing.size === 0) map.delete(key);
}
