/**
 * Persistent {@link EventStore} backed by Dexie/IndexedDB.
 *
 * Semantically identical to {@link ../store/memoryStore.MemoryEventStore} — the
 * dedup/LWW/tombstone/expiry/protection/observer rules come from the same shared
 * modules, and the conformance suite runs against both. What differs is only where
 * the bytes live and that writes are genuinely async, which is why every write
 * goes through a serialising queue: two concurrent `put`s of competing
 * replaceable versions must not interleave their read-compare-write.
 *
 * The database name is derived from the account pubkey (`setu-<prefix>`) so two
 * accounts can never share a store. Cross-account data leakage through a shared
 * cache is one of the failure modes this package exists to avoid.
 */

import type { Filter, Hex32, NostrEvent, Timestamp } from "@setu/protocol";
import Dexie, { type Table } from "dexie";
import type { EventStore, StoredEvent, Unsubscribe } from "../contracts";
import type {
  IsValidEventShapeFn,
  MatchesFilterFn,
} from "../internal/filterMatch";
import {
  isValidEventShape as defaultIsValidEventShape,
  matchesFilter as defaultMatchesFilter,
} from "../internal/filterMatch";
import { expirationOf, isExpiredAt } from "./expiration";
import { addressOf, isEphemeralKind, KIND_DELETION } from "./kinds";
import type { EventStoreOptions } from "./memoryStore";
import type { MuteRules } from "./muteFilter";
import type { MuteAwareEventStore } from "./muteIngest";
import { MuteIngestPolicy } from "./muteIngest";
import { ObserverRegistry } from "./observers";
import { chooseIndex, sortAndLimit } from "./queryPlan";
import {
  initialProvenance,
  mergeProvenance,
  shouldReplace,
} from "./replaceable";
import type { EvictingEventStore, RetentionPolicy } from "./retention";
import { isEvictable } from "./retention";
import type { EventRow } from "./rows";
import { rowToEvent, rowToStored, toRow } from "./rows";
import type { TombstoneRecord } from "./tombstones";
import { TombstoneIndex } from "./tombstones";

/** Minimal shape of the IndexedDB globals, for injecting `fake-indexeddb`. */
export interface IndexedDbEnvironment {
  readonly indexedDB: unknown;
  readonly IDBKeyRange: unknown;
}

/** Construction options for {@link DexieEventStore}. */
export interface DexieEventStoreOptions extends EventStoreOptions {
  /**
   * Account this store belongs to. The database name becomes
   * `setu-<first 12 hex chars>`; pass `databaseName` to override entirely.
   */
  readonly accountPubkey?: Hex32;
  /** Explicit database name, bypassing the account-derived one. */
  readonly databaseName?: string;
  /** Inject `fake-indexeddb` (or any shim) instead of the ambient globals. */
  readonly environment?: IndexedDbEnvironment;
}

/** Builds the per-account database name. */
export function accountDatabaseName(accountPubkey?: Hex32): string {
  if (accountPubkey === undefined || accountPubkey === "") return "setu-anon";
  return `setu-${accountPubkey.slice(0, 12)}`;
}

/** The Dexie schema. Bump the version and add an upgrade path to change it. */
class SetuDatabase extends Dexie {
  declare events: Table<EventRow, string>;
  declare tombstones: Table<TombstoneRecord, string>;

  constructor(name: string, environment?: IndexedDbEnvironment) {
    super(
      name,
      environment
        ? {
            indexedDB: environment.indexedDB as never,
            IDBKeyRange: environment.IDBKeyRange as never,
          }
        : undefined,
    );
    this.version(1).stores({
      events: "id, kind, pubkey, created_at, addressKey, *tagKeys",
      tombstones: "key",
    });
    // v2 adds the NIP-40 `expiresAt` index. The upgrade backfills it from each
    // row's own tags rather than leaving pre-v2 rows unindexed, because an
    // unindexed row is one the expiry sweep would never find — it would read as
    // "this note ignores its own expiration tag" for the lifetime of the profile.
    this.version(2)
      .stores({
        events: "id, kind, pubkey, created_at, addressKey, expiresAt, *tagKeys",
        tombstones: "key",
      })
      .upgrade((tx) =>
        tx
          .table<EventRow>("events")
          .toCollection()
          .modify((row) => {
            const expiresAt = expirationOf(rowToEvent(row));
            if (expiresAt !== undefined) row.expiresAt = expiresAt;
          }),
      );
  }
}

