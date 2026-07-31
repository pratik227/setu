import {
  encodeNevent,
  encodeNote,
  encodeNprofile,
  encodeNpub,
} from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  intentEventId,
  intentPubkey,
  MAX_TERMS,
  parseSearchInput,
  searchTerms,
} from "./searchQuery";

const PUBKEY = "a".repeat(64);
const EVENT_ID = "b".repeat(64);
// A real bech32 string rather than a literal: `decodeAny` verifies the checksum,
// so a hand-written `npub1...` would be rejected and the test would pass for the
// wrong reason.
const NPUB = encodeNpub(PUBKEY) as string;
const NOTE = encodeNote(EVENT_ID) as string;

describe("searchTerms", () => {
  it("splits, folds case and drops leading hashes", () => {
    expect(searchTerms("  Alice #Bitcoin ")).toEqual(["alice", "bitcoin"]);
  });

  it("drops duplicates so a repeated word cannot double a score", () => {
    expect(searchTerms("bob bob")).toEqual(["bob"]);
  });

  it("bounds how many terms one query can carry", () => {
    const many = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    expect(searchTerms(many)).toHaveLength(MAX_TERMS);
  });

  it("returns nothing for whitespace or punctuation alone", () => {
    expect(searchTerms("   ")).toEqual([]);
    expect(searchTerms("#")).toEqual([]);
  });
});

describe("parseSearchInput", () => {
  it("treats an empty box as nothing to do", () => {
    expect(parseSearchInput("")).toEqual({ kind: "empty" });
    expect(parseSearchInput("   ")).toEqual({ kind: "empty" });
  });

  it("decodes an npub to a profile reference", () => {
    const intent = parseSearchInput(NPUB);
    expect(intent.kind).toBe("ref");
    expect(intentPubkey(intent)).toBe(PUBKEY);
    expect(intentEventId(intent)).toBeUndefined();
  });

  it("decodes a note id to an event reference", () => {
    const intent = parseSearchInput(NOTE);
    expect(intentEventId(intent)).toBe(EVENT_ID);
    expect(intentPubkey(intent)).toBeUndefined();
  });

  it("accepts a nostr: URI and surrounding whitespace", () => {
    expect(intentPubkey(parseSearchInput(`  nostr:${NPUB}  `))).toBe(PUBKEY);
  });

  it("decodes nprofile and nevent, which carry relay hints", () => {
    const nprofile = encodeNprofile({ pubkey: PUBKEY, relays: ["wss://a"] });
    const nevent = encodeNevent({ id: EVENT_ID, relays: ["wss://a"] });
    expect(intentPubkey(parseSearchInput(nprofile as string))).toBe(PUBKEY);
    expect(intentEventId(parseSearchInput(nevent as string))).toBe(EVENT_ID);
  });

  it("classifies an nsec as a secret and never as a query", () => {
    // A syntactically valid nsec built from a known key, so this exercises the
    // real decode path rather than the malformed-input path.
    const nsec =
      "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    const intent = parseSearchInput(nsec);
    expect(intent).toEqual({ kind: "secret" });
    // The value must not survive into anything renderable.
    expect(JSON.stringify(intent)).not.toContain("nsec1");
  });

  it("reports a bare 64-hex string as ambiguous rather than guessing", () => {
    expect(parseSearchInput(PUBKEY)).toEqual({ kind: "hex", value: PUBKEY });
    expect(parseSearchInput(PUBKEY.toUpperCase())).toEqual({
      kind: "hex",
      value: PUBKEY,
    });
  });

  it("treats a single #word as a hashtag route", () => {
    expect(parseSearchInput("#Nostr")).toEqual({
      kind: "hashtag",
      tag: "nostr",
      terms: ["nostr"],
    });
  });

  it("does not treat two words as a hashtag even if one has a hash", () => {
    expect(parseSearchInput("#nostr clients")).toEqual({
      kind: "text",
      terms: ["nostr", "clients"],
    });
  });

  it("falls through to text for a malformed bech32 string", () => {
    expect(parseSearchInput("npub1notrealchecksum")).toEqual({
      kind: "text",
      terms: ["npub1notrealchecksum"],
    });
  });

  it("falls through to text for hex of the wrong length", () => {
    expect(parseSearchInput("abc123")).toEqual({
      kind: "text",
      terms: ["abc123"],
    });
  });
});
