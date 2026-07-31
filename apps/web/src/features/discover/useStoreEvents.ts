import type { StoredEvent } from "@setu/core";
import type { Filter } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";

const EMPTY: readonly StoredEvent[] = [];

export interface StoreEventsOptions {
  /**
   * Also open a relay subscription for the filter.
   *
   * Off by default. The store is the event bus, so a panel rendered beside a
   * running feed sees that feed's events for free; asking the relays again would
   * spend a subscription slot on data already arriving. Screens that can be the
   * *only* thing on screen (Explore) do need to ask.
   */
  readonly subscribe?: boolean;
}

/**
 * Observe a filter against the local store.
 *
 * The whole hook is one `observe` call plus, optionally, one subscription. Two
 * details are load-bearing:
 *
 * 1. **The filter's identity is its content, not its object identity.** Callers
 *    pass inline literals, so keying the effect on the object would tear the
 *    observer down and rebuild it on every render — and with `subscribe` on,
 *    cancel the REQ before any relay answered.
 * 2. **A `limit` in the filter is not optional for high-volume kinds.** An
 *    unbounded live query over kind 1 across several relays grows until the tab
 *    dies. Callers pass a sample size; this hook does not invent one.
 */
export function useStoreEvents(
  filter: Filter,
  options: StoreEventsOptions = {},
): readonly StoredEvent[] {
  const engine = useEngine();
  const [events, setEvents] = useState<readonly StoredEvent[]>(EMPTY);
  const subscribe = options.subscribe ?? false;

  // Stable content key. `Object.keys().sort()` so key order in the literal
  // cannot change the identity of an otherwise identical filter.
  const key = useMemo(() => {
    const keys = Object.keys(filter).sort();
    return JSON.stringify(keys.map((k) => [k, filter[k as keyof Filter]]));
  }, [filter]);

  useEffect(() => {
    const parsed = Object.fromEntries(
      JSON.parse(key) as readonly [string, unknown][],
    ) as Filter;

    // The local observer may be unbounded; a relay query may not. Enforced here
    // because this is the one place a screen can turn a store read into network
    // traffic, and an unbounded live query over a high-volume kind across several
    // relays grows until the tab dies.
    if (import.meta.env.DEV && subscribe && parsed.limit === undefined) {
      throw new Error(
        `useStoreEvents({ subscribe: true }) needs a limit: ${JSON.stringify(parsed)}`,
      );
    }

    const unobserve = engine.store.observe(parsed, setEvents);
    const subscription = subscribe
      ? engine.subscriptions.subscribe({
          filters: engine.relays.map((relay) => ({ relay, filter: parsed })),
        })
      : undefined;

    return () => {
      unobserve();
      subscription?.close();
      setEvents(EMPTY);
    };
  }, [engine, key, subscribe]);

  return events;
}
