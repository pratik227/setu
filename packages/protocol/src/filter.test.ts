import { describe, expect, it } from "vitest";
import { matchesAnyFilter, matchesFilter } from "./event";
import type { Filter, NostrEvent } from "./types";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const AUTHOR = "d".repeat(64);
const OTHER = "e".repeat(64);

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: A,
    pubkey: AUTHOR,
    created_at: 1000,
    kind: 1,
    tags: [],
    content: "",
    sig: "f".repeat(128),
    ...overrides,
  };
}

describe("matchesFilter — scalar fields", () => {
  it("matches an empty filter", () => {
    expect(matchesFilter(event(), {})).toBe(true);
  });

  it("matches ids exactly, never by prefix", () => {
    expect(matchesFilter(event(), { ids: [A] })).toBe(true);
    expect(matchesFilter(event(), { ids: [B, A] })).toBe(true);
    expect(matchesFilter(event(), { ids: [A.slice(0, 32)] })).toBe(false);
    expect(matchesFilter(event(), { ids: [`${A}00`] })).toBe(false);
    expect(matchesFilter(event(), { ids: [] })).toBe(false);
  });

  it("matches authors exactly, never by prefix", () => {
    expect(matchesFilter(event(), { authors: [AUTHOR] })).toBe(true);
    expect(matchesFilter(event(), { authors: [OTHER] })).toBe(false);
    expect(matchesFilter(event(), { authors: [AUTHOR.slice(0, 8)] })).toBe(
      false,
    );
  });

  it("matches kinds", () => {
    expect(matchesFilter(event({ kind: 7 }), { kinds: [1, 6, 7] })).toBe(true);
    expect(matchesFilter(event({ kind: 7 }), { kinds: [1] })).toBe(false);
    expect(matchesFilter(event(), { kinds: [] })).toBe(false);
  });

  it("ANDs scalar fields together", () => {
    const filter: Filter = { ids: [A], authors: [AUTHOR], kinds: [1] };
    expect(matchesFilter(event(), filter)).toBe(true);
    expect(matchesFilter(event({ kind: 2 }), filter)).toBe(false);
  });
});

describe("matchesFilter — since/until", () => {
  it("treats since as inclusive", () => {
    expect(matchesFilter(event({ created_at: 1000 }), { since: 1000 })).toBe(
      true,
    );
    expect(matchesFilter(event({ created_at: 999 }), { since: 1000 })).toBe(
      false,
    );
    expect(matchesFilter(event({ created_at: 1001 }), { since: 1000 })).toBe(
      true,
    );
  });

  it("treats until as inclusive", () => {
    expect(matchesFilter(event({ created_at: 1000 }), { until: 1000 })).toBe(
      true,
    );
    expect(matchesFilter(event({ created_at: 1001 }), { until: 1000 })).toBe(
      false,
    );
    expect(matchesFilter(event({ created_at: 999 }), { until: 1000 })).toBe(
      true,
    );
  });

  it("supports a closed window, both ends inclusive", () => {
    const filter: Filter = { since: 100, until: 200 };
    expect(matchesFilter(event({ created_at: 100 }), filter)).toBe(true);
    expect(matchesFilter(event({ created_at: 200 }), filter)).toBe(true);
    expect(matchesFilter(event({ created_at: 99 }), filter)).toBe(false);
    expect(matchesFilter(event({ created_at: 201 }), filter)).toBe(false);
  });

  it("accepts since === until for an exact timestamp", () => {
    expect(
      matchesFilter(event({ created_at: 150 }), { since: 150, until: 150 }),
    ).toBe(true);
  });
});

describe("matchesFilter — tag filters", () => {
  const tagged = event({
    tags: [
      ["e", B, "wss://relay.example", "root"],
      ["e", C],
      ["p", OTHER],
      ["t", "nostr"],
    ],
  });

  it("ORs values within a single tag letter", () => {
    expect(matchesFilter(tagged, { "#e": [B] })).toBe(true);
    expect(matchesFilter(tagged, { "#e": [C] })).toBe(true);
    expect(matchesFilter(tagged, { "#e": [A, C] })).toBe(true);
    expect(matchesFilter(tagged, { "#e": [A] })).toBe(false);
  });

  it("ANDs across different tag letters", () => {
    expect(matchesFilter(tagged, { "#e": [B], "#p": [OTHER] })).toBe(true);
    expect(matchesFilter(tagged, { "#e": [B], "#p": [AUTHOR] })).toBe(false);
    expect(matchesFilter(tagged, { "#e": [A], "#p": [OTHER] })).toBe(false);
    expect(
      matchesFilter(tagged, { "#e": [C], "#p": [OTHER], "#t": ["nostr"] }),
    ).toBe(true);
  });

  it("never matches an explicitly empty tag filter", () => {
    expect(matchesFilter(tagged, { "#e": [] })).toBe(false);
  });

  it("ignores an undefined tag filter", () => {
    expect(matchesFilter(tagged, { "#e": undefined })).toBe(true);
  });

  it("does not match a missing tag letter", () => {
    expect(matchesFilter(tagged, { "#a": ["30023:x:y"] })).toBe(false);
  });

  it("only looks at the tag value, not later elements", () => {
    // The relay hint in element 2 must not satisfy a `#e` filter.
    expect(matchesFilter(tagged, { "#e": ["wss://relay.example"] })).toBe(
      false,
    );
    // Nor the marker in element 3.
    expect(matchesFilter(tagged, { "#e": ["root"] })).toBe(false);
  });

  it("ignores valueless tag rows", () => {
    const odd = event({ tags: [["e"], ["e", B]] });
    expect(matchesFilter(odd, { "#e": [B] })).toBe(true);
    expect(matchesFilter(event({ tags: [["e"]] }), { "#e": [B] })).toBe(false);
  });

  it("combines tag filters with scalar fields", () => {
    expect(
      matchesFilter(tagged, {
        kinds: [1],
        authors: [AUTHOR],
        since: 1000,
        "#t": ["nostr"],
      }),
    ).toBe(true);
    expect(
      matchesFilter(tagged, { kinds: [1], since: 1001, "#t": ["nostr"] }),
    ).toBe(false);
  });
});

describe("matchesFilter — ignored fields", () => {
  it("ignores limit and search", () => {
    expect(matchesFilter(event(), { limit: 0 })).toBe(true);
    expect(matchesFilter(event({ content: "hi" }), { search: "nope" })).toBe(
      true,
    );
  });
});

describe("matchesAnyFilter", () => {
  it("is the OR of the filter set", () => {
    const filters: Filter[] = [{ kinds: [1] }, { kinds: [7] }];
    expect(matchesAnyFilter(event({ kind: 7 }), filters)).toBe(true);
    expect(matchesAnyFilter(event({ kind: 3 }), filters)).toBe(false);
    expect(matchesAnyFilter(event(), [])).toBe(false);
  });
});
