/**
 * Subscription manager behaviour.
 *
 * These five properties are the ones the rest of the app is built on: nothing
 * unverified reaches the store, `localOnly` really is offline, `since` really is
 * per relay, a publish is visible locally before any relay has answered, and a
 * NIP-70 protected event that is not ours is never handed to a relay.
 */

import { describe, expect, it } from "vitest";
import { microtaskScheduler } from "../internal/scheduler";
import { MemoryEventStore } from "../store/memoryStore";
import { isProtectedEventPublishError } from "../store/protection";
import { tick } from "../testing/fakeSocket";
import { FakeRelayPool } from "../testing/fakes";
import { hex, makeEvent, PUBKEYS } from "../testing/fixtures";
import { BatchingEventVerifier, NoopVerifier } from "../verify/verifier";
import { filterFingerprint, SinceTracker } from "./sinceTracker";
import { DefaultSubscriptionManager } from "./subscriptionManager";

const RELAY_A = "wss://a.relay";
const RELAY_B = "wss://b.relay";

function harness(options: { rejectId?: string } = {}) {
  const store = new MemoryEventStore({ scheduler: microtaskScheduler });
  const pool = new FakeRelayPool();
  const verifier = new BatchingEventVerifier({
    verifySignature: (event) => event.id !== options.rejectId,
    scheduler: microtaskScheduler,
  });
  const sinceTracker = new SinceTracker(120);
  const manager = new DefaultSubscriptionManager({
    store,
    pool,
    verifier,
    sinceTracker,
    scheduler: microtaskScheduler,
  });
  return { store, pool, verifier, manager, sinceTracker };
}

describe("filterFingerprint", () => {
  it("ignores the window fields and is order-insensitive", () => {
    const a = filterFingerprint({ kinds: [1, 2], authors: ["b", "a"] });
    const b = filterFingerprint({ authors: ["a", "b"], kinds: [2, 1] });
    expect(a).toBe(b);
    expect(
      filterFingerprint({ kinds: [1], since: 10, until: 20, limit: 5 }),
    ).toBe(filterFingerprint({ kinds: [1] }));
    expect(filterFingerprint({ kinds: [1] })).not.toBe(
      filterFingerprint({ kinds: [2] }),
    );
  });
});

