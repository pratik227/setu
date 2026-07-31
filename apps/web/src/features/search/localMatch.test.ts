import { describe, expect, it } from "vitest";
import {
  highlight,
  type NoteCandidate,
  type PersonCandidate,
  rankNotes,
  rankPeople,
  snippet,
} from "./localMatch";

function person(over: Partial<PersonCandidate> = {}): PersonCandidate {
  return { pubkey: (over.pubkey ?? "a").repeat(64).slice(0, 64), ...over };
}

function note(over: Partial<NoteCandidate> = {}): NoteCandidate {
  return {
    id: (over.id ?? "1").repeat(64).slice(0, 64),
    pubkey: "a".repeat(64),
    createdAt: over.createdAt ?? 1000,
    content: over.content ?? "",
    ...over,
  };
}

function names(
  ranked: readonly { readonly value: PersonCandidate }[],
): readonly (string | undefined)[] {
  return ranked.map((r) => r.value.displayName ?? r.value.name);
}

describe("rankPeople", () => {
  it("returns nothing without terms", () => {
    expect(rankPeople([person({ displayName: "alice" })], [])).toEqual([]);
  });

  it("returns nothing when no candidate matches", () => {
    expect(rankPeople([person({ displayName: "alice" })], ["bob"])).toEqual([]);
  });

  it("ranks an exact name above a prefix above a substring", () => {
    const ranked = rankPeople(
      [
        person({ pubkey: "c", displayName: "carol and jack" }),
        person({ pubkey: "b", displayName: "jackson" }),
        person({ pubkey: "a", displayName: "jack" }),
      ],
      ["jack"],
    );
    expect(names(ranked)).toEqual(["jack", "jackson", "carol and jack"]);
  });

  it("prefers a word-boundary match over one inside a word", () => {
    const ranked = rankPeople(
      [
        person({ pubkey: "b", displayName: "blacksmithing" }),
        person({ pubkey: "a", displayName: "alice smith" }),
      ],
      ["smith"],
    );
    expect(names(ranked)).toEqual(["alice smith", "blacksmithing"]);
  });

  it("ranks a name match above any number of bio mentions", () => {
    const ranked = rankPeople(
      [
        person({ pubkey: "b", displayName: "bob", about: "jack jack jack" }),
        person({ pubkey: "a", displayName: "jack the builder" }),
      ],
      ["jack"],
    );
    expect(names(ranked)).toEqual(["jack the builder", "bob"]);
  });

  it("matches a NIP-05 identifier, whole or by prefix", () => {
    const candidates = [person({ nip05: "alice@example.com" })];
    expect(rankPeople(candidates, ["alice@example.com"])).toHaveLength(1);
    expect(rankPeople(candidates, ["alice@ex"])).toHaveLength(1);
    expect(rankPeople(candidates, ["example.com"])).toHaveLength(1);
  });

  it("matches a partial npub by prefix only", () => {
    const candidates = [person({ npub: "npub1alice0000" })];
    expect(rankPeople(candidates, ["npub1alice"])).toHaveLength(1);
    // Mid-string would fire on the shared `npub1` of every key in the store.
    expect(rankPeople(candidates, ["alice0000"])).toEqual([]);
  });

  it("requires every term to match", () => {
    const candidates = [
      person({ pubkey: "a", displayName: "alice smith" }),
      person({ pubkey: "b", displayName: "alice jones" }),
    ];
    expect(names(rankPeople(candidates, ["alice", "smith"]))).toEqual([
      "alice smith",
    ]);
  });

  it("lets each term match a different field", () => {
    const candidates = [
      person({ displayName: "alice", nip05: "a@example.com" }),
    ];
    expect(rankPeople(candidates, ["alice", "example.com"])).toHaveLength(1);
  });

  it("is case insensitive", () => {
    expect(
      rankPeople([person({ displayName: "AlIcE" })], ["alice"]),
    ).toHaveLength(1);
  });

  it("breaks ties by name then pubkey, so the order is stable", () => {
    const candidates = [
      person({ pubkey: "b".repeat(64), displayName: "jack" }),
      person({ pubkey: "a".repeat(64), displayName: "jack" }),
      person({ pubkey: "c".repeat(64), displayName: "abe jack" }),
    ];
    const forward = rankPeople(candidates, ["jack"]);
    const reverse = rankPeople([...candidates].reverse(), ["jack"]);
    expect(forward).toEqual(reverse);
    expect(forward.map((r) => r.value.pubkey[0])).toEqual(["a", "b", "c"]);
  });

  it("applies the limit after ranking", () => {
    const candidates = [
      person({ pubkey: "b", displayName: "jackson" }),
      person({ pubkey: "a", displayName: "jack" }),
    ];
    expect(names(rankPeople(candidates, ["jack"], 1))).toEqual(["jack"]);
  });

  it("ignores a candidate with no fields at all", () => {
    expect(rankPeople([person()], ["jack"])).toEqual([]);
  });
});

