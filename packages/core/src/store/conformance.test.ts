/**
 * Shared `EventStore` conformance suite.
 *
 * Every rule here is a behaviour the rest of the app is allowed to rely on, so
 * both implementations are held to it: the suite is parameterised over
 * `MemoryEventStore` and `DexieEventStore` (on `fake-indexeddb`). A rule that
 * only the memory store honours is a bug waiting for the first persistent build.
 */

import "fake-indexeddb/auto";
import type { NostrEvent, Timestamp } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import type { EventStore, StoredEvent } from "../contracts";
import { microtaskScheduler } from "../internal/scheduler";
import { hex, makeDeletion, makeEvent, PUBKEYS } from "../testing/fixtures";
import { DexieEventStore } from "./dexieStore";
import { MemoryEventStore } from "./memoryStore";

interface Harness {
  readonly store: EventStore;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

/** Store construction knobs a test may need. */
interface HarnessOptions {
  /**
   * Clock, in unix seconds. Every NIP-40 test drives this instead of waiting:
   * a suite that sleeps to observe an expiry is a suite that is slow *and* flaky.
   */
  readonly now?: () => Timestamp;
}

/** A kind-1 note carrying a NIP-40 deadline of `at`, in unix seconds. */
function expiring(seed: string, at: Timestamp): NostrEvent {
  return makeEvent({
    id: hex(seed),
    kind: 1,
    tags: [["expiration", String(at)]],
  });
}

let dbSeq = 0;

const implementations: readonly {
  readonly name: string;
  readonly create: (options?: HarnessOptions) => Harness;
}[] = [
  {
    name: "MemoryEventStore",
    create: (options = {}) => {
      const store = new MemoryEventStore({
        scheduler: microtaskScheduler,
        ...(options.now ? { now: options.now } : {}),
      });
      return {
        store,
        settle: () => store.settle(),
        dispose: async () => store.close(),
      };
    },
  },
  {
    name: "DexieEventStore",
    create: (options = {}) => {
      dbSeq += 1;
      const store = new DexieEventStore({
        databaseName: `setu-conformance-${dbSeq}`,
        scheduler: microtaskScheduler,
        ...(options.now ? { now: options.now } : {}),
      });
      return {
        store,
        settle: () => store.settle(),
        dispose: () => store.destroy(),
      };
    },
  },
];

for (const impl of implementations) {
  describe(`EventStore conformance: ${impl.name}`, () => {
    async function withStore(
      body: (store: EventStore, harness: Harness) => Promise<void>,
      options?: HarnessOptions,
    ): Promise<void> {
      const harness = impl.create(options);
      try {
        await body(harness.store, harness);
      } finally {
        await harness.dispose();
      }
    }

    /** A store whose clock the test moves by assigning to `clock.now`. */
    function withClock(
      body: (
        store: EventStore,
        clock: { now: Timestamp },
        harness: Harness,
      ) => Promise<void>,
      startAt = 1_000,
    ): Promise<void> {
      const clock = { now: startAt };
      return withStore((store, harness) => body(store, clock, harness), {
        now: () => clock.now,
      });
    }

    it("dedups by id and merges provenance relays instead of duplicating", async () => {
      await withStore(async (store) => {
        const event = makeEvent({ id: hex("dedup") });
        expect(await store.put(event, "wss://one")).toBe(true);
        // Same event from a second relay: rejected as a duplicate, but the
        // relay must still be recorded.
        expect(await store.put(event, "wss://two")).toBe(false);
        expect(await store.put(event, "wss://two")).toBe(false);

        expect(await store.count({})).toBe(1);
        const stored = await store.get(event.id);
        expect(stored?.provenance.relays).toEqual(["wss://one", "wss://two"]);
      });
    });

    it("keeps only the newest version of a replaceable event", async () => {
      await withStore(async (store) => {
        const old = makeEvent({
          id: hex("old"),
          kind: 0,
          created_at: 100,
          content: "old",
        });
        const fresh = makeEvent({
          id: hex("new"),
          kind: 0,
          created_at: 200,
          content: "new",
        });
        expect(await store.put(old)).toBe(true);
        expect(await store.put(fresh)).toBe(true);

        const rows = await store.query({ kinds: [0] });
        expect(rows.map((r) => r.event.content)).toEqual(["new"]);

        // A late-arriving older version is stale and must not win.
        const older = makeEvent({
          id: hex("older"),
          kind: 0,
          created_at: 50,
          content: "older",
        });
        expect(await store.put(older)).toBe(false);
        const after = await store.query({ kinds: [0] });
        expect(after.map((r) => r.event.content)).toEqual(["new"]);
      });
    });

    it("breaks equal created_at ties on the lower lexical id (NIP-01)", async () => {
      // hex("a") < hex("b"), so "a" must win whichever order they arrive in.
      for (const order of [
        ["a", "b"],
        ["b", "a"],
      ] as const) {
        await withStore(async (store) => {
          for (const seed of order) {
            await store.put(
              makeEvent({
                id: hex(seed),
                kind: 10000,
                created_at: 500,
                content: seed,
              }),
            );
          }
          const rows = await store.query({ kinds: [10000] });
          expect(rows).toHaveLength(1);
          expect(rows[0]?.event.content).toBe("a");
        });
      }
    });

    it("rejects a stale addressable version and breaks ties on lower id", async () => {
      await withStore(async (store) => {
        const article = (id: string, created: number, content: string) =>
          makeEvent({
            id: hex(id),
            kind: 30023,
            created_at: created,
            tags: [["d", "slug"]],
            content,
          });

        expect(await store.put(article("v2", 200, "v2"))).toBe(true);
        // Older version of the same address: stale, must not win.
        expect(await store.put(article("v1", 100, "v1"))).toBe(false);
        expect(
          (await store.query({ kinds: [30023] })).map((r) => r.event.content),
        ).toEqual(["v2"]);

        // Equal created_at: NIP-01 says the lower lexical id wins. hex("a-tie")
        // sorts below hex("b-tie"), so the loser is rejected whichever way round
        // the two arrive.
        expect(await store.put(article("b-tie", 300, "b"))).toBe(true);
        expect(await store.put(article("a-tie", 300, "a"))).toBe(true);
        expect(await store.put(article("b-tie", 300, "b"))).toBe(false);
        expect(
          (await store.query({ kinds: [30023] })).map((r) => r.event.content),
        ).toEqual(["a"]);
      });
    });

    it("applies addressable last-write-wins per d-tag", async () => {
      await withStore(async (store) => {
        const article = (d: string, created: number, content: string) =>
          makeEvent({
            id: hex(`${d}-${created}`),
            kind: 30023,
            created_at: created,
            tags: [["d", d]],
            content,
          });

        await store.put(article("one", 100, "one-v1"));
        await store.put(article("two", 100, "two-v1"));
        await store.put(article("one", 200, "one-v2"));

        const rows = await store.query({ kinds: [30023] });
        expect(rows.map((r) => r.event.content).sort()).toEqual([
          "one-v2",
          "two-v1",
        ]);
      });
    });

    it("never resurrects a deleted event, even from a later relay", async () => {
      await withStore(async (store) => {
        const note = makeEvent({ id: hex("doomed"), pubkey: PUBKEYS.alice });
        await store.put(note, "wss://one");
        expect(await store.count({ ids: [note.id] })).toBe(1);

        await store.put(
          makeDeletion({
            id: hex("del"),
            pubkey: PUBKEYS.alice,
            ids: [note.id],
            created_at: 1_700_000_100,
          }),
        );
        expect(await store.get(note.id)).toBeUndefined();

        // A relay handing it back later must not undo the deletion.
        expect(await store.put(note, "wss://two")).toBe(false);
        expect(await store.get(note.id)).toBeUndefined();
        expect(await store.count({ ids: [note.id] })).toBe(0);
      });
    });

    it("honours a deletion only from the event's own author", async () => {
      await withStore(async (store) => {
        const note = makeEvent({ id: hex("safe"), pubkey: PUBKEYS.alice });
        await store.put(note);

        // Bob cannot delete Alice's note, by id...
        await store.put(
          makeDeletion({
            id: hex("del-bob"),
            pubkey: PUBKEYS.bob,
            ids: [note.id],
          }),
        );
        expect(await store.get(note.id)).toBeDefined();

        // ...nor by address.
        const article = makeEvent({
          id: hex("art"),
          pubkey: PUBKEYS.alice,
          kind: 30023,
          created_at: 100,
          tags: [["d", "x"]],
        });
        await store.put(article);
        await store.put(
          makeDeletion({
            id: hex("del-bob-addr"),
            pubkey: PUBKEYS.bob,
            addresses: [`30023:${PUBKEYS.alice}:x`],
            created_at: 200,
          }),
        );
        expect(await store.get(article.id)).toBeDefined();

        // The author can.
        await store.put(
          makeDeletion({
            id: hex("del-alice-addr"),
            pubkey: PUBKEYS.alice,
            addresses: [`30023:${PUBKEYS.alice}:x`],
            created_at: 200,
          }),
        );
        expect(await store.get(article.id)).toBeUndefined();
      });
    });

    it("never stores ephemeral kinds, at the exact range boundaries", async () => {
      await withStore(async (store) => {
        // 20000–29999 inclusive is the ephemeral range. The boundaries are
        // asserted because an off-by-one here silently persists what a relay is
        // told not to keep, or drops a kind that is meant to last.
        for (const kind of [20000, 20001, 24133, 29999]) {
          expect(
            await store.put(makeEvent({ id: hex(`eph-${kind}`), kind })),
          ).toBe(false);
        }
        expect(await store.count({})).toBe(0);

        for (const kind of [19999, 30000]) {
          expect(
            await store.put(makeEvent({ id: hex(`keep-${kind}`), kind })),
          ).toBe(true);
        }
        expect(await store.count({})).toBe(2);
      });
    });

    // --- NIP-40 expiration ---------------------------------------------

    it("refuses an event that has already expired on arrival (NIP-40)", async () => {
      await withClock(async (store, clock) => {
        clock.now = 1_000;
        const past = expiring("past", 900);
        const exact = expiring("exact", 1_000);
        // Inclusive boundary: the second the deadline names, it is gone.
        expect(await store.put(past)).toBe(false);
        expect(await store.put(exact)).toBe(false);
        expect(await store.count({})).toBe(0);
        expect(await store.get(past.id)).toBeUndefined();

        // A relay handing it back later must not change the answer.
        clock.now = 1_001;
        expect(await store.put(past, "wss://later")).toBe(false);
        expect(await store.count({})).toBe(0);
      });
    });

    it("hides an expired event from every read the moment its time passes", async () => {
      await withClock(async (store, clock) => {
        clock.now = 1_000;
        const note = expiring("soon", 2_000);
        expect(await store.put(note)).toBe(true);
        expect(await store.count({ kinds: [1] })).toBe(1);
        expect(await store.get(note.id)).toBeDefined();
        expect(await store.nextExpirationAt()).toBe(2_000);

        // Nothing has swept and nothing has been written; only the clock moved.
        clock.now = 2_000;
        expect(await store.count({ kinds: [1] })).toBe(0);
        expect(await store.query({ kinds: [1] })).toEqual([]);
        expect(await store.get(note.id)).toBeUndefined();
        expect(await store.count({ ids: [note.id] })).toBe(0);
        // The watermark must not sit on an event no read can return.
        expect(await store.newestTimestamp({ kinds: [1] })).toBeUndefined();
      });
    });

    it("sweepExpired removes the row and wakes its observers", async () => {
      await withClock(async (store, clock, harness) => {
        clock.now = 1_000;
        await store.put(expiring("swept", 2_000));
        const calls: (readonly StoredEvent[])[] = [];
        store.observe({ kinds: [1] }, (events) => calls.push(events));
        await harness.settle();
        expect(calls[0]).toHaveLength(1);

        // Before the deadline the sweep is a no-op and fires nothing.
        expect(await store.sweepExpired()).toBe(0);
        await harness.settle();
        expect(calls).toHaveLength(1);

        clock.now = 2_500;
        expect(await store.sweepExpired()).toBe(1);
        await harness.settle();
        // A note vanishing from a feed is an event the UI must be told about.
        expect(calls[calls.length - 1]).toHaveLength(0);
        expect(await store.nextExpirationAt()).toBeUndefined();
        // Idempotent: the row is gone, so a second sweep has nothing to do.
        expect(await store.sweepExpired()).toBe(0);
      });
    });

    it("an ordinary write sweeps expired events and notifies observers", async () => {
      await withClock(async (store, clock, harness) => {
        clock.now = 1_000;
        await store.put(expiring("lapsing", 2_000));
        const calls: (readonly StoredEvent[])[] = [];
        store.observe({ kinds: [1] }, (events) => calls.push(events));
        await harness.settle();
        expect(calls[0]).toHaveLength(1);

        // No explicit sweep: writing anything at all is enough, which is why a
        // client receiving relay traffic needs no timer.
        clock.now = 2_000;
        await store.put(makeEvent({ id: hex("unrelated"), kind: 1 }));
        await harness.settle();
        const last = calls[calls.length - 1];
        expect(last?.map((r) => r.event.id)).toEqual([hex("unrelated")]);
      });
    });

    it("treats a malformed expiration as no expiration, never as expired", async () => {
      await withClock(async (store, clock) => {
        clock.now = 1_000;
        const malformed = [
          [],
          ["expiration"],
          ["expiration", ""],
          ["expiration", "soon"],
          ["expiration", "-5"],
          ["expiration", "0"],
          ["expiration", "1e3"],
          ["expiration", "900.5"],
          ["expiration", " 900"],
          ["expiration", "99999999999999999999"],
          ["expiration", "1000000000001"],
        ];
        for (const [index, tag] of malformed.entries()) {
          const event = makeEvent({
            id: hex(`malformed-${index}`),
            kind: 1,
            tags: tag.length === 0 ? [] : [tag],
          });
          expect(await store.put(event)).toBe(true);
        }
        expect(await store.count({ kinds: [1] })).toBe(malformed.length);
        expect(await store.nextExpirationAt()).toBeUndefined();

        // Still there far beyond any deadline those values might be misread as.
        clock.now = 4_000_000_000;
        expect(await store.count({ kinds: [1] })).toBe(malformed.length);
        expect(await store.sweepExpired()).toBe(0);
      });
    });

    it("honours the earliest valid expiration when several tags are present", async () => {
      await withClock(async (store, clock) => {
        clock.now = 1_000;
        const event = makeEvent({
          id: hex("multi-exp"),
          kind: 1,
          // A malformed first tag must not shadow the real deadline behind it.
          tags: [
            ["expiration", "nonsense"],
            ["expiration", "3000"],
            ["expiration", "2000"],
          ],
        });
        expect(await store.put(event)).toBe(true);
        expect(await store.nextExpirationAt()).toBe(2_000);
        clock.now = 2_000;
        expect(await store.get(event.id)).toBeUndefined();
      });
    });

    it("keeps expiry bookkeeping out of unrelated removals", async () => {
      await withClock(async (store, clock) => {
        clock.now = 1_000;
        const note = makeEvent({
          id: hex("exp-deleted"),
          kind: 1,
          pubkey: PUBKEYS.alice,
          tags: [["expiration", "2000"]],
        });
        await store.put(note);
        // Deleted before it could expire: the deadline must go with the row, so a
        // later sweep cannot trip over a dangling entry.
        await store.put(
          makeDeletion({
            id: hex("exp-del-req"),
            pubkey: PUBKEYS.alice,
            ids: [note.id],
            created_at: 1_500,
          }),
        );
        clock.now = 2_500;
        expect(await store.sweepExpired()).toBe(0);
        expect(await store.count({ kinds: [1] })).toBe(0);
      });
    });

    // --- NIP-70 protected events ---------------------------------------

    it("stores a protected event and marks the row (NIP-70)", async () => {
      await withStore(async (store) => {
        const guarded = makeEvent({
          id: hex("guarded"),
          kind: 1,
          pubkey: PUBKEYS.bob,
          tags: [["-"]],
        });
        const ordinary = makeEvent({ id: hex("ordinary"), kind: 1 });
        // It is legitimate data we received: refusing to store it would only hide
        // a note every other reader can see.
        expect(await store.put(guarded, "wss://one")).toBe(true);
        expect(await store.put(ordinary)).toBe(true);

        expect((await store.get(guarded.id))?.protected).toBe(true);
        expect((await store.get(ordinary.id))?.protected).toBeUndefined();
        // The flag survives the query path too, not just `get`.
        const rows = await store.query({ ids: [guarded.id] });
        expect(rows[0]?.protected).toBe(true);

        // Provenance merging must not drop the marking.
        expect(await store.put(guarded, "wss://two")).toBe(false);
        const merged = await store.get(guarded.id);
        expect(merged?.protected).toBe(true);
        expect(merged?.provenance.relays).toEqual(["wss://one", "wss://two"]);
      });
    });

    it("rejects structurally invalid events", async () => {
      await withStore(async (store) => {
        const bad = { ...makeEvent(), id: "not-hex" } as never;
        expect(await store.put(bad)).toBe(false);
        expect(await store.count({})).toBe(0);
      });
    });

    it("observe fires immediately, then on every relevant change", async () => {
      await withStore(async (store, harness) => {
        const calls: (readonly StoredEvent[])[] = [];
        const unsubscribe = store.observe({ kinds: [1] }, (events) => {
          calls.push(events);
        });

        await harness.settle();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual([]);

        await store.put(makeEvent({ id: hex("n1"), kind: 1 }));
        await harness.settle();
        expect(calls).toHaveLength(2);
        expect(calls[1]).toHaveLength(1);

        // An unrelated kind must not wake this observer.
        await store.put(makeEvent({ id: hex("r1"), kind: 7 }));
        await harness.settle();
        expect(calls).toHaveLength(2);

        unsubscribe();
        await store.put(makeEvent({ id: hex("n2"), kind: 1 }));
        await harness.settle();
        expect(calls).toHaveLength(2);
      });
    });

    it("observe reflects deletions as well as insertions", async () => {
      await withStore(async (store, harness) => {
        const note = makeEvent({
          id: hex("obs-del"),
          kind: 1,
          pubkey: PUBKEYS.alice,
        });
        await store.put(note);

        const calls: (readonly StoredEvent[])[] = [];
        store.observe({ kinds: [1] }, (events) => calls.push(events));
        await harness.settle();
        expect(calls[0]).toHaveLength(1);

        await store.put(
          makeDeletion({
            id: hex("obs-del-req"),
            pubkey: PUBKEYS.alice,
            ids: [note.id],
            created_at: note.created_at + 1,
          }),
        );
        await harness.settle();
        expect(calls[calls.length - 1]).toHaveLength(0);
      });
    });

    it("coalesces a burst of 100 puts into a handful of callbacks", async () => {
      await withStore(async (store, harness) => {
        const calls: (readonly StoredEvent[])[] = [];
        store.observe({ kinds: [1] }, (events) => calls.push(events));
        await harness.settle();
        expect(calls).toHaveLength(1);

        const events = Array.from({ length: 100 }, (_, i) =>
          makeEvent({
            id: hex(`burst-${i}`),
            kind: 1,
            created_at: 1_700_000_000 + i,
          }),
        );
        await Promise.all(events.map((event) => store.put(event)));
        await harness.settle();

        const afterInitial = calls.length - 1;
        // The property that matters: O(1)-ish callbacks, not O(events).
        expect(afterInitial).toBeGreaterThanOrEqual(1);
        expect(afterInitial).toBeLessThanOrEqual(5);
        expect(calls[calls.length - 1]).toHaveLength(100);
      });
    });

    it("coalesces putAll into a single callback", async () => {
      await withStore(async (store, harness) => {
        const calls: (readonly StoredEvent[])[] = [];
        store.observe({ kinds: [1] }, (events) => calls.push(events));
        await harness.settle();

        const events = Array.from({ length: 50 }, (_, i) =>
          makeEvent({ id: hex(`bulk-${i}`), kind: 1, created_at: 1000 + i }),
        );
        expect(await store.putAll(events, "wss://relay")).toBe(50);
        await harness.settle();

        expect(calls).toHaveLength(2);
        expect(calls[1]).toHaveLength(50);
      });
    });

    it("reports the newest timestamp per filter", async () => {
      await withStore(async (store) => {
        expect(await store.newestTimestamp({ kinds: [1] })).toBeUndefined();
        await store.putAll([
          makeEvent({ id: hex("t1"), kind: 1, created_at: 100 }),
          makeEvent({ id: hex("t2"), kind: 1, created_at: 300 }),
          makeEvent({ id: hex("t3"), kind: 7, created_at: 900 }),
        ]);
        expect(await store.newestTimestamp({ kinds: [1] })).toBe(300);
        expect(await store.newestTimestamp({ kinds: [7] })).toBe(900);
        expect(await store.newestTimestamp({})).toBe(900);
        expect(
          await store.newestTimestamp({ authors: [PUBKEYS.bob] }),
        ).toBeUndefined();
      });
    });

    it("queries correctly by id, author, kind and tag", async () => {
      await withStore(async (store) => {
        const a = makeEvent({
          id: hex("q-a"),
          pubkey: PUBKEYS.alice,
          kind: 1,
          created_at: 100,
          tags: [["t", "nostr"]],
        });
        const b = makeEvent({
          id: hex("q-b"),
          pubkey: PUBKEYS.bob,
          kind: 1,
          created_at: 200,
          tags: [["t", "bitcoin"]],
        });
        const c = makeEvent({
          id: hex("q-c"),
          pubkey: PUBKEYS.alice,
          kind: 7,
          created_at: 300,
          tags: [
            ["e", a.id],
            ["t", "nostr"],
          ],
        });
        await store.putAll([a, b, c]);

        const ids = async (filter: Parameters<EventStore["query"]>[0]) =>
          (await store.query(filter)).map((r) => r.event.id);

        expect(await ids({ ids: [a.id] })).toEqual([a.id]);
        expect(await ids({ authors: [PUBKEYS.alice] })).toEqual([c.id, a.id]);
        expect(await ids({ kinds: [1] })).toEqual([b.id, a.id]);
        expect(await ids({ "#t": ["nostr"] })).toEqual([c.id, a.id]);
        expect(await ids({ "#t": ["nostr"], kinds: [1] })).toEqual([a.id]);
        expect(await ids({ "#e": [a.id] })).toEqual([c.id]);
        expect(await ids({ authors: [PUBKEYS.alice], kinds: [7] })).toEqual([
          c.id,
        ]);
        expect(await ids({ since: 200 })).toEqual([c.id, b.id]);
        expect(await ids({ until: 200 })).toEqual([b.id, a.id]);
        // Newest-first plus limit.
        expect(await ids({ limit: 2 })).toEqual([c.id, b.id]);
        expect(await ids({ ids: [hex("missing")] })).toEqual([]);
      });
    });

    it("clear() empties the store and re-fires observers", async () => {
      await withStore(async (store, harness) => {
        await store.putAll([
          makeEvent({ id: hex("c1"), kind: 1 }),
          makeEvent({ id: hex("c2"), kind: 1 }),
        ]);
        const calls: (readonly StoredEvent[])[] = [];
        store.observe({ kinds: [1] }, (events) => calls.push(events));
        await harness.settle();
        expect(calls[0]).toHaveLength(2);

        await store.clear();
        await harness.settle();
        expect(await store.count({})).toBe(0);
        expect(calls[calls.length - 1]).toHaveLength(0);
      });
    });
  });
}

describe("DexieEventStore database naming", () => {
  it("derives a per-account database name so accounts never share a store", () => {
    const alice = new DexieEventStore({ accountPubkey: PUBKEYS.alice });
    const bob = new DexieEventStore({ accountPubkey: PUBKEYS.bob });
    expect(alice.databaseName).toBe(`setu-${PUBKEYS.alice.slice(0, 12)}`);
    expect(alice.databaseName).not.toBe(bob.databaseName);
    alice.close();
    bob.close();
  });
});
