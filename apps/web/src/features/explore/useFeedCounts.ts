import type { FeedDefinition } from "@setu/core";
import type { Filter } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { feedFilter } from "./curatedFeeds";

/**
 * How many events the local store already holds for each feed.
 *
 * This is the number a feed card shows instead of a like or zap total. Those
 * would need an indexer that had counted reactions across the network; this is a
 * `count` over our own store, so it is both real and clearly ours. It also
 * happens to be the more useful number on this screen: it tells you whether
 * opening the feed will show you something immediately or start from empty.
 */
export function useFeedCounts(
  feeds: readonly {
    readonly id: string;
    readonly definition: FeedDefinition;
  }[],
  intervalMs = 5000,
): ReadonlyMap<string, number> {
  const engine = useEngine();
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());

  // The feed list is rebuilt on render by its owner, so key the effect on the
  // filters' content rather than the array's identity.
  const key = useMemo(
    () =>
      JSON.stringify(
        feeds.map((feed) => [feed.id, feedFilter(feed.definition)]),
      ),
    [feeds],
  );

  useEffect(() => {
    const entries = JSON.parse(key) as readonly [string, Filter][];
    let cancelled = false;

    const read = async (): Promise<void> => {
      const resolved = await Promise.all(
        entries.map(
          async ([id, filter]) =>
            [id, await engine.store.count(filter)] as const,
        ),
      );
      if (!cancelled) setCounts(new Map(resolved));
    };

    void read();
    const timer = setInterval(() => void read(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [engine, key, intervalMs]);

  return counts;
}
