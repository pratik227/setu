/**
 * Profile batching: one debounced, chunked, de-duplicated request instead of one
 * subscription per avatar.
 */

import { describe, expect, it } from "vitest";
import { microtaskScheduler } from "../internal/scheduler";
import { MemoryEventStore } from "../store/memoryStore";
import { FakeSubscriptions } from "../testing/fakes";
import { hex, makeEvent, PUBKEYS } from "../testing/fixtures";
import { DefaultProfileBatcher } from "./profileBatcher";

const RELAYS = ["wss://profile.relay"];

function metadata(pubkey: string, seed: string) {
  return makeEvent({
    id: hex(seed),
    pubkey,
    kind: 0,
    created_at: 1_000,
    content: '{"name":"someone"}',
  });
}

function harness(
  options: {
    maxAuthorsPerFilter?: number;
    failureCooldownMs?: number;
    now?: () => number;
  } = {},
) {
  const store = new MemoryEventStore({ scheduler: microtaskScheduler });
  const subscriptions = new FakeSubscriptions(store);
  const batcher = new DefaultProfileBatcher({
    store,
    subscriptions,
    relays: RELAYS,
    debounceMs: 0,
    ...options,
  });
  return { store, subscriptions, batcher };
}

describe("DefaultProfileBatcher", () => {
  it("coalesces many requests into one subscription", async () => {
    const { subscriptions, batcher } = harness();
    subscriptions.network = [
      metadata(PUBKEYS.alice, "m-alice"),
      metadata(PUBKEYS.bob, "m-bob"),
    ];

    batcher.request([PUBKEYS.alice]);
    batcher.request([PUBKEYS.bob, PUBKEYS.alice]);
    batcher.request([PUBKEYS.alice]);
    await batcher.flush();

    expect(subscriptions.fetches).toHaveLength(1);
    expect(subscriptions.fetches[0]?.filters[0]?.filter.authors).toEqual([
      PUBKEYS.alice,
      PUBKEYS.bob,
    ]);
    expect(subscriptions.fetches[0]?.filters[0]?.filter.kinds).toEqual([
      0, 10002,
    ]);
    expect(batcher.stats().loaded).toBe(2);
  });

  it("never asks for a pubkey whose metadata is already stored", async () => {
    const { store, subscriptions, batcher } = harness();
    await store.put(metadata(PUBKEYS.alice, "m-cached"));

    batcher.request([PUBKEYS.alice]);
    await batcher.flush();
    expect(subscriptions.fetches).toHaveLength(0);
    expect(batcher.stats().loaded).toBe(1);
  });

  it("chunks authors to the configured maximum per filter", async () => {
    const { subscriptions, batcher } = harness({ maxAuthorsPerFilter: 2 });
    const pubkeys = ["p1", "p2", "p3", "p4", "p5"].map((seed) => hex(seed));

    batcher.request(pubkeys);
    await batcher.flush();

    expect(subscriptions.fetches).toHaveLength(3);
    const sizes = subscriptions.fetches.map(
      (request) => request.filters[0]?.filter.authors?.length,
    );
    expect(sizes).toEqual([2, 2, 1]);
  });

  it("bounds every filter by the events that can legitimately match", async () => {
    const { subscriptions, batcher } = harness({ maxAuthorsPerFilter: 2 });
    const pubkeys = ["q1", "q2", "q3"].map((seed) => hex(seed));

    batcher.request(pubkeys);
    await batcher.flush();

    // Both requested kinds are replaceable, so a relay can hold at most one event
    // per (author, kind): the bound is exact rather than a guess, and no filter
    // may go out without one.
    const limits = subscriptions.fetches.map(
      (request) => request.filters[0]?.filter.limit,
    );
    expect(limits).toEqual([4, 2]);
  });

  it("does not re-request a pubkey until its failure cooldown expires", async () => {
    let now = 0;
    const { subscriptions, batcher } = harness({
      failureCooldownMs: 1_000,
      now: () => now,
    });

    // Nothing on the network: the request fails and enters cooldown.
    batcher.request([PUBKEYS.carol]);
    await batcher.flush();
    expect(subscriptions.fetches).toHaveLength(1);
    expect(batcher.stats().cooling).toBe(1);

    now = 500;
    batcher.request([PUBKEYS.carol]);
    await batcher.flush();
    expect(subscriptions.fetches).toHaveLength(1);

    now = 1_500;
    subscriptions.network = [metadata(PUBKEYS.carol, "m-carol")];
    batcher.request([PUBKEYS.carol]);
    await batcher.flush();
    expect(subscriptions.fetches).toHaveLength(2);
    expect(batcher.stats().loaded).toBe(1);
    expect(batcher.stats().cooling).toBe(0);
  });

  it("stops asking once a profile has been loaded", async () => {
    const { subscriptions, batcher } = harness();
    subscriptions.network = [metadata(PUBKEYS.alice, "m-again")];
    batcher.request([PUBKEYS.alice]);
    await batcher.flush();
    expect(subscriptions.fetches).toHaveLength(1);

    batcher.request([PUBKEYS.alice]);
    await batcher.flush();
    expect(subscriptions.fetches).toHaveLength(1);
  });

  it("reset() forgets everything, so an account switch starts clean", async () => {
    const { subscriptions, batcher } = harness();
    subscriptions.network = [metadata(PUBKEYS.alice, "m-reset")];
    batcher.request([PUBKEYS.alice]);
    await batcher.flush();
    expect(batcher.stats().loaded).toBe(1);

    batcher.reset();
    expect(batcher.stats()).toEqual({
      loaded: 0,
      queued: 0,
      inFlight: 0,
      cooling: 0,
    });
  });

  it("debounces a burst of requests into a single flush", async () => {
    const store = new MemoryEventStore({ scheduler: microtaskScheduler });
    const subscriptions = new FakeSubscriptions(store);
    const batcher = new DefaultProfileBatcher({
      store,
      subscriptions,
      relays: RELAYS,
      debounceMs: 5,
    });
    subscriptions.network = [
      metadata(PUBKEYS.alice, "d-alice"),
      metadata(PUBKEYS.bob, "d-bob"),
    ];

    batcher.request([PUBKEYS.alice]);
    batcher.request([PUBKEYS.bob]);
    // Nothing has gone out yet — the debounce window is still open.
    expect(subscriptions.fetches).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(subscriptions.fetches).toHaveLength(1);
    expect(subscriptions.fetches[0]?.filters[0]?.filter.authors).toHaveLength(
      2,
    );
  });
});
