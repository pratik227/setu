/**
 * An {@link EventStore} that switches to a second store the first time the first
 * one fails.
 *
 * This exists because persistence is optional but the app is not. IndexedDB is
 * absent in a Firefox private window, can be turned off by policy or by the user,
 * throws on access inside a sandboxed frame, and starts rejecting writes when the
 * origin's quota is reached. Every one of those arrives as a rejected promise
 * from a store method — on the ingest path, inside an observer evaluation, or
 * under a screen's first query — and none of them is a reason for the client to
 * show nothing. Degrading to memory turns "storage is unavailable" into "this
 * session will refetch after a reload", which is the behaviour the app had before
 * it persisted anything at all.
 *
 * Two things are deliberate:
 *
 *  - **The failed operation is retried on the fallback**, so the caller sees a
 *    normal result rather than an error it would have no way to recover from.
 *    Callers of `put` are ingest paths that would otherwise drop the event.
 *  - **Live observers are re-registered** against the new store, which fires each
 *    of them once with the fallback's (empty) contents. A view that was showing
 *    persisted rows is told they are gone rather than being left displaying rows
 *    that no query can return any more. Whatever the primary held is not copied
 *    across: it is unreadable, which is why we are here.
 *
 * A failure from the fallback itself is *not* caught. An in-memory store that
 * throws is a bug in this package, and hiding it would only move the symptom.
 */

import type { Filter, Hex32, NostrEvent, Timestamp } from "@setu/protocol";
import type { EventStore, StoredEvent, Unsubscribe } from "../contracts";
import type { EvictingEventStore, RetentionPolicy } from "./retention";

export interface FallbackEventStoreOptions {
  /**
   * Builds the preferred store. Called once, during construction, inside a
   * `try` — Dexie throws here, not later, when the environment has no IndexedDB
   * at all.
   */
  readonly createPrimary: () => EventStore;
  /** Builds the replacement. Called at most once, and only after a failure. */
  readonly createFallback: () => EventStore;
  /**
   * Called once with the error that ended persistence, so the host can surface
   * it. Silence here would mean a user whose events never survive a reload has
   * no way to find out why.
   */
  readonly onFallback?: (error: unknown) => void;
}

interface Watcher {
  readonly filter: Filter;
  readonly onChange: (events: readonly StoredEvent[]) => void;
  unsubscribe: Unsubscribe;
}

/** Closes a store if it has a `close` — not part of the `EventStore` contract. */
function closeQuietly(store: EventStore | undefined): void {
  const closable = store as { close?: () => void } | undefined;
  if (typeof closable?.close !== "function") return;
  try {
    closable.close();
  } catch {
    // Releasing a handle that is already broken is exactly the situation this
    // class exists for; throwing from teardown would turn it back into a crash.
  }
}

export class FallbackEventStore implements EventStore {
  private readonly options: FallbackEventStoreOptions;
  private primary: EventStore | undefined;
  private active: EventStore;
  private degraded = false;
  private readonly watchers = new Set<Watcher>();

  constructor(options: FallbackEventStoreOptions) {
    this.options = options;
    try {
      const primary = options.createPrimary();
      this.primary = primary;
      this.active = primary;
    } catch (error) {
      this.active = options.createFallback();
      this.degraded = true;
      options.onFallback?.(error);
    }
  }

  /** True once the primary has failed and nothing is being persisted. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  put(event: NostrEvent, relay?: string): Promise<boolean> {
    return this.run((store) => store.put(event, relay));
  }

  putAll(events: readonly NostrEvent[], relay?: string): Promise<number> {
    return this.run((store) => store.putAll(events, relay));
  }

  get(id: Hex32): Promise<StoredEvent | undefined> {
    return this.run((store) => store.get(id));
  }

  query(filter: Filter): Promise<readonly StoredEvent[]> {
    return this.run((store) => store.query(filter));
  }

  newestTimestamp(filter: Filter): Promise<Timestamp | undefined> {
    return this.run((store) => store.newestTimestamp(filter));
  }

  count(filter: Filter): Promise<number> {
    return this.run((store) => store.count(filter));
  }

  sweepExpired(): Promise<number> {
    return this.run((store) => store.sweepExpired());
  }

  nextExpirationAt(): Promise<Timestamp | undefined> {
    return this.run((store) => store.nextExpirationAt());
  }

  clear(): Promise<void> {
    return this.run((store) => store.clear());
  }

  /**
   * NIP-40 sweep plus retention eviction, forwarded only if the active store
   * implements it — the in-memory fallback has nothing to reclaim, since it dies
   * with the tab.
   */
  evictStale(policy: RetentionPolicy): Promise<number> {
    return this.run((store) => {
      const evicting = store as Partial<EvictingEventStore>;
      return evicting.evictStale?.(policy) ?? Promise.resolve(0);
    });
  }

  observe(
    filter: Filter,
    onChange: (events: readonly StoredEvent[]) => void,
  ): Unsubscribe {
    const watcher: Watcher = {
      filter,
      onChange,
      unsubscribe: this.active.observe(filter, onChange),
    };
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
      watcher.unsubscribe();
    };
  }

  /** Drops every observer and releases both stores' handles. */
  close(): void {
    for (const watcher of this.watchers) watcher.unsubscribe();
    this.watchers.clear();
    closeQuietly(this.primary);
    if (this.active !== this.primary) closeQuietly(this.active);
  }

  private async run<T>(work: (store: EventStore) => Promise<T>): Promise<T> {
    const attempted = this.active;
    try {
      return await work(attempted);
    } catch (error) {
      // Already on the fallback and it was the thing that threw: a real bug, and
      // swallowing it would hide it forever.
      if (this.degraded && attempted === this.active) throw error;
      if (!this.degraded) this.degrade(error);
      return work(this.active);
    }
  }

  private degrade(error: unknown): void {
    this.degraded = true;
    const fallback = this.options.createFallback();
    this.active = fallback;
    for (const watcher of this.watchers) {
      watcher.unsubscribe();
      watcher.unsubscribe = fallback.observe(watcher.filter, watcher.onChange);
    }
    closeQuietly(this.primary);
    this.primary = undefined;
    this.options.onFallback?.(error);
  }
}
