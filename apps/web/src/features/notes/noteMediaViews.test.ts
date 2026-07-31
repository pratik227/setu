import { describe, expect, it } from "vitest";
import { noteMediaViews, reservedAspectRatio } from "./noteMediaViews";

const note = (
  content: string,
  tags: readonly (readonly string[])[] = [],
): { content: string; tags: readonly (readonly string[])[] } => ({
  content,
  tags,
});

describe("noteMediaViews", () => {
  it("is undefined for a note with no media", () => {
    // Undefined rather than an empty array: a text-only note carries no field at
    // all, and a caller can still tell "no media" from "not resolved yet".
    expect(noteMediaViews(note("just words"))).toBeUndefined();
    expect(noteMediaViews(note("a link https://example.com/page"))).toBe(
      undefined,
    );
  });

  it("takes body images in the order the reader sees them", () => {
    const media = noteMediaViews(
      note("one https://x.test/1.png two https://x.test/2.jpg"),
    );
    expect(media?.map((item) => item.url)).toEqual([
      "https://x.test/1.png",
      "https://x.test/2.jpg",
    ]);
    expect(media?.every((item) => item.kind === "image")).toBe(true);
  });

  it("decorates a body image with the dimensions its imeta declares", () => {
    // The whole point: the size has to reach the renderer, or the box cannot be
    // reserved and the timeline jumps when the image decodes.
    const media = noteMediaViews(
      note("look https://x.test/a.png", [
        ["imeta", "url https://x.test/a.png", "dim 1200x800", "alt a chart"],
      ]),
    );
    expect(media).toEqual([
      {
        url: "https://x.test/a.png",
        kind: "image",
        width: 1200,
        height: 800,
        alt: "a chart",
      },
    ]);
  });

  it("leaves the size off when the declared dim is unusable", () => {
    const media = noteMediaViews(
      note("https://x.test/a.png", [
        ["imeta", "url https://x.test/a.png", "dim 0x0"],
      ]),
    );
    expect(media?.[0]).toEqual({ url: "https://x.test/a.png", kind: "image" });
  });

  it("keeps an imeta attachment the body never linked", () => {
    const media = noteMediaViews(
      note("caption only", [
        ["imeta", "url https://x.test/a.webp", "m image/webp", "dim 10x10"],
      ]),
    );
    expect(media).toEqual([
      { url: "https://x.test/a.webp", kind: "image", width: 10, height: 10 },
    ]);
  });

  it("classifies an extensionless url by its declared mime type", () => {
    // Opaque upload URLs are the norm, and `m` is the only thing that separates a
    // video from an image there — a video in an `<img>` renders a broken icon.
    const media = noteMediaViews(
      note("", [["imeta", "url https://x.test/files/9f3a", "m video/mp4"]]),
    );
    expect(media).toEqual([
      { url: "https://x.test/files/9f3a", kind: "video" },
    ]);
  });

  it("ignores an imeta row that describes neither an image nor a video", () => {
    expect(
      noteMediaViews(
        note("", [["imeta", "url https://x.test/page", "m text/html"]]),
      ),
    ).toBeUndefined();
  });

  it("refuses an imeta url outside the image-source allowlist", () => {
    // An `imeta` URL is raw author text on its way into a `src` attribute.
    expect(
      noteMediaViews(note("", [["imeta", "url javascript:alert(1)"]])),
    ).toBeUndefined();
    expect(
      noteMediaViews(
        note("", [
          ["imeta", "url data:image/svg+xml,<svg onload=alert(1)>", "dim 1x1"],
        ]),
      ),
    ).toBeUndefined();
  });

  it("does not show one url twice", () => {
    const media = noteMediaViews(
      note("https://x.test/a.png again https://x.test/a.png", [
        ["imeta", "url https://x.test/a.png", "dim 4x3"],
      ]),
    );
    expect(media).toHaveLength(1);
  });

  it("does not let a declaration for one url size another", () => {
    const media = noteMediaViews(
      note("https://x.test/a.png https://x.test/b.png", [
        ["imeta", "url https://x.test/b.png", "dim 4x3"],
      ]),
    );
    expect(media?.[0]?.width).toBeUndefined();
    expect(media?.[1]?.width).toBe(4);
  });
});

describe("reservedAspectRatio", () => {
  it("reserves nothing when the author declared no size", () => {
    // A guessed ratio jumps exactly as much as no box at all, and crops as well.
    expect(
      reservedAspectRatio({ url: "https://x.test/a.png", kind: "image" }),
    ).toBeUndefined();
  });

  it("uses a declared ratio as-is when it is a real shape", () => {
    expect(
      reservedAspectRatio({
        url: "u",
        kind: "image",
        width: 1200,
        height: 800,
      }),
    ).toBeCloseTo(1.5);
    // 9:16, the commonest portrait shape, must survive the clamp untouched.
    expect(
      reservedAspectRatio({
        url: "u",
        kind: "image",
        width: 1080,
        height: 1920,
      }),
    ).toBeCloseTo(0.5625);
  });

  it("clamps a shape that would own the page", () => {
    // `1x99999` is syntactically perfect and a box ten thousand screens tall.
    expect(
      reservedAspectRatio({ url: "u", kind: "image", width: 1, height: 99999 }),
    ).toBe(0.5);
  });

  it("clamps a shape that would collapse to a line", () => {
    // The mirror image: a box a fraction of a pixel high reads as a failed load.
    expect(
      reservedAspectRatio({ url: "u", kind: "image", width: 99999, height: 1 }),
    ).toBe(3);
  });

  it("reserves nothing for a half-declared or sub-pixel size", () => {
    expect(
      reservedAspectRatio({ url: "u", kind: "image", width: 100 }),
    ).toBeUndefined();
    expect(
      reservedAspectRatio({ url: "u", kind: "image", height: 100 }),
    ).toBeUndefined();
    expect(
      reservedAspectRatio({ url: "u", kind: "image", width: 0, height: 0 }),
    ).toBeUndefined();
  });
});
