/**
 * Feed behaviour: staging, `until` pagination, repost coalescing.
 *
 * These three are the concrete things a Nostr feed gets wrong. The tests are
 * written against observable feed state rather than internals, so the engine can
 * be rewritten underneath them.
 */

import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { microtaskScheduler } from "../internal/scheduler";
import { MemoryEventStore } from "../store/memoryStore";
import { FakeSubscriptions } from "../testing/fakes";
import { hex, makeEvent, PUBKEYS } from "../testing/fixtures";
import { FeedEngine } from "./feedEngine";
import type { FeedDefinition } from "./feedTypes";

const RELAY = "wss://feed.relay";

const DEFINITION: FeedDefinition = { kinds: [1], relays: [RELAY] };

function note(createdAt: number, seed = `n-${createdAt}`): NostrEvent {
  return makeEvent({ id: hex(seed), kind: 1, created_at: createdAt });
}

function harness(
  definition: FeedDefinition = DEFINITION,
  options: { pageSize?: number; repostWindowSeconds?: number } = {},
) {
  const store = new MemoryEventStore({ scheduler: microtaskScheduler });
  const subscriptions = new FakeSubscriptions(store);
  const engine = new FeedEngine({
    store,
    subscriptions,
    definition,
    pageSize: options.pageSize ?? 10,
    ...(options.repostWindowSeconds !== undefined
      ? { repostWindowSeconds: options.repostWindowSeconds }
      : {}),
  });
  return { store, subscriptions, engine };
}

describe("FeedEngine staging buffer", () => {
  it("holds newer rows while paused and flushes them in order", async () => {
    const { store, engine } = harness();
    await store.putAll([note(1_000), note(1_001)]);
    await engine.start();
    await store.settle();

    expect(engine.snapshot().entries.map((e) => e.createdAt)).toEqual([
      1_001, 1_000,
    ]);

    engine.pause();
    await store.putAll([note(1_002), note(1_003)]);
    await store.settle();

    // The visible list must not move under the reader.
    expect(engine.snapshot().entries.map((e) => e.createdAt)).toEqual([
      1_001, 1_000,
    ]);
    expect(engine.pendingCount).toBe(2);
    expect(engine.snapshot().pendingCount).toBe(2);

    engine.flush();
    expect(engine.snapshot().entries.map((e) => e.createdAt)).toEqual([
      1_003, 1_002, 1_001, 1_000,
    ]);
    expect(engine.pendingCount).toBe(0);
    engine.close();
  });

  it("inserts directly when not paused, and resume() flushes", async () => {
    const { store, engine } = harness();
    await engine.start();
    await store.put(note(2_000));
    await store.settle();
    expect(engine.snapshot().entries).toHaveLength(1);

    engine.pause();
    await store.put(note(2_001));
    await store.settle();
    expect(engine.pendingCount).toBe(1);

    engine.resume();
    expect(engine.paused).toBe(false);
    expect(engine.pendingCount).toBe(0);
    expect(engine.snapshot().entries).toHaveLength(2);
    engine.close();
  });

  it("does not stage rows older than the pause watermark", async () => {
    const { store, engine } = harness();
    await store.put(note(5_000));
    await engine.start();
    await store.settle();

    engine.pause();
    // An older event backfilling in belongs in place, not in the "new" badge.
    await store.put(note(4_000));
    await store.settle();
    expect(engine.pendingCount).toBe(0);
    expect(engine.snapshot().entries).toHaveLength(2);
    engine.close();
  });

  it("notifies subscribers and hands out frozen snapshots", async () => {
    const { store, engine } = harness();
    const seen: number[] = [];
    engine.subscribe((snapshot) => seen.push(snapshot.entries.length));
    await engine.start();
    await store.put(note(1_000));
    await store.settle();

    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    expect(Object.isFrozen(engine.snapshot().entries)).toBe(true);
    engine.close();
  });

  it("removes a row when its event leaves the store", async () => {
    const { store, engine } = harness();
    const doomed = makeEvent({
      id: hex("feed-doomed"),
      kind: 1,
      pubkey: PUBKEYS.alice,
      created_at: 1_000,
    });
    await store.put(doomed);
    await engine.start();
    await store.settle();
    expect(engine.snapshot().entries).toHaveLength(1);

    await store.put(
      makeEvent({
        id: hex("feed-del"),
        kind: 5,
        pubkey: PUBKEYS.alice,
        created_at: 1_100,
        tags: [["e", doomed.id]],
      }),
    );
    await store.settle();
    expect(engine.snapshot().entries).toHaveLength(0);
    engine.close();
  });
});

