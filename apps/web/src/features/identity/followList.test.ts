import type { Hex32, NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  editFollowList,
  followedPubkeys,
  followManyEdit,
  followsPubkey,
  isPlausibleBulkFollow,
  isPlausibleFollowWrite,
} from "./followList";

const ME = "0".repeat(64);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

/** A relay configuration blob of the kind that lives in kind-3 `content`. */
const RELAY_CONTENT = JSON.stringify({
  "wss://relay.example.com": { read: true, write: true },
});

function contacts(tags: string[][], content = RELAY_CONTENT): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: ME,
    created_at: 1000,
    kind: 3,
    tags,
    content,
    sig: "0".repeat(128),
  };
}

const pTags = (tags: readonly (readonly string[])[]) =>
  tags.filter((t) => t[0] === "p").map((t) => t[1]);

describe("followsPubkey / followedPubkeys", () => {
  it("reads p tags and dedupes", () => {
    const event = contacts([
      ["p", ALICE],
      ["p", BOB],
      ["p", ALICE],
    ]);
    expect(followsPubkey(event, ALICE)).toBe(true);
    expect(followsPubkey(event, CAROL)).toBe(false);
    expect(followedPubkeys(event)).toEqual([ALICE, BOB]);
  });

  it("treats a missing event as following nobody", () => {
    expect(followsPubkey(undefined, ALICE)).toBe(false);
    expect(followedPubkeys(undefined)).toEqual([]);
  });
});

