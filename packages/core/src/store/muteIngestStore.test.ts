import type { Hex32, NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../contracts";
import { FallbackEventStore } from "./fallbackStore";
import { MemoryEventStore } from "./memoryStore";
import { muteRulesFrom, NO_MUTES } from "./muteFilter";
import { supportsMuteIngest } from "./muteIngest";

/**
 * The store end of the mute list: what a rule actually refuses on the write path.
 *
 * `muteIngest.test.ts` covers the decision. This covers the wiring, which is where
 * the feature had been sitting unused — `MuteIngestPolicy` was exported, tested and
 * constructed by nobody, so every muted account's reactions were still being stored.
 */

const ALICE = "a".repeat(64) as Hex32;
const BOB = "b".repeat(64) as Hex32;

let counter = 0;
function event(over: Partial<NostrEvent> = {}): NostrEvent {
  counter += 1;
  return {
    id: `${counter}`.padStart(64, "0"),
    pubkey: over.pubkey ?? BOB,
    created_at: 1_700_000_000 + counter,
    kind: over.kind ?? 7,
    tags: over.tags ?? [],
    content: over.content ?? "+",
    sig: "0".repeat(128),
  };
}

const mutedBob = muteRulesFrom([["p", BOB]]);

describe("MemoryEventStore mute ingest", () => {
  it("refuses a muted author's reaction and does not store it", async () => {
    const store = new MemoryEventStore();
    store.setMuteRules(mutedBob);
    const reaction = event({ kind: 7 });

    expect(await store.put(reaction)).toBe(false);
    expect(await store.get(reaction.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("still stores a muted author's note", async () => {
    // The decision that keeps threads intact: refusing a kind 1 would orphan every
    // reply below it, and un-muting could never bring it back.
    const store = new MemoryEventStore();
    store.setMuteRules(mutedBob);
    const note = event({ kind: 1, content: "hello" });

    expect(await store.put(note)).toBe(true);
    expect(await store.get(note.id)).toBeDefined();
  });

  it("never refuses the reader's own reaction", async () => {
    // A self-mute is writable from another client. Refusing here would leave the row
    // offering to react a second time to something this account already reacted to.
    const store = new MemoryEventStore();
    store.setMuteRules(muteRulesFrom([["p", ALICE]]), ALICE);
    const own = event({ kind: 7, pubkey: ALICE });

    expect(await store.put(own)).toBe(true);
  });

  it("applies to putAll, not only put", async () => {
    const store = new MemoryEventStore();
    store.setMuteRules(mutedBob);
    const accepted = await store.putAll([
      event({ kind: 7 }),
      event({ kind: 7 }),
      event({ kind: 1, content: "kept" }),
      event({ kind: 7, pubkey: ALICE }),
    ]);

    // The note and Alice's reaction; both of Bob's reactions refused.
    expect(accepted).toBe(2);
    expect(store.size).toBe(2);
  });

  it("is forward-looking: muting does not evict what is already held", async () => {
    // The whole reason ingest refusal is limited to countable kinds. A mute is a
    // reading preference, and one that deletes data is a different feature.
    const store = new MemoryEventStore();
    const reaction = event({ kind: 7 });
    await store.put(reaction);

    store.setMuteRules(mutedBob);

    expect(await store.get(reaction.id)).toBeDefined();
    expect(store.size).toBe(1);
  });

  it("un-muting starts accepting again", async () => {
    const store = new MemoryEventStore();
    store.setMuteRules(mutedBob);
    expect(await store.put(event({ kind: 7 }))).toBe(false);

    store.setMuteRules(NO_MUTES);
    expect(await store.put(event({ kind: 7 }))).toBe(true);
  });

  it("accepts everything with no rules set", async () => {
    const store = new MemoryEventStore();
    expect(await store.put(event({ kind: 7 }))).toBe(true);
  });
});

describe("FallbackEventStore mute ingest", () => {
  it("forwards the rules to the active store", async () => {
    const store = new FallbackEventStore({
      createPrimary: () => new MemoryEventStore(),
      createFallback: () => new MemoryEventStore(),
    });
    store.setMuteRules(mutedBob);

    expect(await store.put(event({ kind: 7 }))).toBe(false);
    expect(await store.put(event({ kind: 1, content: "kept" }))).toBe(true);
  });

  it("replays the rules onto a fallback built after they were set", async () => {
    // The bug this guards: the fallback is constructed lazily, at the moment
    // persistence fails, which is long after the app said what is muted. Without
    // the replay, a browser that lost IndexedDB mid-session silently stops
    // enforcing mutes — the one moment nobody is watching for it.
    let failNext = true;
    const store = new FallbackEventStore({
      createPrimary: () =>
        ({
          put: () => {
            if (failNext) return Promise.reject(new Error("quota"));
            return Promise.resolve(true);
          },
          observe: () => () => {},
        }) as unknown as EventStore,
      createFallback: () => new MemoryEventStore(),
    });

    store.setMuteRules(mutedBob);
    // Degrades on this write, then retries it against the fresh fallback — which
    // must already know about the mute.
    expect(await store.put(event({ kind: 7 }))).toBe(false);
    expect(store.isDegraded).toBe(true);

    failNext = false;
    expect(await store.put(event({ kind: 7 }))).toBe(false);
    expect(await store.put(event({ kind: 1, content: "kept" }))).toBe(true);
  });

  it("tolerates an active store with no mute support", () => {
    // `setMuteRules` is a capability, not part of EventStore. A store without it
    // must not make the call throw.
    const plain = {
      put: () => Promise.resolve(true),
      observe: () => () => {},
    } as unknown as EventStore;
    const store = new FallbackEventStore({
      createPrimary: () => plain,
      createFallback: () => new MemoryEventStore(),
    });

    expect(() => store.setMuteRules(mutedBob)).not.toThrow();
    expect(supportsMuteIngest(plain)).toBe(false);
  });
});

describe("supportsMuteIngest", () => {
  it("detects the capability rather than assuming it", () => {
    expect(supportsMuteIngest(new MemoryEventStore())).toBe(true);
    expect(supportsMuteIngest({})).toBe(false);
    expect(supportsMuteIngest({ setMuteRules: "not a function" })).toBe(false);
  });
});
