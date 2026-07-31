import { describe, expect, it } from "vitest";
import { Kind } from "./kinds";
import { isVideoKind, parseVideo } from "./nip71";
import type { NostrEvent } from "./types";

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: "a".repeat(64),
    created_at: 1000,
    kind: Kind.Video,
    tags: [
      ["title", "A talk"],
      [
        "imeta",
        "url https://x.test/a.mp4",
        "m video/mp4",
        "dim 1920x1080",
        "image https://x.test/poster.jpg",
      ],
      ["duration", "185"],
    ],
    content: "recorded last week",
    sig: "0".repeat(128),
    ...over,
  };
}

describe("isVideoKind", () => {
  it("covers both NIP-71 kinds and nothing else", () => {
    expect(isVideoKind(Kind.Video)).toBe(true);
    expect(isVideoKind(Kind.ShortVideo)).toBe(true);
    expect(isVideoKind(Kind.Picture)).toBe(false);
    expect(isVideoKind(Kind.ShortTextNote)).toBe(false);
  });
});

describe("parseVideo", () => {
  it("reads the title, description, primary variant and duration", () => {
    const parsed = parseVideo(event());
    expect(parsed?.title).toBe("A talk");
    expect(parsed?.description).toBe("recorded last week");
    expect(parsed?.primary.url).toBe("https://x.test/a.mp4");
    expect(parsed?.durationSeconds).toBe(185);
    expect(parsed?.short).toBe(false);
  });

  it("carries the poster frame off the imeta row", () => {
    // The only thing that lets a tile show anything before the reader presses play.
    expect(parseVideo(event())?.primary.image).toBe(
      "https://x.test/poster.jpg",
    );
  });

  it("marks kind 22 as short", () => {
    expect(parseVideo(event({ kind: Kind.ShortVideo }))?.short).toBe(true);
  });

  it("names the first row as primary and keeps the rest as variants", () => {
    // Several rows on one video event are usually the same film at different
    // resolutions; playing all of them would stack four copies in one row.
    const parsed = parseVideo(
      event({
        tags: [
          ["imeta", "url https://x.test/1080.mp4"],
          ["imeta", "url https://x.test/480.mp4"],
        ],
      }),
    );
    expect(parsed?.primary.url).toBe("https://x.test/1080.mp4");
    expect(parsed?.variants).toHaveLength(2);
  });

  it("ignores a duration that is not a number", () => {
    // `Number("2 min")` is NaN, which formats as "NaN:NaN" next to the play button.
    const parsed = parseVideo(
      event({
        tags: [
          ["imeta", "url https://x.test/a.mp4"],
          ["duration", "2 min"],
        ],
      }),
    );
    expect(parsed?.durationSeconds).toBeUndefined();
  });

  it("rejects a video event with no usable imeta row", () => {
    expect(parseVideo(event({ tags: [["title", "Nothing"]] }))).toBeUndefined();
  });

  it("rejects an event of another kind", () => {
    expect(parseVideo(event({ kind: Kind.ShortTextNote }))).toBeUndefined();
  });
});