describe("editFollowList — refusals", () => {
  it("refuses to create a list when absence is not confirmed", () => {
    // This is the destructive case: we failed to fetch, so we cannot know the
    // account has no list. Writing here replaces a real list with one entry.
    const result = editFollowList({
      current: undefined,
      absenceConfirmed: false,
      target: ALICE,
      action: "follow",
    });
    expect(result).toEqual({ ok: false, reason: "unverified-absence" });
  });

  it("creates a first list once absence is confirmed", () => {
    const result = editFollowList({
      current: undefined,
      absenceConfirmed: true,
      target: ALICE,
      action: "follow",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pTags(result.template.tags ?? [])).toEqual([ALICE]);
    expect(result.template.content).toBe("");
  });

  it("refuses a no-op in either direction", () => {
    const following = contacts([["p", ALICE]]);
    expect(
      editFollowList({
        current: following,
        absenceConfirmed: true,
        target: ALICE,
        action: "follow",
      }),
    ).toEqual({ ok: false, reason: "no-change" });
    expect(
      editFollowList({
        current: following,
        absenceConfirmed: true,
        target: BOB,
        action: "unfollow",
      }),
    ).toEqual({ ok: false, reason: "no-change" });
  });
});

describe("editFollowList — preservation", () => {
  it("preserves the relay configuration in content", () => {
    // Blanking this field wipes the user's relay setup as a side effect of
    // following someone.
    const result = editFollowList({
      current: contacts([["p", ALICE]]),
      absenceConfirmed: true,
      target: BOB,
      action: "follow",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.content).toBe(RELAY_CONTENT);
  });

  it("preserves relay hints and petnames on existing entries", () => {
    const current = contacts([
      ["p", ALICE, "wss://alice.example", "Alice"],
      ["p", BOB, "", "Bobby"],
    ]);
    const result = editFollowList({
      current,
      absenceConfirmed: true,
      target: CAROL,
      action: "follow",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([
      ["p", ALICE, "wss://alice.example", "Alice"],
      ["p", BOB, "", "Bobby"],
      ["p", CAROL],
    ]);
  });

  it("preserves non-p tags", () => {
    const current = contacts([
      ["p", ALICE],
      ["t", "nostr"],
      ["relay", "wss://kept.example"],
    ]);
    const result = editFollowList({
      current,
      absenceConfirmed: true,
      target: BOB,
      action: "follow",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags ?? []).toContainEqual(["t", "nostr"]);
    expect(result.template.tags ?? []).toContainEqual([
      "relay",
      "wss://kept.example",
    ]);
  });

  it("keeps every other follow when unfollowing one", () => {
    const current = contacts([
      ["p", ALICE, "", "Alice"],
      ["p", BOB],
      ["p", CAROL],
    ]);
    const result = editFollowList({
      current,
      absenceConfirmed: true,
      target: BOB,
      action: "unfollow",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pTags(result.template.tags ?? [])).toEqual([ALICE, CAROL]);
    expect(result.template.tags ?? []).toContainEqual([
      "p",
      ALICE,
      "",
      "Alice",
    ]);
  });

  it("removes every duplicate entry for the unfollowed pubkey", () => {
    // Removing only the first leaves the user still following them.
    const current = contacts([
      ["p", ALICE],
      ["p", BOB],
      ["p", ALICE, "wss://dup.example"],
    ]);
    const result = editFollowList({
      current,
      absenceConfirmed: true,
      target: ALICE,
      action: "unfollow",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pTags(result.template.tags ?? [])).toEqual([BOB]);
  });

  it("does not mutate the event it was given", () => {
    const current = contacts([["p", ALICE]]);
    const snapshot = JSON.stringify(current);
    editFollowList({
      current,
      absenceConfirmed: true,
      target: BOB,
      action: "follow",
    });
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  it("emits kind 3", () => {
    const result = editFollowList({
      current: undefined,
      absenceConfirmed: true,
      target: ALICE,
      action: "follow",
    });
    expect(result.ok && result.template.kind).toBe(3);
  });
});

describe("isPlausibleFollowWrite", () => {
  it("accepts a write that moves the count by one", () => {
    const before = contacts([
      ["p", ALICE],
      ["p", BOB],
    ]);
    const added = editFollowList({
      current: before,
      absenceConfirmed: true,
      target: CAROL,
      action: "follow",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(isPlausibleFollowWrite(before, added.template)).toBe(true);
  });

  it("rejects a write that would drop a large list to almost nothing", () => {
    // The backstop for a bug upstream: no follow button produces this.
    const many = contacts(
      Array.from({ length: 400 }, (_, i) => [
        "p",
        i.toString(16).padStart(64, "0"),
      ]),
    );
    const truncated = { kind: 3, content: "", tags: [["p", ALICE]] };
    expect(isPlausibleFollowWrite(many, truncated)).toBe(false);
  });

  it("accepts a genuine first follow", () => {
    expect(
      isPlausibleFollowWrite(undefined, {
        kind: 3,
        content: "",
        tags: [["p", ALICE]],
      }),
    ).toBe(true);
  });
});

describe("followManyEdit", () => {
  const PACK = ["1".repeat(64), "2".repeat(64), "3".repeat(64)] as Hex32[];

  it("adds every new member in a single event", () => {
    // The bug a loop would produce: N events that each add one and drop the rest,
    // leaving the account following exactly one of the pack's members.
    const result = followManyEdit({
      current: undefined,
      absenceConfirmed: true,
      targets: PACK,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = (result.template.tags ?? []).filter((t) => t[0] === "p");
    expect(added).toHaveLength(3);
  });

  it("keeps existing follows and unknown tags byte-for-byte", () => {
    const current = contacts([
      ["p", "9".repeat(64)],
      ["client", "something"],
    ]);
    const result = followManyEdit({
      current,
      absenceConfirmed: true,
      targets: PACK,
    });
    if (!result.ok) throw new Error("refused");
    expect(result.template.tags ?? []).toContainEqual(["p", "9".repeat(64)]);
    expect(result.template.tags ?? []).toContainEqual(["client", "something"]);
    // kind-3 content historically carried a relay map; dropping it is data loss.
    expect(result.template.content).toBe(current.content);
  });

  it("skips members already followed", () => {
    const current = contacts([["p", PACK[0] as string]]);
    const result = followManyEdit({
      current,
      absenceConfirmed: true,
      targets: PACK,
    });
    if (!result.ok) throw new Error("refused");
    expect(
      (result.template.tags ?? []).filter((t) => t[0] === "p"),
    ).toHaveLength(3);
  });

  it("refuses when everyone is already followed", () => {
    const current = contacts(PACK.map((p) => ["p", p]));
    const result = followManyEdit({
      current,
      absenceConfirmed: true,
      targets: PACK,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("no-change");
  });

  it("refuses to create a list from an unconfirmed absence", () => {
    // Indistinguishable, afterwards, from having unfollowed everyone.
    const result = followManyEdit({
      current: undefined,
      absenceConfirmed: false,
      targets: PACK,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("unverified-absence");
  });

  it("deduplicates a pack that names someone twice", () => {
    const result = followManyEdit({
      current: undefined,
      absenceConfirmed: true,
      targets: [PACK[0] as Hex32, PACK[0] as Hex32],
    });
    if (!result.ok) throw new Error("refused");
    expect(
      (result.template.tags ?? []).filter((t) => t[0] === "p"),
    ).toHaveLength(1);
  });
});

describe("isPlausibleBulkFollow", () => {
  it("allows a large addition", () => {
    // Unlike a single follow, a pack legitimately moves the count by many.
    const current = contacts([["p", "9".repeat(64)]]);
    const result = followManyEdit({
      current,
      absenceConfirmed: true,
      targets: ["1".repeat(64), "2".repeat(64)] as Hex32[],
    });
    if (!result.ok) throw new Error("refused");
    expect(isPlausibleBulkFollow(current, result.template)).toBe(true);
  });

  it("refuses a write that would remove anybody", () => {
    // Applying a pack is purely additive; a shrinking count is a merge bug, and
    // publishing it would unfollow people the user never touched.
    const current = contacts([
      ["p", "8".repeat(64)],
      ["p", "9".repeat(64)],
    ]);
    const shrunk = {
      kind: 3,
      content: "",
      created_at: 1,
      tags: [["p", "8".repeat(64)]],
    };
    expect(isPlausibleBulkFollow(current, shrunk)).toBe(false);
  });
});
