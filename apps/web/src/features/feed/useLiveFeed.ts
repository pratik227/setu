import { type FeedDefinition, FeedEngine, type FeedSnapshot } from "@setu/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";

const EMPTY_SNAPSHOT: FeedSnapshot = {
  entries: [],
  pendingCount: 0,
  loading: true,
  exhausted: false,
  paused: false,
};

export interface LiveFeed {
  readonly snapshot: FeedSnapshot;
  /** Hold newer rows back while the reader is away from the top. */
  pause(): void;
  resume(): void;
  /** Insert staged rows at the top. */
  flush(): void;
  loadMore(): void;
}

/**
 * Drives a `FeedEngine` from React.
 *
 * The engine owns ordering, repost coalescing, the staging buffer and `until`
 * pagination; this hook only relays snapshots into render state. Keeping that
 * split means the feed's behavior is testable without React — and it is, in
 * `packages/core`.
 */
export function useLiveFeed(
  definition: FeedDefinition,
  /**
   * Cap on rows held live. Required for an unauthenticated global feed: kind-1
   * traffic across several relays is thousands per minute, and an uncapped live
   * query grows until the tab dies.
   */
  observeLimit = 80,
): LiveFeed {
  const engine = useEngine();
  const [snapshot, setSnapshot] = useState<FeedSnapshot>(EMPTY_SNAPSHOT);
  const feedRef = useRef<FeedEngine | null>(null);

  // The effect must not depend on the definition object — callers pass an inline
  // literal, so a new identity every render would rebuild the feed every render.
  // `definitionKey` is its real identity; the object itself is read from a ref.
  const definitionRef = useRef(definition);
  definitionRef.current = definition;

  // Serialize the definition so an inline object literal at the call site does
  // not tear down and rebuild the feed on every render.
  const definitionKey = useMemo(
    () =>
      JSON.stringify([
        [...definition.kinds].sort(),
        definition.authors ? [...definition.authors].sort() : null,
        definition.hashtags ? [...definition.hashtags].sort() : null,
        [...definition.relays].sort(),
      ]),
    [definition],
  );

  useEffect(() => {
    const feed = new FeedEngine({
      store: engine.store,
      subscriptions: engine.subscriptions,
      definition: definitionRef.current,
      router: engine.outbox,
      observeLimit,
    });
    feedRef.current = feed;

    const unsubscribe = feed.subscribe(setSnapshot);
    void feed.start().then(() => setSnapshot(feed.snapshot()));

    return () => {
      unsubscribe();
      feed.close();
      feedRef.current = null;
      setSnapshot(EMPTY_SNAPSHOT);
    };
  }, [engine, definitionKey, observeLimit]);

  const pause = useCallback(() => feedRef.current?.pause(), []);
  const resume = useCallback(() => feedRef.current?.resume(), []);
  const flush = useCallback(() => feedRef.current?.flush(), []);
  const loadMore = useCallback(() => {
    void feedRef.current?.loadMore();
  }, []);

  return { snapshot, pause, resume, flush, loadMore };
}