describe("DefaultSubscriptionManager", () => {
  it("drops unverified events before the store and counts them", async () => {
    const forged = makeEvent({ id: hex("forged"), kind: 1 });
    const { store, pool, manager } = harness({ rejectId: forged.id });
    const genuine = makeEvent({ id: hex("genuine"), kind: 1 });

    manager.subscribe({
      filters: [{ relay: RELAY_A, filter: { kinds: [1] } }],
    });
    await tick(5);

    pool.emit(genuine, RELAY_A);
    pool.emit(forged, RELAY_A);
    await manager.flushIngest();
    await tick(5);
    await manager.flushIngest();

    expect(await store.get(genuine.id)).toBeDefined();
    // The forged event must be absent from the store entirely — not filtered at
    // render time, not stored-but-flagged.
    expect(await store.get(forged.id)).toBeUndefined();
    const stats = manager.stats();
    expect(stats.received).toBe(2);
    expect(stats.verified).toBe(1);
    expect(stats.dropped).toBe(1);
    expect(stats.stored).toBe(1);
  });

  it("localOnly never opens a socket", async () => {
    const { store, pool, manager } = harness();
    const local = makeEvent({ id: hex("local"), kind: 1 });
    await store.put(local, "wss://earlier");

    manager.subscribe({
      filters: [{ relay: RELAY_A, filter: { kinds: [1] } }],
      mode: { type: "localOnly" },
    });
    await tick(5);
    expect(pool.requests).toHaveLength(0);

    const fetched = await manager.fetch({
      filters: [{ relay: RELAY_A, filter: { kinds: [1] } }],
      mode: { type: "localOnly" },
    });
    expect(fetched.map((e) => e.id)).toEqual([local.id]);
    expect(pool.requests).toHaveLength(0);
    expect(pool.connectCalls).toHaveLength(0);
  });

  it("localThenNetwork resolves from local data and still fills the store", async () => {
    const { store, pool, manager } = harness();
    const local = makeEvent({ id: hex("cached"), kind: 1 });
    await store.put(local);

    const fetched = await manager.fetch({
      filters: [{ relay: RELAY_A, filter: { kinds: [1] } }],
      mode: { type: "localThenNetwork" },
    });
    expect(fetched.map((e) => e.id)).toEqual([local.id]);

    // The network read is still running in the background.
    await tick(5);
    expect(pool.requests).toHaveLength(1);
    const fresh = makeEvent({ id: hex("fresh"), kind: 1 });
    pool.emit(fresh, RELAY_A);
    pool.complete();
    await manager.flushIngest();
    await tick(5);
    await manager.flushIngest();
    expect(await store.get(fresh.id)).toBeDefined();
  });

  it("computes an incremental since per relay, with the overlap window", async () => {
    const { pool, manager } = harness();
    const filter = { kinds: [1] };

    manager.subscribe({
      filters: [
        { relay: RELAY_A, filter },
        { relay: RELAY_B, filter },
      ],
    });
    await tick(5);

    // A is caught up to 1000; B is an hour behind at 500.
    pool.emit(
      makeEvent({ id: hex("a1"), kind: 1, created_at: 1_000 }),
      RELAY_A,
    );
    pool.emit(makeEvent({ id: hex("b1"), kind: 1, created_at: 500 }), RELAY_B);
    await manager.flushIngest();
    await tick(5);
    await manager.flushIngest();

    manager.subscribe({
      filters: [
        { relay: RELAY_A, filter },
        { relay: RELAY_B, filter },
      ],
      incremental: true,
    });
    await tick(5);

    // A single global `since` would have used 1000 for both and lost B's gap.
    expect(pool.lastFilters).toEqual([
      { relay: RELAY_A, filter: { kinds: [1], since: 880 } },
      { relay: RELAY_B, filter: { kinds: [1], since: 380 } },
    ]);
  });

  it("does not carry a watermark across unrelated filters on the same relay", async () => {
    const { pool, manager } = harness();
    const notes = { kinds: [1], authors: [PUBKEYS.alice] };
    const profiles = { kinds: [0], authors: [PUBKEYS.bob] };

    manager.subscribe({
      filters: [
        { relay: RELAY_A, filter: notes },
        { relay: RELAY_A, filter: profiles },
      ],
    });
    await tick(5);
    pool.emit(
      makeEvent({
        id: hex("note"),
        kind: 1,
        pubkey: PUBKEYS.alice,
        created_at: 9_000,
      }),
      RELAY_A,
    );
    await manager.flushIngest();
    await tick(5);
    await manager.flushIngest();

    manager.subscribe({
      filters: [
        { relay: RELAY_A, filter: notes },
        { relay: RELAY_A, filter: profiles },
      ],
      incremental: true,
    });
    await tick(5);
    const [noteFilter, profileFilter] = pool.lastFilters;
    expect(noteFilter?.filter.since).toBe(8_880);
    // The busy notes filter must not drag the profile filter's window forward.
    expect(profileFilter?.filter.since).toBeUndefined();
  });

  it("omits since entirely on a cold start", async () => {
    const { pool, manager } = harness();
    manager.subscribe({
      filters: [{ relay: RELAY_A, filter: { kinds: [1] } }],
      incremental: true,
    });
    await tick(5);
    expect(pool.lastFilters[0]?.filter.since).toBeUndefined();
  });

  it("echoes a publish into the store before any relay responds", async () => {
    const store = new MemoryEventStore({ scheduler: microtaskScheduler });
    const pool = new FakeRelayPool();
    let release: ((results: never[]) => void) | undefined;
    pool.publishResult = () =>
      new Promise((resolve) => {
        release = resolve as (results: never[]) => void;
      });
    const manager = new DefaultSubscriptionManager({
      store,
      pool,
      verifier: new NoopVerifier(),
      scheduler: microtaskScheduler,
    });

    const mine = makeEvent({ id: hex("mine"), kind: 1, content: "hello" });
    const publishing = manager.publish(mine, [RELAY_A]);
    await tick(5);

    // No relay has answered, yet the note is already readable through the store.
    expect(release).toBeDefined();
    expect(await store.get(mine.id)).toBeDefined();
    expect(pool.publishCalls).toHaveLength(1);

    release?.([]);
    await expect(publishing).resolves.toEqual([]);
  });

  it("falls back to the configured relays when publish names none", async () => {
    const store = new MemoryEventStore({ scheduler: microtaskScheduler });
    const pool = new FakeRelayPool();
    const manager = new DefaultSubscriptionManager({
      store,
      pool,
      verifier: new NoopVerifier(),
      scheduler: microtaskScheduler,
      defaultRelays: () => ["wss://Default.Relay/"],
    });
    await manager.publish(makeEvent({ id: hex("def") }));
    expect(pool.publishCalls[0]?.relays).toEqual(["wss://default.relay"]);
  });

  describe("NIP-70 protected events", () => {
    function publishHarness(ownPubkey?: string) {
      const store = new MemoryEventStore({ scheduler: microtaskScheduler });
      const pool = new FakeRelayPool();
      const manager = new DefaultSubscriptionManager({
        store,
        pool,
        verifier: new NoopVerifier(),
        scheduler: microtaskScheduler,
        ...(ownPubkey !== undefined ? { ownPubkey: () => ownPubkey } : {}),
      });
      return { store, pool, manager };
    }

    const guarded = (pubkey: string) =>
      makeEvent({
        id: hex(`guarded-${pubkey}`),
        kind: 1,
        pubkey,
        tags: [["-"]],
      });

    it("refuses to relay a protected event belonging to someone else", async () => {
      const { store, pool, manager } = publishHarness(PUBKEYS.alice);
      const bobs = guarded(PUBKEYS.bob);

      await expect(manager.publish(bobs, [RELAY_A])).rejects.toThrow(
        /protected event/,
      );
      // Refused, not silently dropped and not silently sent: no socket traffic,
      // and no local echo either, so no UI can show a post no relay will hold.
      expect(pool.publishCalls).toHaveLength(0);
      expect(await store.get(bobs.id)).toBeUndefined();

      const error = await manager.publish(bobs).catch((e: unknown) => e);
      expect(isProtectedEventPublishError(error)).toBe(true);
      if (isProtectedEventPublishError(error)) {
        expect(error.code).toBe("protected-event");
        expect(error.eventId).toBe(bobs.id);
        expect(error.author).toBe(PUBKEYS.bob);
      }
    });

    it("publishes our own protected event normally", async () => {
      const { store, pool, manager } = publishHarness(PUBKEYS.alice);
      const mine = guarded(PUBKEYS.alice);
      await manager.publish(mine, [RELAY_A]);
      expect(pool.publishCalls).toHaveLength(1);
      expect((await store.get(mine.id))?.protected).toBe(true);
    });

    it("refuses every protected event when no identity is configured", async () => {
      const { pool, manager } = publishHarness();
      // Not knowing whether the event is ours is not evidence that it is.
      await expect(manager.publish(guarded(PUBKEYS.alice))).rejects.toThrow(
        /protected event/,
      );
      expect(pool.publishCalls).toHaveLength(0);
    });

    it("leaves unprotected events alone whoever wrote them", async () => {
      const { pool, manager } = publishHarness(PUBKEYS.alice);
      await manager.publish(
        makeEvent({ id: hex("plain-bob"), pubkey: PUBKEYS.bob }),
        [RELAY_A],
      );
      expect(pool.publishCalls).toHaveLength(1);
    });
  });

  it("closing a handle before the socket opens issues no request", async () => {
    const { pool, manager } = harness();
    const handle = manager.subscribe({
      filters: [{ relay: RELAY_A, filter: { kinds: [1] } }],
    });
    handle.close();
    await tick(5);
    expect(pool.requests).toHaveLength(0);
  });
});

describe("publish verifies before echoing", () => {
  it("refuses an event that fails verification, with no side effects", async () => {
    // The local echo used to skip verification for latency. That left exactly one
    // path into the store that trusted its caller — and an event carrying a valid
    // (id, sig) pair with swapped content passes a signature-only check, so it
    // would have reached the UI looking genuine.
    const bad = makeEvent({ id: hex("badpublish"), kind: 1 });
    const { manager, store, pool } = harness({ rejectId: bad.id });

    await expect(manager.publish(bad, [RELAY_A])).rejects.toMatchObject({
      code: "unverified-event",
      eventId: bad.id,
    });

    // Nothing echoed, and nothing sent: a refusal must not leave the caller with
    // a note in the store that no relay will ever hold.
    expect(await store.get(bad.id)).toBeUndefined();
    expect(pool.publishCalls).toHaveLength(0);
  });

  it("publishes an event that verifies", async () => {
    const good = makeEvent({ id: hex("goodpublish"), kind: 1 });
    const { manager, store, pool } = harness();
    await manager.publish(good, [RELAY_A]);
    expect(await store.get(good.id)).toBeDefined();
    expect(pool.publishCalls).toHaveLength(1);
  });
});
