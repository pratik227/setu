/**
 * One relay subscription per logical concern, however many surfaces want it.
 *
 * `SubscriptionManager` does not deduplicate REQs, and nothing above it knows
 * what else is mounted. So a hook that opens its own subscription opens one *per
 * mount*: the notification badge and the notifications screen are the same query
 * twice; `useBookmarks` is called from `useNoteRowActions`, which mounts once per
 * surface, so a feed beside a thread panel asks two relays' worth of slots for one
 * replaceable list. Relays cap concurrent subscriptions in the low tens, and a
 * relay that hits its cap stops answering rather than complaining — which reads to
 * a user as "the network is empty".
 *
 * Ref-counting rather than "one designated owner": the store is the event bus, so
 * whoever holds the REQ is an implementation detail, and making one component's
 * mount order load-bearing for another's data is how a screen ends up empty when
 * it is opened directly.
 */

import type { Engine } from "@setu/core";
import type { Filter } from "@setu/protocol";
import { useEffect, useMemo } from "react";
import { useEngine } from "./EngineProvider";

interface SharedEntry {
  readonly close: () => void;
  refs: number;
}

/**
 * Keyed by engine so a relay-set or account change starts from nothing: the old
 * engine's entries become garbage with it rather than leaking a closed handle.
 */
const registry = new WeakMap<Engine, Map<string, SharedEntry>>();

/** Content identity of a filter, independent of key order in the literal. */
export function filterContentKey(filter: Filter): string {
  const keys = Object.keys(filter).sort();
  return JSON.stringify(keys.map((k) => [k, filter[k as keyof Filter]]));
}

/** Content identity of a list of filters. */
export function filtersContentKey(filters: readonly Filter[]): string {
  return filters.map(filterContentKey).join("|");
}

/**
 * Hold a share of one relay subscription for `filters`, under `key`.
 *
 * `key` is the subscription's identity: two callers passing the same key share
 * one REQ, and the filters of the first caller win. Pass a content-derived key
 * (see {@link filtersContentKey}) unless the caller genuinely owns a named
 * concern whose filter changes over time — the interactions tracker does, and
 * keying it by content would leave the old REQ open beside the new one.
 *
 * Returns the release function. Idempotent: releasing twice does not decrement
 * twice, because React may run a cleanup once but a caller storing the disposer
 * cannot otherwise be trusted with the count.
 */
export function acquireSharedSubscription(
  engine: Engine,
  key: string,
  filters: readonly Filter[],
): () => void {
  let byKey = registry.get(engine);
  if (!byKey) {
    byKey = new Map();
    registry.set(engine, byKey);
  }

  // A missing `limit` is not a smaller request, it is an unbounded one — see
  // `queryLimits.ts`. Loud in development because the symptom in production is a
  // slow tab and a relay that stopped answering, neither of which points here.
  if (import.meta.env.DEV) {
    for (const filter of filters) {
      if (filter.limit === undefined) {
        throw new Error(
          `Relay filter without a limit under "${key}": ${JSON.stringify(filter)}`,
        );
      }
    }
  }

  const existing = byKey.get(key);
  if (existing) {
    existing.refs += 1;
  } else {
    const subscription = engine.subscriptions.subscribe({
      filters: engine.relays.flatMap((relay) =>
        filters.map((filter) => ({ relay, filter })),
      ),
    });
    byKey.set(key, { close: () => subscription.close(), refs: 1 });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = registry.get(engine)?.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    registry.get(engine)?.delete(key);
    entry.close();
  };
}

/**
 * Hold a share of one relay subscription for `filter`, for as long as the calling
 * component is mounted. Pass `undefined` to hold nothing — used when there is no
 * signed-in account, so the hook order stays constant.
 *
 * Events land in the store as always; read them back with `useStoreEvents`,
 * `useSharedStoreQuery` or `store.observe`. This hook returns nothing on purpose:
 * it is a lease, not a data source, and a second read path would be a second
 * source of truth.
 */
export function useSharedSubscription(filter: Filter | undefined): void {
  const engine = useEngine();

  // The filter's identity is its content: callers pass inline literals, and
  // keying the effect on object identity would close and reopen the REQ on every
  // render — cancelling it before any relay answered.
  const key = useMemo(() => (filter ? filterContentKey(filter) : ""), [filter]);

  useEffect(() => {
    if (!key) return;
    const parsed = Object.fromEntries(
      JSON.parse(key) as readonly [string, unknown][],
    ) as Filter;
    return acquireSharedSubscription(engine, key, [parsed]);
  }, [engine, key]);
}