describe("FeedEngine until-based pagination", () => {
  it("windows strictly backwards and never duplicates a row", async () => {
    const { store, subscriptions, engine } = harness(DEFINITION, {
      pageSize: 3,
    });
    const all = Array.from({ length: 10 }, (_, i) => note(1_000 + i));
    subscriptions.network = [...all];
    // Only the three newest are held locally at first.
    await store.putAll(all.slice(-3));

    await engine.start();
    await store.settle();
    expect(engine.snapshot().entries).toHaveLength(3);

    const firstAdded = await engine.loadMore();
    const secondAdded = await engine.loadMore();
    expect(firstAdded).toBeGreaterThan(0);
    expect(secondAdded).toBeGreaterThan(0);

    const untils = subscriptions.fetches.map(
      (request) => request.filters[0]?.filter.until,
    );
    expect(untils).toHaveLength(2);
    expect(untils[0]).toBe(1_007);
    // Each window is strictly older than the last.
    expect(untils[1]!).toBeLessThan(untils[0]!);

    const keys = engine.snapshot().entries.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    const timestamps = engine.snapshot().entries.map((e) => e.createdAt);
    expect([...timestamps]).toEqual([...timestamps].sort((a, b) => b - a));
    engine.close();
  });

  it("satisfies a page from local data without touching the network", async () => {
    const { store, subscriptions, engine } = harness(DEFINITION, {
      pageSize: 2,
    });
    await store.putAll([note(1_000), note(1_001), note(1_002), note(1_003)]);
    await engine.start();
    await store.settle();
    // start() loaded everything the store had, so the next window is empty
    // locally and the fetch is the only way to learn more.
    const added = await engine.loadMore();
    expect(added).toBe(0);
    expect(engine.snapshot().exhausted).toBe(true);
    // A fetch was attempted (correctly), but a second loadMore is a no-op.
    const before = subscriptions.fetches.length;
    expect(await engine.loadMore()).toBe(0);
    expect(subscriptions.fetches).toHaveLength(before);
    engine.close();
  });

  it("marks the feed exhausted when a window yields nothing", async () => {
    const { store, engine } = harness();
    await store.put(note(1_000));
    await engine.start();
    await store.settle();
    expect(engine.snapshot().exhausted).toBe(false);
    expect(await engine.loadMore()).toBe(0);
    expect(engine.snapshot().exhausted).toBe(true);
    engine.close();
  });
});

describe("FeedEngine repost coalescing", () => {
  const target = makeEvent({
    id: hex("repost-target"),
    kind: 1,
    pubkey: PUBKEYS.alice,
    created_at: 900,
  });

  function repost(pubkey: string, createdAt: number, seed: string): NostrEvent {
    return makeEvent({
      id: hex(seed),
      kind: 6,
      pubkey,
      created_at: createdAt,
      tags: [["e", target.id]],
      content: "",
    });
  }

  it("collapses reposts of the same target inside the window into one row", async () => {
    const { store, engine } = harness({ kinds: [1, 6], relays: [RELAY] });
    await store.putAll([
      target,
      repost(PUBKEYS.bob, 1_000, "rp-bob"),
      repost(PUBKEYS.carol, 1_010, "rp-carol"),
    ]);
    await engine.start();
    await store.settle();

    const reposts = engine
      .snapshot()
      .entries.filter((entry) => entry.kind === "repost");
    expect(reposts).toHaveLength(1);
    expect(reposts[0]?.reposters).toEqual([PUBKEYS.bob, PUBKEYS.carol]);
    expect(reposts[0]?.repostIds).toHaveLength(2);
    expect(reposts[0]?.targetId).toBe(target.id);
    // The row sorts by the newest repost in the group.
    expect(reposts[0]?.createdAt).toBe(1_010);
    // Three events, two rows: the note and the coalesced repost.
    expect(engine.snapshot().entries).toHaveLength(2);
    engine.close();
  });

  it("starts a new row for a repost outside the window", async () => {
    const { store, engine } = harness(
      { kinds: [1, 6], relays: [RELAY] },
      { repostWindowSeconds: 600 },
    );
    await store.putAll([
      target,
      repost(PUBKEYS.bob, 1_000, "rp-near"),
      repost(PUBKEYS.carol, 50_000, "rp-far"),
    ]);
    await engine.start();
    await store.settle();

    const reposts = engine
      .snapshot()
      .entries.filter((entry) => entry.kind === "repost");
    expect(reposts).toHaveLength(2);
    expect(reposts.map((entry) => entry.reposters)).toEqual([
      [PUBKEYS.carol],
      [PUBKEYS.bob],
    ]);
    engine.close();
  });

  it("resolves the repost target from the store when it arrives later", async () => {
    const { store, engine } = harness({ kinds: [1, 6], relays: [RELAY] });
    await store.put(repost(PUBKEYS.bob, 1_000, "rp-later"));
    await engine.start();
    await store.settle();
    expect(
      engine.snapshot().entries.find((e) => e.kind === "repost")?.target,
    ).toBeUndefined();

    await store.put(target);
    await store.settle();
    expect(
      engine.snapshot().entries.find((e) => e.kind === "repost")?.target?.id,
    ).toBe(target.id);
    engine.close();
  });
});
