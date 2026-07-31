import { Kind } from "@setu/protocol";
import { useMemo } from "react";
import { type RankedTopic, rankTopics } from "./ranking";
import { useStoreEvents } from "./useStoreEvents";

export interface TrendingTopics {
  readonly topics: readonly RankedTopic[];
  /** Notes the ranking was computed over — the denominator, so it is shown. */
  readonly sampleSize: number;
  /** True while the sample is still empty and a subscription may be in flight. */
  readonly loading: boolean;
}

export interface TrendingTopicsOptions {
  /** Newest notes to rank over. */
  readonly sampleSize?: number;
  readonly limit?: number;
  readonly subscribe?: boolean;
  /**
   * Only rank notes from the last N seconds. Applied to the sample this device
   * already holds, so narrowing the window costs nothing and fetches nothing —
   * it just stops a burst from three days ago dominating what is presented as
   * recent.
   */
  readonly windowSeconds?: number;
  /** Current time in seconds. Injected so the hook stays deterministic in tests. */
  readonly now?: number;
}

/**
 * Topics ranked over the newest notes in the local store.
 *
 * This is "what the relays you read have been talking about lately", which is a
 * narrower and more honest claim than trending: the sample is whatever your relay
 * set happened to deliver, and callers must label it that way. `sampleSize` is
 * returned so the UI can state the denominator instead of implying a global one.
 */
export function useTrendingTopics(
  options: TrendingTopicsOptions = {},
): TrendingTopics {
  const sampleSize = options.sampleSize ?? 300;
  const limit = options.limit ?? 12;

  const filter = useMemo(
    () => ({ kinds: [Kind.ShortTextNote], limit: sampleSize }),
    [sampleSize],
  );
  const events = useStoreEvents(filter, {
    ...(options.subscribe !== undefined
      ? { subscribe: options.subscribe }
      : {}),
  });

  const windowSeconds = options.windowSeconds;
  const now = options.now;

  const sample = useMemo(() => {
    const all = events.map((stored) => stored.event);
    if (windowSeconds === undefined) return all;
    const floor = (now ?? Math.floor(Date.now() / 1000)) - windowSeconds;
    return all.filter((event) => event.created_at >= floor);
  }, [events, windowSeconds, now]);

  const topics = useMemo(() => rankTopics(sample, limit), [sample, limit]);

  // `sampleSize` is the windowed count, not the query's, because it is displayed
  // as the denominator: reporting 300 while ranking over 40 of them states a
  // measurement that was not taken.
  return { topics, sampleSize: sample.length, loading: events.length === 0 };
}
