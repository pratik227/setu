import { describe, expect, it } from "vitest";
import { Kind } from "./kinds";
import { parsePicture } from "./nip68";
import type { NostrEvent } from "./types";

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: "a".repeat(64),
    created_at: 1000,
    kind: Kind.Picture,
    tags: [
      ["title", "Sunrise"],
      ["imeta", "url https://x.test/a.jpg", "m image/jpeg", "dim 1200x800"],
    ],
    content: "taken this morning",
    sig: "0".repeat(128),
    ...over,
  };
}

describe("parsePicture", () => {
  it("reads the title, the caption and the pictures", () => {
    const parsed = parsePicture(event());
    expect(parsed?.title).toBe("Sunrise");
    // The content is a caption *about* the post, not the media — which is the
    // whole reason a kind-1 renderer cannot handle this kind.
    expect(parsed?.description).toBe("taken this morning");
    expect(parsed?.pictures).toEqual([
      {
        url: "https://x.test/a.jpg",
        mimeType: "image/jpeg",
        dim: { width: 1200, height: 800 },
      },
    ]);
  });

  it("rejects a kind-20 that declares no usable imeta row", () => {
    // A caption under an empty frame reads as an image that failed to load.
    expect(
      parsePicture(event({ tags: [["title", "Nothing"]] })),
    ).toBeUndefined();
    expect(
      parsePicture(event({ tags: [["imeta", "m image/jpeg"]] })),
    ).toBeUndefined();
  });

  it("rejects an event of another kind", () => {
    expect(parsePicture(event({ kind: Kind.ShortTextNote }))).toBeUndefined();
  });

  it("omits the title when the author wrote none", () => {
    const parsed = parsePicture(
      event({ tags: [["imeta", "url https://x.test/a.jpg"]] }),
    );
    expect(parsed?.title).toBeUndefined();
    expect(parsed?.pictures).toHaveLength(1);
  });

  it("keeps several pictures in tag order", () => {
    const parsed = parsePicture(
      event({
        tags: [
          ["imeta", "url https://x.test/a.jpg"],
          ["imeta", "url https://x.test/b.jpg"],
        ],
      }),
    );
    expect(parsed?.pictures.map((p) => p.url)).toEqual([
      "https://x.test/a.jpg",
      "https://x.test/b.jpg",
    ]);
  });
});
