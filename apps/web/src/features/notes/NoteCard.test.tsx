import { Kind } from "@setu/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoteCard } from "./NoteCard";
import type { MediaView, NoteView } from "./types";

/**
 * Render-level proof of the ordering, because ordering is only visible in markup.
 *
 * `noteKinds.test.ts` asserts which kinds are media-first; this asserts that the
 * card actually puts the media where that says it goes. A correct predicate whose
 * answer never changes the DOM order still renders a caption above the picture it
 * describes.
 */
const IMAGE: MediaView = {
  url: "https://x.test/a.jpg",
  kind: "image",
  width: 1200,
  height: 800,
};

function note(over: Partial<NoteView> = {}): NoteView {
  return {
    id: "1".repeat(64),
    rowKey: "note:1",
    author: {
      pubkey: "a".repeat(64),
      resolved: true,
      displayName: "Aditi",
      handle: "aditi@example.com",
    },
    kind: Kind.ShortTextNote,
    tags: [],
    createdAt: 1_700_000_000,
    content: "a caption",
    replyCount: 0,
    repostCount: 0,
    reactionCount: 0,
    zapSats: 0,
    ...over,
  };
}

const render = (view: NoteView): string =>
  renderToStaticMarkup(<NoteCard note={view} />);

/** Where each landmark first appears, so order can be compared. */
function positions(html: string) {
  return {
    media: html.indexOf("https://x.test/a.jpg"),
    caption: html.indexOf("a caption"),
    title: html.indexOf("Sunrise"),
  };
}

describe("NoteCard media ordering", () => {
  it("puts a text note's media under its text", () => {
    // The sentence introduces the picture; reordering it would put a photo above
    // the words that explain it.
    const at = positions(render(note({ media: [IMAGE] })));
    expect(at.caption).toBeGreaterThan(-1);
    expect(at.media).toBeGreaterThan(at.caption);
  });

  it("puts a picture post's media above its caption", () => {
    // A kind-20's content is a caption *about* the post, so kind-1 ordering puts
    // the caption above the thing it is describing.
    const at = positions(render(note({ kind: Kind.Picture, media: [IMAGE] })));
    expect(at.media).toBeGreaterThan(-1);
    expect(at.media).toBeLessThan(at.caption);
  });

  it("renders the media exactly once, whichever order applies", () => {
    for (const kind of [Kind.ShortTextNote, Kind.Picture, Kind.ShortVideo]) {
      const html = render(note({ kind, media: [IMAGE] }));
      expect(html.match(/x\.test\/a\.jpg/g)?.length).toBe(1);
    }
  });

  it("still reserves the box, so the timeline does not jump", () => {
    expect(render(note({ kind: Kind.Picture, media: [IMAGE] }))).toContain(
      "aspect-ratio:1.5",
    );
  });
});

describe("NoteCard title", () => {
  it("shows the title tag on a kind that defines one", () => {
    const html = render(
      note({
        kind: Kind.Picture,
        media: [IMAGE],
        tags: [["title", "Sunrise"]],
      }),
    );
    expect(html).toContain("Sunrise");
  });

  it("ignores a stray title tag on a text note", () => {
    // `title` is not reserved, so a kind-1 carrying one must not get a bold heading
    // its author never wrote.
    const html = render(note({ tags: [["title", "Sunrise"]] }));
    expect(html).not.toContain("Sunrise");
  });

  it("resolves custom emoji in a title", () => {
    const html = render(
      note({
        kind: Kind.Picture,
        media: [IMAGE],
        tags: [
          ["title", "Sunrise :soapbox:"],
          ["emoji", "soapbox", "https://x.test/soapbox.png"],
        ],
      }),
    );
    expect(html).toContain('src="https://x.test/soapbox.png"');
  });
});
