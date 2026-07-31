import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  editFollowList,
  followedPubkeys,
  followsPubkey,
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
    expect(result.template.tags).toContainEqual(["t", "nostr"]);
    expect(result.template.tags).toContainEqual([
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
    expect(result.template.tags).toContainEqual(["p", ALICE, "", "Alice"]);
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
