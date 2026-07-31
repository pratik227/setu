import { describe, expect, it } from "vitest";
import { Kind } from "./kinds";
import {
  addressOf,
  dTag,
  eTags,
  getTagged,
  getTagValue,
  getTagValues,
  hashtags,
  hasTag,
  isReply,
  parseAddress,
  pTags,
  replaceableAddress,
  rootAndReplyIds,
} from "./tags";
import type { NostrEvent } from "./types";

const ROOT = "1".repeat(64);
const MID = "2".repeat(64);
const PARENT = "3".repeat(64);
const QUOTED = "4".repeat(64);
const PUBKEY = "5".repeat(64);
const OTHER_PUBKEY = "6".repeat(64);

function event(
  tags: readonly (readonly string[])[],
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  return {
    id: "0".repeat(64),
    pubkey: PUBKEY,
    created_at: 1700000000,
    kind: Kind.ShortTextNote,
    tags,
    content: "",
    sig: "f".repeat(128),
    ...overrides,
  };
}

describe("tag accessors", () => {
  const e = event([
    ["p", PUBKEY, "wss://a.example"],
    ["p", OTHER_PUBKEY],
    ["t", "Nostr"],
    ["t", "nostr"],
    ["e", ROOT],
    ["alt"],
  ]);

  it("getTagValue returns the first match", () => {
    expect(getTagValue(e, "p")).toBe(PUBKEY);
    expect(getTagValue(e, "t")).toBe("Nostr");
    expect(getTagValue(e, "missing")).toBeUndefined();
    expect(getTagValue(e, "alt")).toBeUndefined();
  });

  it("getTagValues returns all matches in order", () => {
    expect(getTagValues(e, "p")).toEqual([PUBKEY, OTHER_PUBKEY]);
    expect(getTagValues(e, "t")).toEqual(["Nostr", "nostr"]);
    expect(getTagValues(e, "missing")).toEqual([]);
  });

  it("getTagged returns whole rows", () => {
    expect(getTagged(e, "p")).toEqual([
      ["p", PUBKEY, "wss://a.example"],
      ["p", OTHER_PUBKEY],
    ]);
  });

  it("hasTag checks presence with and without a value", () => {
    expect(hasTag(e, "alt")).toBe(true);
    expect(hasTag(e, "p", OTHER_PUBKEY)).toBe(true);
    expect(hasTag(e, "p", ROOT)).toBe(false);
  });

  it("eTags/pTags/hashtags are conveniences over the same data", () => {
    expect(eTags(e)).toEqual([ROOT]);
    expect(pTags(e)).toEqual([PUBKEY, OTHER_PUBKEY]);
    expect(hashtags(e)).toEqual(["nostr"]);
  });
});

describe("addressable coordinates", () => {
  it("builds kind:pubkey:d for an addressable event", () => {
    const article = event([["d", "setu-manifesto"]], {
      kind: Kind.LongFormArticle,
    });
    expect(dTag(article)).toBe("setu-manifesto");
    expect(replaceableAddress(article)).toBe(`30023:${PUBKEY}:setu-manifesto`);
  });

  it("uses an empty identifier when the d tag is absent", () => {
    const set = event([], { kind: Kind.FollowSets });
    expect(dTag(set)).toBeUndefined();
    expect(replaceableAddress(set)).toBe(`30000:${PUBKEY}:`);
  });

  it("returns undefined for non-addressable kinds", () => {
    expect(replaceableAddress(event([["d", "x"]]))).toBeUndefined();
    expect(
      replaceableAddress(event([["d", "x"]], { kind: Kind.RelayList })),
    ).toBeUndefined();
    expect(
      replaceableAddress(event([["d", "x"]], { kind: Kind.Metadata })),
    ).toBeUndefined();
  });

  it("addressOf builds the same string without an event", () => {
    expect(addressOf(Kind.LongFormArticle, PUBKEY, "setu-manifesto")).toBe(
      `30023:${PUBKEY}:setu-manifesto`,
    );
    expect(addressOf(Kind.FollowSets, PUBKEY)).toBe(`30000:${PUBKEY}:`);
  });

  it("parseAddress round-trips and rejects malformed coordinates", () => {
    const coordinate = addressOf(30023, PUBKEY, "slug:with:colons");
    expect(parseAddress(coordinate)).toEqual({
      kind: 30023,
      pubkey: PUBKEY,
      identifier: "slug:with:colons",
    });
    expect(parseAddress(`30000:${PUBKEY}:`)).toEqual({
      kind: 30000,
      pubkey: PUBKEY,
      identifier: "",
    });
    expect(parseAddress("")).toBeUndefined();
    expect(parseAddress("30023")).toBeUndefined();
    expect(parseAddress(`30023:${PUBKEY}`)).toBeUndefined();
    expect(parseAddress(`:${PUBKEY}:x`)).toBeUndefined();
    expect(parseAddress("notakind:abc:x")).toBeUndefined();
    expect(parseAddress("30023:tooshort:x")).toBeUndefined();
  });
});

