import { describe, expect, it } from "vitest";
import { normalizeTopic, rankAuthors, rankTopics, topicsOf } from "./ranking";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function note(
  over: {
    pubkey?: string;
    content?: string;
    tags?: readonly (readonly string[])[];
  } = {},
) {
  return {
    pubkey: over.pubkey ?? A,
    content: over.content ?? "",
    tags: over.tags ?? [],
  };
}

describe("normalizeTopic", () => {
  it("folds case and strips leading hashes", () => {
    expect(normalizeTopic("#Nostr")).toBe("nostr");
    expect(normalizeTopic("  ##BitCoin ")).toBe("bitcoin");
  });

  it("rejects a topic that is nothing but punctuation", () => {
    expect(normalizeTopic("#")).toBeUndefined();
    expect(normalizeTopic("   ")).toBeUndefined();
  });
});

describe("topicsOf", () => {
  it("reads both t tags and inline hashtags", () => {
    const topics = topicsOf(
      note({ content: "shipping #design today", tags: [["t", "nostr"]] }),
    );
    expect([...topics].sort()).toEqual(["design", "nostr"]);
  });

  it("counts #Nostr and #nostr as one topic", () => {
    const topics = topicsOf(
      note({ content: "#nostr and #NOSTR", tags: [["t", "Nostr"]] }),
    );
    expect(topics).toEqual(["nostr"]);
  });

  it("does not pick hashtags out of a URL or a code fence", () => {
    const topics = topicsOf(
      note({ content: "see https://example.com/a#nostr\n```\n#fenced\n```" }),
    );
    expect(topics).toEqual([]);
  });

  it("returns nothing for an event with no topics", () => {
    expect(topicsOf(note({ content: "plain text" }))).toEqual([]);
  });
});

describe("rankTopics", () => {
  it("returns nothing for empty input", () => {
    expect(rankTopics([])).toEqual([]);
  });

  it("handles a single event", () => {
    expect(rankTopics([note({ tags: [["t", "nostr"]] })])).toEqual([
      { tag: "nostr", count: 1 },
    ]);
  });

  it("counts a topic once per event, not once per mention", () => {
    const events = [note({ content: "#nostr #nostr #nostr" }), note({})];
    expect(rankTopics(events)).toEqual([{ tag: "nostr", count: 1 }]);
  });

  it("orders by count and breaks ties alphabetically", () => {
    const events = [
      note({ tags: [["t", "nostr"]] }),
      note({ tags: [["t", "nostr"]] }),
      note({ tags: [["t", "zaps"]] }),
      note({ tags: [["t", "bitcoin"]] }),
    ];
    expect(rankTopics(events)).toEqual([
      { tag: "nostr", count: 2 },
      { tag: "bitcoin", count: 1 },
      { tag: "zaps", count: 1 },
    ]);
  });

  it("merges case variants across events before ranking", () => {
    const events = [
      note({ tags: [["t", "Nostr"]] }),
      note({ content: "#nostr" }),
      note({ tags: [["t", "NOSTR"]] }),
    ];
    expect(rankTopics(events)).toEqual([{ tag: "nostr", count: 3 }]);
  });

  it("applies the limit after ranking", () => {
    const events = [
      note({ tags: [["t", "a"]] }),
      note({ tags: [["t", "a"]] }),
      note({ tags: [["t", "b"]] }),
      note({ tags: [["t", "c"]] }),
    ];
    expect(rankTopics(events, 2)).toEqual([
      { tag: "a", count: 2 },
      { tag: "b", count: 1 },
    ]);
  });
});

describe("rankAuthors", () => {
  it("returns nothing for empty input", () => {
    expect(rankAuthors([])).toEqual([]);
  });

  it("handles a single event", () => {
    expect(rankAuthors([note()])).toEqual([{ pubkey: A, count: 1 }]);
  });

  it("orders by count and breaks ties by pubkey", () => {
    const events = [
      note({ pubkey: C }),
      note({ pubkey: C }),
      note({ pubkey: B }),
      note({ pubkey: A }),
    ];
    expect(rankAuthors(events)).toEqual([
      { pubkey: C, count: 2 },
      { pubkey: A, count: 1 },
      { pubkey: B, count: 1 },
    ]);
  });

  it("is stable under input reordering", () => {
    const events = [note({ pubkey: A }), note({ pubkey: B })];
    expect(rankAuthors(events)).toEqual(rankAuthors([...events].reverse()));
  });

  it("applies the limit after ranking", () => {
    const events = [
      note({ pubkey: B }),
      note({ pubkey: B }),
      note({ pubkey: A }),
    ];
    expect(rankAuthors(events, 1)).toEqual([{ pubkey: B, count: 2 }]);
  });
});
