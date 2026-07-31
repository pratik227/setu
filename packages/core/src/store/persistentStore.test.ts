/**
 * The property the whole persistence story rests on: a second store opened on the
 * same account reads what the first one wrote, and one opened on a different
 * account reads nothing.
 *
 * The conformance suite already holds `DexieEventStore` to every storage rule, but
 * it disposes of each database as it goes — it never reopens one, which is exactly
 * what a page reload does.
 */

import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { microtaskScheduler } from "../internal/scheduler";
import { hex, makeEvent, PUBKEYS } from "../testing/fixtures";
import { accountDatabaseName, DexieEventStore } from "./dexieStore";
import { createPersistentStore } from "./persistentStore";

describe("createPersistentStore", () => {
  it("survives a reload: a reopened store already holds the events", async () => {
    const note = makeEvent({ id: hex("persisted"), pubkey: PUBKEYS.bob });
    const first = createPersistentStore({
      accountPubkey: PUBKEYS.alice,
      scheduler: microtaskScheduler,
    });
    expect(await first.put(note, "wss://one")).toBe(true);
    first.close();

    // A different instance on the same account, as a reload produces.
    const second = createPersistentStore({
      accountPubkey: PUBKEYS.alice,
      scheduler: microtaskScheduler,
    });
    const stored = await second.get(note.id);
    expect(stored?.event.content).toBe(note.content);
    // Provenance survives too, so the outbox router does not have to relearn where
    // an event came from.
    expect(stored?.provenance.relays).toEqual(["wss://one"]);
    expect(await second.count({ kinds: [1] })).toBe(1);
    expect(second.isDegraded).toBe(false);

    // An observer registered on the reopened store fires with the persisted rows
    // immediately — the feed is populated before any relay answers.
    const firstEmission = await new Promise<number>((resolve) => {
      second.observe({ kinds: [1] }, (events) => resolve(events.length));
    });
    expect(firstEmission).toBe(1);
    second.close();
    await new DexieEventStore({ accountPubkey: PUBKEYS.alice }).destroy();
  });

  it("keeps accounts apart", async () => {
    const alice = createPersistentStore({ accountPubkey: PUBKEYS.alice });
    const bob = createPersistentStore({ accountPubkey: PUBKEYS.bob });
    try {
      const note = makeEvent({ id: hex("alice-only") });
      await alice.put(note);
      // Two accounts on one device must never see each other's events.
      expect(await bob.get(note.id)).toBeUndefined();
      expect(await bob.count({})).toBe(0);
      expect(accountDatabaseName(PUBKEYS.alice)).not.toBe(
        accountDatabaseName(PUBKEYS.bob),
      );
    } finally {
      alice.close();
      bob.close();
      await new DexieEventStore({ accountPubkey: PUBKEYS.alice }).destroy();
      await new DexieEventStore({ accountPubkey: PUBKEYS.bob }).destroy();
    }
  });

  it("degrades to memory when the environment has no IndexedDB", async () => {
    const onFallback = vi.fn();
    const store = createPersistentStore({
      accountPubkey: PUBKEYS.alice,
      databaseName: "setu-no-indexeddb",
      onFallback,
      // What a Firefox private window, a sandboxed frame, or storage disabled by
      // policy looks like from here: an `indexedDB` that is present but refuses.
      environment: {
        indexedDB: {
          open: () => {
            throw new Error("SecurityError: storage is disabled");
          },
        },
        IDBKeyRange: {},
      },
    });
    const note = makeEvent({ id: hex("degraded") });
    // The app keeps working; it just will not survive a reload.
    expect(await store.put(note)).toBe(true);
    expect(await store.get(note.id)).toBeDefined();
    expect(store.isDegraded).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
    store.close();
  });
});