describe("rootAndReplyIds — NIP-10 marked tags", () => {
  it("uses root and reply markers", () => {
    const e = event([
      ["e", ROOT, "", "root"],
      ["e", PARENT, "wss://relay.example", "reply"],
      ["p", PUBKEY],
    ]);
    expect(rootAndReplyIds(e)).toEqual({ root: ROOT, reply: PARENT });
    expect(isReply(e)).toBe(true);
  });

  it("treats markers as authoritative even when order is unusual", () => {
    const e = event([
      ["e", PARENT, "", "reply"],
      ["e", ROOT, "", "root"],
    ]);
    expect(rootAndReplyIds(e)).toEqual({ root: ROOT, reply: PARENT });
  });

  it("treats a lone root marker as a direct reply to the root", () => {
    const e = event([["e", ROOT, "", "root"]]);
    expect(rootAndReplyIds(e)).toEqual({ root: ROOT, reply: ROOT });
  });

  it("treats a lone reply marker as its own root", () => {
    const e = event([["e", PARENT, "", "reply"]]);
    expect(rootAndReplyIds(e)).toEqual({ root: PARENT, reply: PARENT });
  });

  it("ignores mention markers — a quote is not a reply", () => {
    const e = event([["e", QUOTED, "", "mention"]]);
    expect(rootAndReplyIds(e)).toEqual({});
    expect(isReply(e)).toBe(false);
  });

  it("ignores mentions while honouring real markers", () => {
    const e = event([
      ["e", QUOTED, "", "mention"],
      ["e", ROOT, "", "root"],
      ["e", PARENT, "", "reply"],
    ]);
    expect(rootAndReplyIds(e)).toEqual({ root: ROOT, reply: PARENT });
  });
});

describe("rootAndReplyIds — legacy positional fallback", () => {
  it("uses first as root and last as parent", () => {
    const e = event([
      ["e", ROOT],
      ["e", MID],
      ["e", PARENT],
    ]);
    expect(rootAndReplyIds(e)).toEqual({ root: ROOT, reply: PARENT });
  });

  it("treats a single unmarked e-tag as both root and parent", () => {
    const e = event([["e", ROOT]]);
    expect(rootAndReplyIds(e)).toEqual({ root: ROOT, reply: ROOT });
  });

  it("handles two unmarked e-tags", () => {
    const e = event([
      ["e", ROOT],
      ["e", PARENT],
    ]);
    expect(rootAndReplyIds(e)).toEqual({ root: ROOT, reply: PARENT });
  });

  it("ignores relay hints in element 2 and empty ids", () => {
    const e = event([
      ["e", ROOT, "wss://relay.example"],
      ["e", ""],
      ["e", PARENT, "wss://other.example"],
    ]);
    expect(rootAndReplyIds(e)).toEqual({ root: ROOT, reply: PARENT });
  });

  it("returns nothing for a top-level note", () => {
    const e = event([["p", PUBKEY]]);
    expect(rootAndReplyIds(e)).toEqual({});
    expect(isReply(e)).toBe(false);
  });

  it("ignores unknown markers and falls back positionally", () => {
    const e = event([
      ["e", ROOT, "", "wat"],
      ["e", PARENT, "", "huh"],
    ]);
    expect(rootAndReplyIds(e)).toEqual({ root: ROOT, reply: PARENT });
  });
});
