import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  articleExcerpt,
  articleTimestamp,
  articleTitle,
  toArticleRow,
  toArticleRows,
  UNTITLED,
} from "./articleViews";
import { ARTICLE_DRAFT_KIND, ARTICLE_KIND } from "./buildArticle";

const ALICE = "a".repeat(64);

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: ALICE,
    created_at: 1_700_000_000,
    kind: ARTICLE_KIND,
    tags: [["d", "on-relays-1a2b"]],
    content: "Body text.",
    sig: "0".repeat(128),
    ...over,
  };
}

describe("title", () => {
  it("uses the author's title", () => {
    expect(articleTitle(event({ tags: [["title", "  On Relays  "]] }))).toBe(
      "On Relays",
    );
  });

  it("treats a missing or blank title as absent", () => {
    expect(articleTitle(event({ tags: [] }))).toBeUndefined();
    expect(articleTitle(event({ tags: [["title", "   "]] }))).toBeUndefined();
    expect(articleTitle(event({ tags: [["title"]] }))).toBeUndefined();
  });

  it("never yields an empty row title", () => {
    // A blank row is a clickable void where the author's work should be.
    for (const tags of [[], [["title", ""]], [["title", "  "]]]) {
      const row = toArticleRow(event({ tags }));
      expect(row.title).toBe(UNTITLED);
      expect(row.untitled).toBe(true);
      expect(row.title.trim()).not.toBe("");
    }
  });
});

describe("excerpt", () => {
  it("prefers the author's own summary", () => {
    const row = toArticleRow(
      event({
        tags: [["summary", "What relays are for."]],
        content: "# Heading\n\nSomething else entirely.",
      }),
    );
    expect(row.excerpt).toBe("What relays are for.");
  });

  it("falls back to the body's opening prose", () => {
    expect(
      articleExcerpt(
        event({ content: "# A Heading\n\nThe opening sentence follows." }),
      ),
    ).toBe("A Heading The opening sentence follows.");
  });

  it("does not leak Markdown punctuation into a row", () => {
    const excerpt = articleExcerpt(
      event({
        content: "Read **this** and [that](https://example.com) now.",
      }),
    );
    expect(excerpt).toBe("Read this and that now.");
    expect(excerpt).not.toContain("**");
    expect(excerpt).not.toContain("](");
  });

  it("skips a leading code fence rather than showing code as prose", () => {
    expect(
      articleExcerpt(
        event({ content: "```js\nconst x = 1;\n```\n\nThen the prose." }),
      ),
    ).toBe("Then the prose.");
  });

  it("returns an empty excerpt for an empty body without a summary", () => {
    expect(articleExcerpt(event({ content: "", tags: [] }))).toBe("");
  });
});

describe("timestamp", () => {
  it("uses published_at when the article has one", () => {
    expect(
      articleTimestamp(
        event({
          tags: [["published_at", "1650000000"]],
          created_at: 1_700_000_000,
        }),
      ),
    ).toBe(1_650_000_000);
  });

  it("falls back to created_at for a draft, which is its last save", () => {
    expect(
      articleTimestamp(event({ kind: ARTICLE_DRAFT_KIND, created_at: 42 })),
    ).toBe(42);
  });

  it("ignores a malformed published_at rather than sorting to 1970", () => {
    for (const value of ["", "soon", "-5", "0", "NaN"]) {
      expect(
        articleTimestamp(
          event({ tags: [["published_at", value]], created_at: 7 }),
        ),
      ).toBe(7);
    }
  });
});

describe("rows", () => {
  it("marks drafts and published articles apart", () => {
    expect(toArticleRow(event({ kind: ARTICLE_DRAFT_KIND })).draft).toBe(true);
    expect(toArticleRow(event({ kind: ARTICLE_KIND })).draft).toBe(false);
  });

  it("sorts newest first", () => {
    const rows = toArticleRows([
      event({
        id: "a".repeat(64),
        tags: [
          ["d", "old"],
          ["published_at", "100"],
        ],
      }),
      event({
        id: "b".repeat(64),
        tags: [
          ["d", "new"],
          ["published_at", "300"],
        ],
      }),
      event({
        id: "c".repeat(64),
        tags: [
          ["d", "mid"],
          ["published_at", "200"],
        ],
      }),
    ]);
    expect(rows.map((r) => r.identifier)).toEqual(["new", "mid", "old"]);
  });

  it("keeps only the newest event per address", () => {
    // One article appearing twice in the author's own list reads as data loss.
    const rows = toArticleRows([
      event({ id: "a".repeat(64), created_at: 100, tags: [["d", "same"]] }),
      event({ id: "b".repeat(64), created_at: 200, tags: [["d", "same"]] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.created_at).toBe(200);
  });

  it("does not merge a draft with the published article at the same address", () => {
    // Same `d`, different kinds: two rows on two different tabs.
    const rows = toArticleRows([
      event({ id: "a".repeat(64), kind: ARTICLE_KIND, tags: [["d", "same"]] }),
      event({
        id: "b".repeat(64),
        kind: ARTICLE_DRAFT_KIND,
        tags: [["d", "same"]],
      }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("carries the cover image only when there is one", () => {
    expect(
      toArticleRow(event({ tags: [["image", "https://example.com/c.png"]] }))
        .image,
    ).toBe("https://example.com/c.png");
    expect(toArticleRow(event({ tags: [] })).image).toBeUndefined();
    expect(
      toArticleRow(event({ tags: [["image", "  "]] })).image,
    ).toBeUndefined();
  });

  it("handles an empty event list", () => {
    expect(toArticleRows([])).toEqual([]);
  });
});
