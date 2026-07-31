/**
 * One relay subscription *and* one store observer per logical concern.
 *
 * `useSharedSubscription` deduplicates the REQ; this deduplicates the read half
 * too. For the account's own replaceable lists — the follow list, the bookmark
 * list — every mounted surface wants the same three things: the same filter, the
 * same observer, and the same projection of the newest event. Running the
 * projection once per mount is not a correctness problem, but running the
 * *observer* once per mount is: each one is another callback the store fans out to
 * on every write, and each one holds its own copy of the answer, which is how two
 * surfaces come to disagree about whether a note is bookmarked.
 *
 * The projection must be a pure function of the observed rows. It is captured from
 * the first caller under a given key, so two callers passing different projections
 * for one key is a bug the key is supposed to prevent — scope the key to the
 * concern *and* the account (`follows:<pubkey>`), never to the caller.
 */

import type { Engine, StoredEvent } from "@setu/core";
import type { Filter } from "@setu/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "./EngineProvider";
import {
  acquireSharedSubscription,
  filterContentKey,
} from "./sharedSubscription";

interface SharedQueryEntry {
  refs: number;
  /** Latest projection. `unknown` here; the hook restores the caller's type. */
  value: unknown;
  readonly listeners: Set<() => void>;
  readonly dispose: () => void;
}

/** Keyed by engine, so an account or relay-set change starts from nothing. */
const registry = new WeakMap<Engine, Map<string, SharedQueryEntry>>();

function acquire<T>(
  engine: Engine,
  key: string,
  filter: Filter,
  project: (events: readonly StoredEvent[]) => T,
  initial: T,
): SharedQueryEntry {
  let byKey = registry.get(engine);
  if (!byKey) {
    byKey = new Map();
    registry.set(engine, byKey);
  }

  const existing = byKey.get(key);
  if (existing) {
    existing.refs += 1;
    return existing;
  }

  // The REQ shares the same key, so the network and store halves of one concern
  // are acquired and released together.
  const releaseSubscription = acquireSharedSubscription(engine, key, [filter]);
  const entry: SharedQueryEntry = {
    refs: 1,
    value: initial,
    listeners: new Set(),
    dispose: () => {
      unobserve();
      releaseSubscription();
    },
  };
  const unobserve = engine.store.observe(filter, (events) => {
    entry.value = project(events);
    for (const listener of entry.listeners) listener();
  });
  byKey.set(key, entry);
  return entry;
}

function release(engine: Engine, key: string): void {
  const entry = registry.get(engine)?.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  registry.get(engine)?.delete(key);
  entry.dispose();
}

export interface SharedStoreQuery<T> {
  /**
   * Identity of the concern, including whatever scopes it — an account pubkey,
   * usually. Two callers with the same key share one subscription and one
   * observer; the empty string means "nothing to do".
   */
  readonly key: string;
  /** Undefined holds nothing, so hook order stays constant when signed out. */
  readonly filter: Filter | undefined;
  /** Pure projection of the observed rows. Captured from the first caller. */
  readonly project: (events: readonly StoredEvent[]) => T;
  /** Value before the first observer callback. */
  readonly initial: T;
}

/**
 * Read one shared concern from the store, backed by one shared REQ.
 *
 * Returns `initial` until the first store callback, then the projection. The
 * returned value keeps the identity the projection gave it, so a consumer can
 * memoize on it.
 */
export function useSharedStoreQuery<T>(query: SharedStoreQuery<T>): T {
  const engine = useEngine();
  const { key, filter } = query;
  const [value, setValue] = useState<T>(query.initial);

  // Read through refs: callers pass inline literals for both, and keying the
  // effect on their identity would tear the observer down every render.
  const projectRef = useRef(query.project);
  projectRef.current = query.project;
  const initialRef = useRef(query.initial);
  initialRef.current = query.initial;

  // Content identity, for the same reason: `{ kinds: [3], authors: [me] }`
  // written inline is a new object on every render but the same query.
  const filterKey = useMemo(
    () => (filter ? filterContentKey(filter) : ""),
    [filter],
  );

  useEffect(() => {
    if (key === "" || filterKey === "") {
      setValue(initialRef.current);
      return;
    }
    const parsed = Object.fromEntries(
      JSON.parse(filterKey) as readonly [string, unknown][],
    ) as Filter;

    const entry = acquire(
      engine,
      key,
      parsed,
      projectRef.current,
      initialRef.current,
    );
    setValue(entry.value as T);
    const listener = () => setValue(entry.value as T);
    entry.listeners.add(listener);

    return () => {
      entry.listeners.delete(listener);
      release(engine, key);
    };
  }, [engine, key, filterKey]);

  return value;
}
