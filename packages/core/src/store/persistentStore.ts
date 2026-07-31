/**
 * The composition an app uses to get persistence: IndexedDB when it works,
 * memory when it does not.
 *
 * Kept out of `engine.ts` on purpose. `createEngine` defaults to
 * {@link ./memoryStore.MemoryEventStore} and must keep doing so, because
 * `apps/cli` and every test run in Node where IndexedDB does not exist — a core
 * default of Dexie would break them all. Persistence is therefore a choice the
 * host makes, and this is the one function it needs to make it correctly:
 * account-scoped database name, the app's own protocol helpers, and a fallback
 * that keeps the client working when storage is unavailable.
 *
 * The protocol helpers are injected rather than imported here so this module
 * stays a store-layer module: `@setu/protocol`'s real matcher lives behind
 * `engine.protocolHelpers`, and passing it in is what guarantees the store and
 * the subscription manager agree about what a filter matches. A store that
 * matches filters differently from the ingest path is a store whose live queries
 * disagree with the events it was just handed.
 */

import type { Hex32 } from "@setu/protocol";
import { DexieEventStore, type DexieEventStoreOptions } from "./dexieStore";
import { FallbackEventStore } from "./fallbackStore";
import { type EventStoreOptions, MemoryEventStore } from "./memoryStore";

export interface PersistentStoreOptions extends DexieEventStoreOptions {
  /**
   * Account whose database to open. Required in practice: a store shared between
   * accounts is cross-account data leakage, which is the failure mode
   * `accountDatabaseName` exists to prevent.
   */
  readonly accountPubkey?: Hex32;
  /** Called once if persistence turns out to be unavailable. */
  readonly onFallback?: (error: unknown) => void;
}

/**
 * Opens the account's persistent store, falling back to memory.
 *
 * Construction is synchronous even though IndexedDB is not: Dexie opens lazily, so
 * the first read or write is what discovers a broken environment, and
 * {@link FallbackEventStore} is what turns that discovery into a degraded session
 * rather than an unhandled rejection under the first screen. Waiting on an open
 * before building the engine would trade that for a blank page on every load.
 */
export function createPersistentStore(
  options: PersistentStoreOptions = {},
): FallbackEventStore {
  // Only the shared options carry over: the fallback has no database name and no
  // IndexedDB environment to speak of.
  const shared: EventStoreOptions = {
    ...(options.matchesFilter ? { matchesFilter: options.matchesFilter } : {}),
    ...(options.isValidEventShape
      ? { isValidEventShape: options.isValidEventShape }
      : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  };
  return new FallbackEventStore({
    createPrimary: () => new DexieEventStore(options),
    createFallback: () => new MemoryEventStore(shared),
    ...(options.onFallback ? { onFallback: options.onFallback } : {}),
  });
}
