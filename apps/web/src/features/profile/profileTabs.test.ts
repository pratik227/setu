import type { FeedEntry } from "@setu/core";
import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { findProfileTab, hasMedia, PROFILE_TABS } from "./profileTabs";

const AUTHOR = "a".repeat(64);

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: AUTHOR,
    created_at: 1000,
    kind: 1,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...over,
  };
}

function noteRow(over: Partial<NostrEvent> = {}): FeedEntry {
  const e = event(over);
  return {
    key: `note:${e.id}`,
    kind: "note",
    event: e,
    createdAt: e.created_at,
    reposters: [],
    repostIds: [],
  };
}

function repostRow(target: NostrEvent): FeedEntry {
  const e = event({ kind: 6, tags: [["e", target.id]] });
  return {
    key: `repost:${target.id}:1`,
    kind: "repost",
    event: e,
    createdAt: e.created_at,
    reposters: [AUTHOR],
    repostIds: [e.id],
    targetId: target.id,
    target,
  };
}

function filterFor(id: string) {
  const tab = findProfileTab(id);
  return tab.entryFilter;
}

describe("hasMedia", () => {
  it("detects an image URL in the body", () => {
    expect(hasMedia(event({ content: "look https://x.test/a.jpg" }))).toBe(
      true,
    );
  });

  it("detects a video URL in the body", () => {
    expect(hasMedia(event({ content: "https://x.test/clip.mp4" }))).toBe(true);
  });

  it("tolerates trailing punctuation around the URL", () => {
    expect(hasMedia(event({ content: "(https://x.test/a.png)" }))).toBe(true);
  });

  it("does not count a plain link as media", () => {
    expect(hasMedia(event({ content: "https://x.test/article" }))).toBe(false);
  });

  it("detects media declared in an imeta tag", () => {
    const e = event({
      content: "no links here",
      tags: [["imeta", "url https://x.test/a.webp", "m image/webp"]],
    });
    expect(hasMedia(e)).toBe(true);
  });

  it("ignores an imeta tag pointing at a non-media URL", () => {
    const e = event({
      content: "",
      tags: [["imeta", "url https://x.test/page"]],
    });
    expect(hasMedia(e)).toBe(false);
  });

  it("is false for a note with no URLs at all", () => {
    expect(hasMedia(event({ content: "just words" }))).toBe(false);
  });
});

describe("profile tab predicates", () => {
  const rootNote = noteRow({ content: "hello" });
  const replyNote = noteRow({
    id: "2".repeat(64),
    content: "answering",
    tags: [["e", "1".repeat(64), "", "root"]],
  });

  it("puts top-level notes in Notes and keeps replies out", () => {
    const notes = filterFor("notes");
    expect(notes?.(rootNote)).toBe(true);
    expect(notes?.(replyNote)).toBe(false);
  });

  it("counts a repost row as top-level despite its e tag", () => {
    const notes = filterFor("notes");
    expect(notes?.(repostRow(event({ content: "target" })))).toBe(true);
  });

  it("puts replies in Replies and keeps top-level notes out", () => {
    const replies = filterFor("replies");
    expect(replies?.(replyNote)).toBe(true);
    expect(replies?.(rootNote)).toBe(false);
  });

  it("does not file a repost under Replies", () => {
    const replies = filterFor("replies");
    expect(replies?.(repostRow(event({ content: "target" })))).toBe(false);
  });

  it("selects media rows, reading through a repost to its target", () => {
    const media = filterFor("media");
    expect(media?.(noteRow({ content: "https://x.test/a.gif" }))).toBe(true);
    expect(media?.(rootNote)).toBe(false);
    expect(media?.(repostRow(event({ content: "https://x.test/a.jpg" })))).toBe(
      true,
    );
  });

  it("leaves Reads unfiltered — the kind is the whole definition", () => {
    expect(findProfileTab("reads").entryFilter).toBeUndefined();
    expect(findProfileTab("reads").kinds).toEqual([30023]);
  });
});

describe("findProfileTab", () => {
  it("resolves each declared id", () => {
    for (const tab of PROFILE_TABS) {
      expect(findProfileTab(tab.id).id).toBe(tab.id);
    }
  });

  it("falls back to the first tab for an unknown id", () => {
    expect(findProfileTab("nonsense").id).toBe("notes");
  });
});