describe("rankNotes", () => {
  it("returns nothing without terms", () => {
    expect(rankNotes([note({ content: "hello" })], [])).toEqual([]);
  });

  it("requires every term to appear in the body", () => {
    const candidates = [
      note({ id: "1", content: "alice went to the market" }),
      note({ id: "2", content: "alice stayed home" }),
    ];
    const ranked = rankNotes(candidates, ["alice", "market"]);
    expect(ranked.map((r) => r.value.content)).toEqual([
      "alice went to the market",
    ]);
  });

  it("orders newest first, not by score", () => {
    const ranked = rankNotes(
      [
        note({ id: "1", createdAt: 100, content: "gardening" }),
        note({ id: "2", createdAt: 200, content: "a note about gardening" }),
      ],
      ["gardening"],
    );
    expect(ranked.map((r) => r.value.createdAt)).toEqual([200, 100]);
  });

  it("breaks a same-second tie on match quality", () => {
    const ranked = rankNotes(
      [
        note({ id: "1", createdAt: 100, content: "regardening tools" }),
        note({ id: "2", createdAt: 100, content: "gardening tools" }),
      ],
      ["gardening"],
    );
    expect(ranked.map((r) => r.value.content)).toEqual([
      "gardening tools",
      "regardening tools",
    ]);
  });

  it("is stable under input reordering", () => {
    const candidates = [
      note({ id: "1", createdAt: 100, content: "gardening" }),
      note({ id: "2", createdAt: 100, content: "gardening" }),
    ];
    expect(rankNotes(candidates, ["gardening"])).toEqual(
      rankNotes([...candidates].reverse(), ["gardening"]),
    );
  });

  it("applies the limit after ranking", () => {
    const candidates = [
      note({ id: "1", createdAt: 100, content: "gardening" }),
      note({ id: "2", createdAt: 200, content: "gardening" }),
    ];
    expect(rankNotes(candidates, ["gardening"], 1)[0]?.value.createdAt).toBe(
      200,
    );
  });
});

describe("highlight", () => {
  it("returns one unmatched run when nothing matches", () => {
    expect(highlight("hello", ["zz"])).toEqual([
      { text: "hello", match: false },
    ]);
  });

  it("marks each occurrence", () => {
    expect(highlight("ab cd ab", ["ab"])).toEqual([
      { text: "ab", match: true },
      { text: " cd ", match: false },
      { text: "ab", match: true },
    ]);
  });

  it("preserves the original casing of a matched run", () => {
    expect(highlight("Alice", ["alice"])).toEqual([
      { text: "Alice", match: true },
    ]);
  });

  it("merges overlapping terms instead of nesting them", () => {
    expect(highlight("banana", ["ana", "nan"])).toEqual([
      { text: "b", match: false },
      { text: "anan", match: true },
      { text: "a", match: false },
    ]);
  });

  it("reassembles into the original text", () => {
    const text = "the quick brown fox";
    const joined = highlight(text, ["quick", "fox"])
      .map((s) => s.text)
      .join("");
    expect(joined).toBe(text);
  });

  it("handles empty input", () => {
    expect(highlight("", ["a"])).toEqual([]);
    expect(highlight("abc", [])).toEqual([{ text: "abc", match: false }]);
  });
});

describe("snippet", () => {
  it("returns short content whole, with whitespace collapsed", () => {
    expect(snippet("a  b\nc", ["a"])).toBe("a b c");
  });

  it("windows around the first match rather than the start", () => {
    const body = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
    const out = snippet(body, ["needle"], 60);
    expect(out).toContain("needle");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to the head when no term is present", () => {
    const out = snippet("z".repeat(400), ["needle"], 50);
    expect(out.startsWith("…")).toBe(false);
    expect(out.endsWith("…")).toBe(true);
  });
});
