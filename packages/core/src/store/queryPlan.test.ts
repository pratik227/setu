/**
 * Index selection. A filter that names ids, tags, authors or kinds must never
 * produce a full scan.
 */

import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../contracts";
import { hex, makeEvent, PUBKEYS } from "../testing/fixtures";
import type { IndexStats } from "./queryPlan";
import {
  chooseIndex,
  sortAndLimit,
  tagIndexKey,
  tagIndexKeysOf,
} from "./queryPlan";

function stats(overrides: Partial<Record<string, number>> = {}): IndexStats {
  return {
    totalEvents: 100_000,
    countForTagKey: (key) => overrides[key] ?? 0,
    countForAuthor: (pubkey) => overrides[pubkey] ?? 0,
    countForKind: (kind) => overrides[String(kind)] ?? 0,
  };
}

describe("tagIndexKeysOf", () => {
  it("indexes single-letter tags only, de-duplicated", () => {
    expect(
      tagIndexKeysOf([
        ["e", "abc"],
        ["p", "def"],
        ["e", "abc"],
        ["alt", "ignored"],
        ["d"],
      ]),
    ).toEqual(["e:abc", "p:def"]);
  });
});

describe("chooseIndex", () => {
  it("always uses primary-key lookups when ids are named", () => {
    expect(
      chooseIndex({ ids: [hex("x")], kinds: [1], authors: [PUBKEYS.alice] }),
    ).toEqual({ index: "ids", ids: [hex("x")] });
  });

  it("never scans when any usable dimension is present", () => {
    expect(chooseIndex({ kinds: [1] }).index).toBe("kind");
    expect(chooseIndex({ authors: [PUBKEYS.alice] }).index).toBe("author");
    expect(chooseIndex({ "#t": ["nostr"] }).index).toBe("tag");
  });

  it("scans only when the filter names nothing indexable", () => {
    expect(chooseIndex({}).index).toBe("scan");
    expect(chooseIndex({ since: 1, until: 2, limit: 3 }).index).toBe("scan");
    // An empty value list is not usable as an index.
    expect(chooseIndex({ kinds: [], authors: [] }).index).toBe("scan");
  });

  it("prefers tag over author over kind without statistics", () => {
    expect(
      chooseIndex({
        kinds: [1],
        authors: [PUBKEYS.alice],
        "#t": ["nostr"],
      }).index,
    ).toBe("tag");
    expect(chooseIndex({ kinds: [1], authors: [PUBKEYS.alice] }).index).toBe(
      "author",
    );
  });

  it("uses statistics to pick the genuinely narrowest index", () => {
    // A cold author inside a hot kind: the author is the right index.
    const plan = chooseIndex(
      { kinds: [1], authors: [PUBKEYS.alice] },
      stats({ [PUBKEYS.alice]: 5, "1": 90_000 }),
    );
    expect(plan.index).toBe("author");

    // A hot author inside a cold kind: the kind wins.
    const inverted = chooseIndex(
      { kinds: [10002], authors: [PUBKEYS.alice] },
      stats({ [PUBKEYS.alice]: 40_000, "10002": 12 }),
    );
    expect(inverted.index).toBe("kind");
  });

  it("picks the cheapest tag filter when several are ANDed", () => {
    const plan = chooseIndex(
      { "#e": ["hot"], "#p": ["cold"] },
      stats({
        [tagIndexKey("e", "hot")]: 5_000,
        [tagIndexKey("p", "cold")]: 3,
      }),
    );
    expect(plan).toEqual({ index: "tag", tagKeys: ["p:cold"] });
  });

  it("sums bucket sizes across a multi-value dimension", () => {
    const plan = chooseIndex(
      { kinds: [1, 7], authors: [PUBKEYS.alice, PUBKEYS.bob] },
      stats({
        "1": 10,
        "7": 10,
        [PUBKEYS.alice]: 30,
        [PUBKEYS.bob]: 30,
      }),
    );
    expect(plan.index).toBe("kind");
  });
});

describe("sortAndLimit", () => {
  const stored = (createdAt: number, seed: string): StoredEvent => ({
    event: makeEvent({ id: hex(seed), created_at: createdAt }),
    provenance: { relays: [], firstSeen: 0 },
  });

  it("orders newest first and applies limit after sorting", () => {
    const rows = [stored(100, "a"), stored(300, "b"), stored(200, "c")];
    expect(
      sortAndLimit(rows, { limit: 2 }).map((r) => r.event.created_at),
    ).toEqual([300, 200]);
  });

  it("breaks created_at ties on ascending id, so paging is stable", () => {
    const rows = [stored(100, "b"), stored(100, "a")];
    expect(sortAndLimit(rows, {}).map((r) => r.event.id)).toEqual([
      hex("a"),
      hex("b"),
    ]);
  });

  it("leaves the input array untouched", () => {
    const rows = [stored(100, "a"), stored(300, "b")];
    const copy = [...rows];
    sortAndLimit(rows, {});
    expect(rows).toEqual(copy);
  });
});
