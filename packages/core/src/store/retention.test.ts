/**
 * The eviction rules, tested from the direction that matters: every assertion
 * about something being *kept* is an assertion that this cache cannot destroy the
 * only copy of a user's data.
 */

import "fake-indexeddb/auto";
import type { NostrEvent, Timestamp } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../contracts";
import { microtaskScheduler } from "../internal/scheduler";
import { hex, makeEvent, PUBKEYS } from "../testing/fixtures";
import { DexieEventStore } from "./dexieStore";
import {
  DEFAULT_RETENTION_SECONDS,
  defaultRetentionPolicy,
  isEvictable,
  type RetentionPolicy,
} from "./retention";

const CUTOFF = 1_000_000;

function stored(
  event: NostrEvent,
  firstSeen: Timestamp = event.created_at,
): StoredEvent {
  return {
    event,
    provenance: { relays: ["wss://one"], firstSeen },
    ...(event.tags.some((tag) => tag[0] === "-")
      ? { protected: true as const }
      : {}),
  };
}

const policy = defaultRetentionPolicy({ accountPubkey: PUBKEYS.alice });

/** An old note by someone other than us — the one thing eviction is for. */
function oldNote(overrides: Parameters<typeof makeEvent>[0] = {}): StoredEvent {
  return stored(
    makeEvent({
      pubkey: PUBKEYS.bob,
      created_at: CUTOFF - 1,
      ...overrides,
    }),
  );
}

describe("isEvictable", () => {
  it("evicts an old note by someone else", () => {
    expect(isEvictable(oldNote(), CUTOFF, policy)).toBe(true);
  });

  it("keeps anything younger than the horizon", () => {
    expect(
      isEvictable(
        stored(makeEvent({ pubkey: PUBKEYS.bob, created_at: CUTOFF })),
        CUTOFF,
        policy,
      ),
    ).toBe(false);
  });

  it("keeps an old event we only just fetched", () => {
    // `created_at` is author-supplied: a three-year-old note can have arrived a
    // minute ago and be on screen right now.
    const event = makeEvent({
      pubkey: PUBKEYS.bob,
      created_at: CUTOFF - 5_000,
    });
    expect(isEvictable(stored(event, CUTOFF + 10), CUTOFF, policy)).toBe(false);
  });

  it("keeps our own events whatever their kind or age", () => {
    for (const kind of [1, 6, 7, 9735]) {
      const event = makeEvent({
        pubkey: PUBKEYS.alice,
        kind,
        created_at: CUTOFF - 1,
      });
      expect(isEvictable(stored(event), CUTOFF, policy)).toBe(false);
    }
  });

  it("keeps private messages, which may exist nowhere else", () => {
    for (const kind of [4, 13, 14, 15, 1059]) {
      expect(isEvictable(oldNote({ kind }), CUTOFF, policy)).toBe(false);
    }
  });

  it("keeps replaceable and addressable kinds", () => {
    // Follow list, profile, relay list, mute list, bookmarks, articles: dropping
    // one and reading an older version back from a relay silently loses edits.
    for (const kind of [0, 3, 10000, 10002, 10003, 30023, 30078]) {
      expect(isEvictable(oldNote({ kind }), CUTOFF, policy)).toBe(false);
    }
  });

  it("keeps NIP-70 protected events, which only their author may republish", () => {
    expect(isEvictable(oldNote({ tags: [["-"]] }), CUTOFF, policy)).toBe(false);
  });

  it("keeps kinds outside the allowlist by default", () => {
    // Default-deny: an unfamiliar kind is one whose recoverability we cannot judge.
    expect(isEvictable(oldNote({ kind: 31_337 }), CUTOFF, policy)).toBe(false);
    expect(isEvictable(oldNote({ kind: 9_802 }), CUTOFF, policy)).toBe(false);
  });

  it("defaults to a thirty-day horizon and no protected authors when signed out", () => {
    const anonymous = defaultRetentionPolicy();
    expect(anonymous.maxAgeSeconds).toBe(DEFAULT_RETENTION_SECONDS);
    expect(anonymous.keepAuthors).toEqual([]);
  });
});

describe("DexieEventStore.evictStale", () => {
  let dbSeq = 0;

  /** A store with a movable clock, on its own database. */
  function open(now: () => Timestamp): DexieEventStore {
    dbSeq += 1;
    return new DexieEventStore({
      databaseName: `setu-retention-${dbSeq}`,
      scheduler: microtaskScheduler,
      now,
    });
  }

  const strictPolicy: RetentionPolicy = {
    maxAgeSeconds: 100,
    keepAuthors: [PUBKEYS.alice],
    evictableKinds: [1],
    maxPerSweep: 100,
  };

  it("deletes only what the policy allows and wakes observers for it", async () => {
    const clock = { now: 1_000 };
    const store = open(() => clock.now);
    try {
      const theirs = makeEvent({
        id: hex("theirs"),
        pubkey: PUBKEYS.bob,
        created_at: 900,
      });
      const ours = makeEvent({
        id: hex("ours"),
        pubkey: PUBKEYS.alice,
        created_at: 900,
      });
      const follows = makeEvent({
        id: hex("follows"),
        pubkey: PUBKEYS.bob,
        kind: 3,
        created_at: 900,
      });
      await store.putAll([theirs, ours, follows]);

      const seen: number[] = [];
      store.observe({ kinds: [1] }, (events) => seen.push(events.length));
      await store.settle();
      expect(seen).toEqual([2]);

      // Nothing is old enough yet.
      expect(await store.evictStale(strictPolicy)).toBe(0);

      // Past the horizon by both clocks: authored at 900, first seen at 1_000.
      clock.now = 1_200;
      expect(await store.evictStale(strictPolicy)).toBe(1);
      expect(await store.get(theirs.id)).toBeUndefined();
      expect(await store.get(ours.id)).toBeDefined();
      expect(await store.get(follows.id)).toBeDefined();

      await store.settle();
      expect(seen).toEqual([2, 1]);
    } finally {
      await store.destroy();
    }
  });

  it("caps how many rows one sweep examines", async () => {
    const clock = { now: 10_000 };
    const store = open(() => clock.now);
    try {
      await store.putAll(
        Array.from({ length: 6 }, (_, i) =>
          makeEvent({
            id: hex(`bulk-${i}`),
            pubkey: PUBKEYS.bob,
            created_at: 100 + i,
          }),
        ),
      );
      clock.now = 20_000;
      // A sweep is a range read into memory; an unbounded one would stall the tab
      // it exists to protect.
      expect(await store.evictStale({ ...strictPolicy, maxPerSweep: 2 })).toBe(
        2,
      );
      expect(await store.count({})).toBe(4);
      expect(
        await store.evictStale({ ...strictPolicy, maxPerSweep: 100 }),
      ).toBe(4);
    } finally {
      await store.destroy();
    }
  });
});
