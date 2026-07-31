import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  bookmarkedIds,
  editBookmarkList,
  isBookmarked,
  isPlausibleBookmarkWrite,
} from "./bookmarkList";

const ME = "0".repeat(64);
const NOTE_A = "a".repeat(64);
const NOTE_B = "b".repeat(64);
const NOTE_C = "c".repeat(64);
const ARTICLE = `30023:${"d".repeat(64)}:my-article`;

/** The encrypted blob NIP-51 puts private bookmarks in. */
const PRIVATE_CONTENT = "nip04-ciphertext?iv=abcdef==";

function bookmarks(tags: string[][], content = PRIVATE_CONTENT): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: ME,
    created_at: 1000,
    kind: 10003,
    tags,
    content,
    sig: "0".repeat(128),
  };
}

const eTags = (tags: readonly (readonly string[])[]) =>
  tags.filter((t) => t[0] === "e").map((t) => t[1]);

describe("isBookmarked / bookmarkedIds", () => {
  it("reads e tags and dedupes", () => {
    const event = bookmarks([
      ["e", NOTE_A],
      ["e", NOTE_B],
      ["e", NOTE_A],
    ]);
    expect(isBookmarked(event, NOTE_A)).toBe(true);
    expect(isBookmarked(event, NOTE_C)).toBe(false);
    expect(bookmarkedIds(event)).toEqual([NOTE_A, NOTE_B]);
  });

  it("treats a missing event as no bookmarks", () => {
    expect(isBookmarked(undefined, NOTE_A)).toBe(false);
    expect(bookmarkedIds(undefined)).toEqual([]);
  });
});

describe("editBookmarkList — refusals", () => {
  it("refuses to create a list when absence is not confirmed", () => {
    // The destructive case: we failed to fetch, so we cannot know the account has
    // no list. Writing here replaces a real list with one entry.
    expect(
      editBookmarkList({
        current: undefined,
        absenceConfirmed: false,
        target: NOTE_A,
        action: "add",
      }),
    ).toEqual({ ok: false, reason: "unverified-absence" });
  });

  it("creates a first list once absence is confirmed", () => {
    const result = editBookmarkList({
      current: undefined,
      absenceConfirmed: true,
      target: NOTE_A,
      action: "add",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(eTags(result.template.tags ?? [])).toEqual([NOTE_A]);
    expect(result.template.content).toBe("");
  });

  it("refuses a no-op in either direction", () => {
    const current = bookmarks([["e", NOTE_A]]);
    expect(
      editBookmarkList({
        current,
        absenceConfirmed: true,
        target: NOTE_A,
        action: "add",
      }),
    ).toEqual({ ok: false, reason: "no-change" });
    expect(
      editBookmarkList({
        current,
        absenceConfirmed: true,
        target: NOTE_B,
        action: "remove",
      }),
    ).toEqual({ ok: false, reason: "no-change" });
  });
});

describe("editBookmarkList — preservation", () => {
  it("preserves the encrypted private bookmarks in content", () => {
    // Blanking this destroys every private bookmark, with no way to restore it.
    const result = editBookmarkList({
      current: bookmarks([["e", NOTE_A]]),
      absenceConfirmed: true,
      target: NOTE_B,
      action: "add",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.content).toBe(PRIVATE_CONTENT);
  });

  it("preserves bookmarked articles, hashtags and links", () => {
    const current = bookmarks([
      ["e", NOTE_A],
      ["a", ARTICLE],
      ["t", "nostr"],
      ["r", "https://example.com/read"],
    ]);
    const result = editBookmarkList({
      current,
      absenceConfirmed: true,
      target: NOTE_B,
      action: "add",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([
      ["e", NOTE_A],
      ["a", ARTICLE],
      ["t", "nostr"],
      ["r", "https://example.com/read"],
      ["e", NOTE_B],
    ]);
  });

  it("preserves relay hints on existing entries", () => {
    const current = bookmarks([["e", NOTE_A, "wss://hint.example"]]);
    const result = editBookmarkList({
      current,
      absenceConfirmed: true,
      target: NOTE_B,
      action: "add",
      relayHint: "wss://new.example",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([
      ["e", NOTE_A, "wss://hint.example"],
      ["e", NOTE_B, "wss://new.example"],
    ]);
  });

  it("keeps every other bookmark when removing one", () => {
    const current = bookmarks([
      ["e", NOTE_A, "wss://hint.example"],
      ["e", NOTE_B],
      ["a", ARTICLE],
    ]);
    const result = editBookmarkList({
      current,
      absenceConfirmed: true,
      target: NOTE_B,
      action: "remove",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([
      ["e", NOTE_A, "wss://hint.example"],
      ["a", ARTICLE],
    ]);
  });

  it("removes every duplicate entry for the removed id", () => {
    // Removing only the first leaves the note still bookmarked.
    const current = bookmarks([
      ["e", NOTE_A],
      ["e", NOTE_B],
      ["e", NOTE_A, "wss://dup.example"],
    ]);
    const result = editBookmarkList({
      current,
      absenceConfirmed: true,
      target: NOTE_A,
      action: "remove",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(eTags(result.template.tags ?? [])).toEqual([NOTE_B]);
  });

  it("does not mutate the event it was given", () => {
    const current = bookmarks([["e", NOTE_A]]);
    const snapshot = JSON.stringify(current);
    editBookmarkList({
      current,
      absenceConfirmed: true,
      target: NOTE_B,
      action: "add",
    });
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  it("emits kind 10003", () => {
    const result = editBookmarkList({
      current: undefined,
      absenceConfirmed: true,
      target: NOTE_A,
      action: "add",
    });
    expect(result.ok && result.template.kind).toBe(10003);
  });
});

describe("isPlausibleBookmarkWrite", () => {
  it("accepts a write that moves the count by one", () => {
    const before = bookmarks([
      ["e", NOTE_A],
      ["e", NOTE_B],
    ]);
    const added = editBookmarkList({
      current: before,
      absenceConfirmed: true,
      target: NOTE_C,
      action: "add",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(isPlausibleBookmarkWrite(before, added.template)).toBe(true);
  });

  it("accepts a genuine first bookmark", () => {
    expect(
      isPlausibleBookmarkWrite(undefined, {
        kind: 10003,
        content: "",
        tags: [["e", NOTE_A]],
      }),
    ).toBe(true);
  });

  it("rejects a write that truncates a large list", () => {
    const many = bookmarks(
      Array.from({ length: 300 }, (_, i) => [
        "e",
        i.toString(16).padStart(64, "0"),
      ]),
    );
    expect(
      isPlausibleBookmarkWrite(many, {
        kind: 10003,
        content: PRIVATE_CONTENT,
        tags: [["e", NOTE_A]],
      }),
    ).toBe(false);
  });

  it("rejects a write that drops bookmarked articles or links", () => {
    // The note count moves by exactly one, so the count check alone passes.
    const before = bookmarks([
      ["e", NOTE_A],
      ["a", ARTICLE],
      ["r", "https://example.com/read"],
    ]);
    expect(
      isPlausibleBookmarkWrite(before, {
        kind: 10003,
        content: PRIVATE_CONTENT,
        tags: [
          ["e", NOTE_A],
          ["e", NOTE_B],
        ],
      }),
    ).toBe(false);
  });

  it("rejects a write that blanks the private bookmarks", () => {
    const before = bookmarks([["e", NOTE_A]]);
    expect(
      isPlausibleBookmarkWrite(before, {
        kind: 10003,
        content: "",
        tags: [
          ["e", NOTE_A],
          ["e", NOTE_B],
        ],
      }),
    ).toBe(false);
  });
});
