import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotificationItem } from "./groupNotifications";
import {
  clearNotificationsRead,
  countUnread,
  lastSeenKey,
  markNotificationsRead,
  nextWatermark,
  readLastSeen,
  resetReadStateCache,
  seedLastSeen,
  subscribeReadState,
} from "./readState";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function item(createdAt: number, key = `k${createdAt}`): NotificationItem {
  return {
    key,
    kind: "reaction",
    targetUnavailable: false,
    targetIsMine: true,
    actors: [{ createdAt, attribution: "signed", eventId: key }],
    createdAt,
    allLikes: true,
  };
}

/** Minimal `localStorage`, so the key scheme and persistence are real here. */
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  const stub = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
    clear: () => backing.clear(),
    key: (index: number) => [...backing.keys()][index] ?? null,
    get length() {
      return backing.size;
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = stub;
  return backing;
}

describe("countUnread — the first-run rule", () => {
  it("reports zero when no watermark has ever been recorded", () => {
    // "We have never recorded what you saw" is not the same claim as "you have
    // seen none of this". Only the first is true on a fresh install, so a year of
    // history must not arrive as 99+ unread.
    expect(countUnread([item(9000), item(8000), item(7000)], undefined)).toBe(
      0,
    );
  });

  it("counts only rows strictly newer than the watermark", () => {
    const items = [item(3000), item(2000), item(1000)];
    expect(countUnread(items, 1500)).toBe(2);
  });

  it("treats a row exactly at the watermark as read", () => {
    // Marking read *through* T must not leave the row that happened at T unread
    // forever, which is what an inclusive comparison would do.
    expect(countUnread([item(2000)], 2000)).toBe(0);
  });

  it("counts nothing for an empty list, at any watermark", () => {
    expect(countUnread([], undefined)).toBe(0);
    expect(countUnread([], 0)).toBe(0);
    expect(countUnread([], 5000)).toBe(0);
  });

  it("counts every row when the watermark predates all of them", () => {
    expect(countUnread([item(3000), item(2000)], 1)).toBe(2);
  });
});

describe("nextWatermark — monotonicity", () => {
  it("adopts the first value when nothing is stored", () => {
    expect(nextWatermark(undefined, 1000)).toBe(1000);
  });

  it("moves forward", () => {
    expect(nextWatermark(1000, 2000)).toBe(2000);
  });

  it("never moves backward", () => {
    // A stale component, or a second tab that loaded earlier, must not resurrect
    // rows the reader already dismissed.
    expect(nextWatermark(2000, 1000)).toBe(2000);
  });

  it("is idempotent", () => {
    expect(nextWatermark(2000, 2000)).toBe(2000);
  });
});

describe("lastSeenKey", () => {
  it("namespaces per account", () => {
    expect(lastSeenKey(ALICE)).toBe(`setu:notifications:lastSeen:${ALICE}`);
    expect(lastSeenKey(ALICE)).not.toBe(lastSeenKey(BOB));
  });
});

describe("persistence", () => {
  let backing: Map<string, string>;

  beforeEach(() => {
    backing = installStorage();
    resetReadStateCache();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    resetReadStateCache();
  });

  it("reports no watermark before anything is written", () => {
    expect(readLastSeen(ALICE)).toBeUndefined();
  });

  it("seeds once and then leaves the watermark alone", () => {
    expect(seedLastSeen(ALICE, 1000)).toBe(1000);
    expect(seedLastSeen(ALICE, 5000)).toBe(1000);
    expect(readLastSeen(ALICE)).toBe(1000);
  });

  it("writes the seconds value under the documented key", () => {
    seedLastSeen(ALICE, 1234);
    expect(backing.get(`setu:notifications:lastSeen:${ALICE}`)).toBe("1234");
  });

  it("keeps accounts independent", () => {
    seedLastSeen(ALICE, 1000);
    markNotificationsRead(ALICE, 4000);
    expect(readLastSeen(BOB)).toBeUndefined();
  });

  it("marks read forward but not backward", () => {
    markNotificationsRead(ALICE, 2000);
    markNotificationsRead(ALICE, 1000);
    expect(readLastSeen(ALICE)).toBe(2000);
  });

  it("notifies subscribers when a watermark moves", () => {
    let calls = 0;
    const unsubscribe = subscribeReadState(() => {
      calls += 1;
    });
    markNotificationsRead(ALICE, 2000);
    // A no-op write must not notify, or the badge re-renders on every mount.
    markNotificationsRead(ALICE, 2000);
    unsubscribe();
    expect(calls).toBe(1);
  });

  it("treats a corrupt stored value as absent, not as zero", () => {
    backing.set(`setu:notifications:lastSeen:${ALICE}`, "not-a-number");
    resetReadStateCache();
    // Zero would make every notification ever held count as unread, which is the
    // outcome the first-run rule exists to prevent.
    expect(readLastSeen(ALICE)).toBeUndefined();
    expect(countUnread([item(1)], readLastSeen(ALICE))).toBe(0);
  });

  it("survives storage being unavailable", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    resetReadStateCache();
    expect(readLastSeen(ALICE)).toBeUndefined();
    expect(() => markNotificationsRead(ALICE, 1000)).not.toThrow();
    // The in-memory mirror still answers for this tab; it just is not remembered.
    expect(readLastSeen(ALICE)).toBe(1000);
  });
});

describe("clearNotificationsRead — sign-out", () => {
  let backing: Map<string, string>;

  beforeEach(() => {
    backing = installStorage();
    resetReadStateCache();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    resetReadStateCache();
  });

  it("removes the watermark rather than zeroing it", () => {
    // Zero is a *valid* watermark meaning "seen nothing", so writing it would mark a
    // year of history unread. Absent is the state the first-run rule is written for.
    seedLastSeen(ALICE, 1000);
    clearNotificationsRead(ALICE);
    expect(backing.has(`setu:notifications:lastSeen:${ALICE}`)).toBe(false);
    expect(readLastSeen(ALICE)).toBeUndefined();
    expect(countUnread([item(1), item(2)], readLastSeen(ALICE))).toBe(0);
  });

  it("clears the in-memory mirror too", () => {
    // The mirror is what the badge reads. Leaving it behind would keep showing the
    // signed-out account's count until something unrelated re-rendered.
    seedLastSeen(ALICE, 1000);
    backing.clear();
    clearNotificationsRead(ALICE);
    expect(readLastSeen(ALICE)).toBeUndefined();
  });

  it("touches only the named account", () => {
    seedLastSeen(ALICE, 1000);
    seedLastSeen(BOB, 2000);
    clearNotificationsRead(ALICE);
    expect(readLastSeen(BOB)).toBe(2000);
  });

  it("notifies subscribers, and does nothing without a pubkey", () => {
    seedLastSeen(ALICE, 1000);
    let calls = 0;
    const unsubscribe = subscribeReadState(() => {
      calls += 1;
    });
    clearNotificationsRead(undefined);
    expect(calls).toBe(0);
    clearNotificationsRead(ALICE);
    unsubscribe();
    expect(calls).toBe(1);
  });
});
