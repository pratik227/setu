import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoteMedia } from "./NoteMedia";
import type { MediaView } from "./types";

/**
 * Render-level proof that the box is actually reserved.
 *
 * `noteMediaViews.test.ts` asserts the numbers; this asserts the markup the
 * reader's browser receives, because a correct ratio that never reaches a `style`
 * attribute reserves nothing and the timeline still jumps.
 */
const render = (media: readonly MediaView[]): string =>
  renderToStaticMarkup(<NoteMedia media={media} />);

const image = (over: Partial<MediaView> = {}): MediaView => ({
  url: "https://x.test/a.png",
  kind: "image",
  ...over,
});

describe("NoteMedia", () => {
  it("reserves an aspect-ratio box for a declared size", () => {
    const html = render([image({ width: 1200, height: 800 })]);
    expect(html).toContain("aspect-ratio:1.5");
  });

  it("reserves nothing when the author declared no size", () => {
    // The old behaviour, unchanged: a guessed ratio jumps as much as no box and
    // crops as well.
    expect(render([image()])).not.toContain("aspect-ratio");
  });

  it("fills the reserved box, so decoding cannot resize it", () => {
    const html = render([image({ width: 4, height: 3 })]);
    expect(html).toContain("absolute inset-0 size-full");
  });

  it("refuses to build a page-dominating box from a hostile size", () => {
    // `1x99999` is a valid ratio and a box ten thousand screens tall.
    const html = render([image({ width: 1, height: 99999 })]);
    expect(html).toContain("aspect-ratio:0.5");
  });

  it("refuses to collapse a box to a line", () => {
    const html = render([image({ width: 99999, height: 1 })]);
    expect(html).toContain("aspect-ratio:3");
  });

  it("renders nothing at all for an empty list", () => {
    expect(render([])).toBe("");
  });

  it("tiles several items and keeps one full width", () => {
    expect(render([image()])).toContain("grid-cols-1");
    expect(render([image(), image({ url: "https://x.test/b.png" })])).toContain(
      "grid-cols-2",
    );
  });
});
