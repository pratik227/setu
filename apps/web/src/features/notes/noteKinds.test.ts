import { Kind } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { isMediaFirstKind, isTitledKind, NOTE_TARGET_KINDS } from "./noteKinds";

describe("NOTE_TARGET_KINDS", () => {
  it("names every kind a reader can open as a thread", () => {
    // A kind missing here cannot be fetched by id, so a picture post opened from a
    // notification or a bookmark would resolve to nothing.
    for (const kind of [
      Kind.ShortTextNote,
      Kind.Repost,
      Kind.GenericRepost,
      Kind.Picture,
      Kind.Video,
      Kind.ShortVideo,
      Kind.Poll,
      Kind.Comment,
      Kind.Highlight,
      Kind.LongFormArticle,
    ]) {
      expect(NOTE_TARGET_KINDS).toContain(kind);
    }
  });

  it("has no duplicates, which would repeat a value in every filter", () => {
    expect(new Set(NOTE_TARGET_KINDS).size).toBe(NOTE_TARGET_KINDS.length);
  });
});

describe("isMediaFirstKind", () => {
  it("covers the kinds whose media is the post", () => {
    expect(isMediaFirstKind(Kind.Picture)).toBe(true);
    expect(isMediaFirstKind(Kind.Video)).toBe(true);
    expect(isMediaFirstKind(Kind.ShortVideo)).toBe(true);
  });

  it("leaves a text note text-first", () => {
    // A kind-1 sentence introduces its image; reordering it would put a photo above
    // the words that explain it.
    expect(isMediaFirstKind(Kind.ShortTextNote)).toBe(false);
    expect(isMediaFirstKind(Kind.Poll)).toBe(false);
  });
});

describe("isTitledKind", () => {
  it("allows a title only where the kind defines one", () => {
    expect(isTitledKind(Kind.Picture)).toBe(true);
    expect(isTitledKind(Kind.LongFormArticle)).toBe(true);
  });

  it("refuses a stray title tag on a text note", () => {
    // `title` is not reserved. A kind-1 carrying one would get a bold heading above
    // its body that its author never wrote.
    expect(isTitledKind(Kind.ShortTextNote)).toBe(false);
    expect(isTitledKind(Kind.Poll)).toBe(false);
  });
});