/** IndexedDB-backed event store. */
export class DexieEventStore
  implements EventStore, EvictingEventStore, MuteAwareEventStore
{
  private readonly db: SetuDatabase;
  private readonly tombstones = new TombstoneIndex();
  /** The reader's mute rules, enforced on the write path. See `muteIngest.ts`. */
  private readonly mutes = new MuteIngestPolicy();
  private readonly observers: ObserverRegistry;
  private readonly matches: MatchesFilterFn;
  private readonly isValidShape: IsValidEventShapeFn;
  private readonly now: () => Timestamp;
  private readonly hydrated: Promise<void>;
  /** Serialises writes so read-compare-write sequences cannot interleave. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  /**
   * Soonest NIP-40 deadline held, mirrored in memory so a sweep that has nothing
   * to do costs no IndexedDB round trip — otherwise every `put` would pay for one.
   *
   * Only ever *conservative*: deleting a row can push the true earliest deadline
   * later but never earlier, so a stale value at worst causes one empty range
   * query, never a missed expiry.
   */
  private nextExpiry: Timestamp | undefined;

  constructor(options: DexieEventStoreOptions = {}) {
    this.matches = options.matchesFilter ?? defaultMatchesFilter;
    this.isValidShape = options.isValidEventShape ?? defaultIsValidEventShape;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.db = new SetuDatabase(
      options.databaseName ?? accountDatabaseName(options.accountPubkey),
      options.environment,
    );
    this.observers = new ObserverRegistry({
      evaluate: (filter) => this.query(filter),
      matchesFilter: this.matches,
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    });
    // Tombstones are mirrored in memory so the insert-blocking check stays
    // synchronous inside the write queue; the earliest deadline is read once for
    // the same reason.
    this.hydrated = this.db.tombstones
      .toArray()
      .then((records) => this.tombstones.load(records))
      .then(() => this.db.events.orderBy("expiresAt").first())
      .then((row) => {
        this.nextExpiry = row?.expiresAt;
      });
  }

  /** The IndexedDB database name in use. */
  get databaseName(): string {
    return this.db.name;
  }

  setMuteRules(rules: MuteRules, viewerPubkey?: Hex32 | undefined): void {
    this.mutes.update(rules, viewerPubkey);
  }

  async put(event: NostrEvent, relay?: string): Promise<boolean> {
    return this.observers.runBatch(async () => {
      const result = await this.enqueue(async () => {
        // Sweeping inside the same queued unit as the write costs no extra round
        // trip through the queue, and keeps expiry driven by ordinary traffic.
        const now = this.now();
        const expired = await this.sweepInternal(now);
        const one = await this.putInternal(event, relay, now);
        return {
          accepted: one.accepted,
          touched: [...expired, ...one.touched],
        };
      });
      this.observers.notify(result.touched);
      return result.accepted;
    });
  }

  async putAll(events: readonly NostrEvent[], relay?: string): Promise<number> {
    return this.observers.runBatch(async () => {
      const result = await this.enqueue(async () => {
        // One clock reading for the batch, as in the memory store.
        const now = this.now();
        let accepted = 0;
        const touched: NostrEvent[] = [...(await this.sweepInternal(now))];
        for (const event of events) {
          const one = await this.putInternal(event, relay, now);
          if (one.accepted) accepted += 1;
          touched.push(...one.touched);
        }
        return { accepted, touched };
      });
      this.observers.notify(result.touched);
      return result.accepted;
    });
  }

  async get(id: Hex32): Promise<StoredEvent | undefined> {
    await this.hydrated;
    const row = await this.db.events.get(id);
    if (row === undefined) return undefined;
    const stored = rowToStored(row);
    // Expired but not yet swept: hidden from reads immediately, as in the memory
    // store, so neither implementation depends on sweep timing for correctness.
    return isExpiredAt(stored.event, this.now()) ? undefined : stored;
  }

  async query(filter: Filter): Promise<readonly StoredEvent[]> {
    const rows = await this.candidates(filter);
    const now = this.now();
    const matched: StoredEvent[] = [];
    for (const row of rows) {
      const stored = rowToStored(row);
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
    const rows = await this.candidates(filter);
    const now = this.now();
    let newest: Timestamp | undefined;
    for (const row of rows) {
      const event = rowToEvent(row);
      // An expired event must not drag the watermark forward.
      if (isExpiredAt(event, now)) continue;
      if (!this.matches(event, filter)) continue;
      if (newest === undefined || row.created_at > newest) {
        newest = row.created_at;
      }
    }
    return newest;
  }

  async count(filter: Filter): Promise<number> {
    // As in the memory store, `limit` is ignored here by design.
    const rows = await this.candidates(filter);
    const now = this.now();
    let total = 0;
    for (const row of rows) {
      const event = rowToEvent(row);
      if (isExpiredAt(event, now)) continue;
      if (this.matches(event, filter)) total += 1;
    }
    return total;
  }

  async sweepExpired(): Promise<number> {
    return this.observers.runBatch(async () => {
      const removed = await this.enqueue(() => this.sweepInternal(this.now()));
      this.observers.notify(removed);
      return removed.length;
    });
  }

  /**
   * Deletes old, re-fetchable rows under `policy`, returning how many went.
   *
   * The bounded read is the point: candidates come from the `created_at` index
   * below the cutoff and are capped at `policy.maxPerSweep`, so a store holding a
   * year of history does not load a year of history into memory to prune a day of
   * it. Sweeps repeat, so a backlog drains across several of them.
   *
   * `created_at` is only the *candidate* filter — {@link isEvictable} makes the
   * decision, and it also requires that we have held the row for the full horizon.
   * An event authored three years ago can have arrived a minute ago and be on
   * screen right now.
   */
  async evictStale(policy: RetentionPolicy): Promise<number> {
    return this.observers.runBatch(async () => {
      const evicted = await this.enqueue(async () => {
        const cutoff = this.now() - policy.maxAgeSeconds;
        const rows = await this.db.events
          .where("created_at")
          .below(cutoff)
          .limit(policy.maxPerSweep)
          .toArray();
        const doomed = rows.filter((row) =>
          isEvictable(rowToStored(row), cutoff, policy),
        );
        if (doomed.length > 0) {
          await this.db.events.bulkDelete(doomed.map((row) => row.id));
        }
        return doomed.map(rowToEvent);
      });
      // Observers are woken with the deleted events, so a view showing one is
      // told it is gone instead of rendering a row no read can return.
      this.observers.notify(evicted);
      return evicted.length;
    });
  }

  async nextExpirationAt(): Promise<Timestamp | undefined> {
    await this.hydrated;
    // Read the index rather than the mirror: the mirror is deliberately allowed
    // to be conservatively early, and a host scheduling a wake-up wants the exact
    // answer the memory store also gives.
    const row = await this.db.events.orderBy("expiresAt").first();
    return row?.expiresAt;
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      await this.db.events.clear();
      await this.db.tombstones.clear();
      this.tombstones.clear();
      this.nextExpiry = undefined;
    });
    this.observers.notifyAll();
  }

  /** Closes observers and the underlying database handle. */
  close(): void {
    this.observers.close();
    this.db.close();
  }

  /** Resolves once all pending observer callbacks have fired. Tests only. */
  async settle(): Promise<void> {
    await this.observers.settle();
  }

  /** Deletes the whole database. Used when signing an account out for good. */
  async destroy(): Promise<void> {
    this.observers.close();
    await this.db.delete();
  }

  // --- write path -------------------------------------------------------

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => this.hydrated).then(work);
    // Keep the chain alive even if this unit of work rejects.
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Deletes every row whose deadline has arrived, returning the events so the
   * caller can wake the observers that were showing them.
   *
   * Must run inside {@link enqueue} — it is a write.
   */
  private async sweepInternal(now: Timestamp): Promise<readonly NostrEvent[]> {
    if (this.nextExpiry === undefined || this.nextExpiry > now) return [];
    const rows = await this.db.events
      .where("expiresAt")
      .belowOrEqual(now)
      .toArray();
    if (rows.length > 0) {
      await this.db.events.bulkDelete(rows.map((row) => row.id));
    }
    const next = await this.db.events.orderBy("expiresAt").first();
    this.nextExpiry = next?.expiresAt;
    return rows.map(rowToEvent);
  }

  private async putInternal(
    event: NostrEvent,
    relay: string | undefined,
    now: Timestamp,
  ): Promise<{ accepted: boolean; touched: readonly NostrEvent[] }> {
    if (!this.isValidShape(event)) return { accepted: false, touched: [] };
    if (isEphemeralKind(event.kind)) return { accepted: false, touched: [] };
    // NIP-40: never let an already-expired event into storage.
    if (isExpiredAt(event, now)) return { accepted: false, touched: [] };

    const touched: NostrEvent[] = [];

    if (event.kind === KIND_DELETION) {
      const targets = this.tombstones.ingest(event);
      const records: TombstoneRecord[] = [
        ...targets.idKeys,
        ...targets.addressKeys,
      ].map((key) => ({ key, createdAt: targets.createdAt }));
      if (records.length > 0) await this.db.tombstones.bulkPut(records);
      for (const id of targets.ids) {
        const row = await this.db.events.get(id);
        if (row === undefined || row.pubkey !== event.pubkey) continue;
        await this.db.events.delete(id);
        touched.push(rowToEvent(row));
      }
      for (const address of targets.addresses) {
        const row = await this.rowByAddress(address);
        if (row === undefined) continue;
        if (row.created_at > targets.createdAt) continue;
        await this.db.events.delete(row.id);
        touched.push(rowToEvent(row));
      }
    }

    if (this.tombstones.blocks(event)) return { accepted: false, touched };
    // Synchronous, and deliberately so: this runs inside the write queue, and an
    // await here would open a window for a rule change to land mid-decision.
    if (this.mutes.blocks(event)) return { accepted: false, touched };

    const existing = await this.db.events.get(event.id);
    if (existing !== undefined) {
      const merged = mergeProvenance(
        { relays: existing.relays, firstSeen: existing.firstSeen },
        relay,
      );
      if (merged.relays.length !== existing.relays.length) {
        await this.db.events.update(event.id, { relays: [...merged.relays] });
      }
      return { accepted: false, touched };
    }

    const address = addressOf(event);
    if (address !== undefined) {
      const current = await this.rowByAddress(address);
      if (current !== undefined) {
        if (!shouldReplace(event, rowToEvent(current))) {
          return { accepted: false, touched };
        }
        await this.db.events.delete(current.id);
        touched.push(rowToEvent(current));
      }
    }

    const provenance = initialProvenance(relay, now);
    const row = toRow(event, provenance.relays, provenance.firstSeen);
    await this.db.events.put(row);
    if (
      row.expiresAt !== undefined &&
      (this.nextExpiry === undefined || row.expiresAt < this.nextExpiry)
    ) {
      this.nextExpiry = row.expiresAt;
    }
    touched.push(event);
    return { accepted: true, touched };
  }

  private async rowByAddress(address: string): Promise<EventRow | undefined> {
    const rows = await this.db.events
      .where("addressKey")
      .equals(address)
      .toArray();
    if (rows.length <= 1) return rows[0];
    // Defensive: if a crash ever left two versions behind, keep LWW honest.
    return rows.reduce((best, row) =>
      shouldReplace(rowToEvent(row), rowToEvent(best)) ? row : best,
    );
  }

  // --- read path --------------------------------------------------------

  /**
   * Reads a superset of the matching rows from the narrowest usable index.
   *
   * No {@link IndexStats} are supplied: obtaining real cardinalities would mean
   * an extra round of async index counts per query, which costs more than the
   * static `ids > tag > author > kind` ranking saves. The memory store, where
   * counts are free, does use statistics.
   */
  private async candidates(filter: Filter): Promise<readonly EventRow[]> {
    await this.hydrated;
    const plan = chooseIndex(filter);
    switch (plan.index) {
      case "ids":
        return this.db.events
          .where("id")
          .anyOf([...plan.ids])
          .toArray();
      case "tag":
        return this.db.events
          .where("tagKeys")
          .anyOf([...plan.tagKeys])
          .distinct()
          .toArray();
      case "author":
        return this.db.events
          .where("pubkey")
          .anyOf([...plan.authors])
          .toArray();
      case "kind":
        return this.db.events
          .where("kind")
          .anyOf([...plan.kinds])
          .toArray();
      case "scan":
        return this.db.events.orderBy("created_at").reverse().toArray();
    }
  }
}
