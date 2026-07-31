import { describe, expect, it } from "vitest";
import {
  computeEventId,
  isValidEventShape,
  serializeEvent,
  verifyEventSignature,
} from "./event";
import { LocalSigner } from "./signers/local";
import type { NostrEvent } from "./types";

/**
 * Fixed test identity. Ids below were produced by signing with this key and are
 * pinned as vectors: `computeEventId` must keep reproducing them, or the
 * canonical serialization has drifted and every id in the store is wrong.
 */
const SK = "5426e4dbdda01dd54f0d5b1d1a0e9db4c8b3d0e5a2b1f4c7d9e8a6b5c4d3e2f1";
const PK = "53aba620395a09ade0d0115678215b1d565f680adeef7a5c385988a49447eb3c";

const signer = LocalSigner.fromSecretKey(SK);

const PLAIN_NOTE = {
  kind: 1,
  created_at: 1700000000,
  tags: [],
  content: "hello nostr",
} as const;
const PLAIN_NOTE_ID =
  "11808a5462dda72e28fc3301d8b773e5f5272c8d5d5577a267c1920b646fa160";

const TAGGED_NOTE = {
  kind: 1,
  created_at: 1712345678,
  tags: [
    ["e", `${"0".repeat(63)}1`, "wss://relay.example", "root"],
    ["p", PK],
    ["t", "setu"],
  ],
  content: 'reply with tags & unicode ✅ "quotes" \\ backslash\nnewline',
} as const;
const TAGGED_NOTE_ID =
  "3db7be7c202b403b8df09ff54cb1694b19f6ba89b3e487ff004ccb37b50b8f93";

describe("serializeEvent", () => {
  it("produces the canonical NIP-01 array with no whitespace", () => {
    expect(serializeEvent({ ...PLAIN_NOTE, pubkey: PK })).toBe(
      `[0,"${PK}",1700000000,1,[],"hello nostr"]`,
    );
  });

  it("escapes content the way JSON requires", () => {
    const serialized = serializeEvent({ ...TAGGED_NOTE, pubkey: PK });
    expect(serialized).toContain('\\"quotes\\"');
    expect(serialized).toContain("\\\\ backslash");
    expect(serialized).toContain("\\nnewline");
    expect(JSON.parse(serialized)).toHaveLength(6);
  });
});

describe("computeEventId", () => {
  it("matches the pinned vector for a plain note", () => {
    expect(computeEventId({ ...PLAIN_NOTE, pubkey: PK })).toBe(PLAIN_NOTE_ID);
  });

  it("matches the pinned vector for a tagged note", () => {
    expect(computeEventId({ ...TAGGED_NOTE, pubkey: PK })).toBe(TAGGED_NOTE_ID);
  });

  it("changes when any field changes", () => {
    const base = { ...PLAIN_NOTE, pubkey: PK };
    expect(computeEventId({ ...base, created_at: 1700000001 })).not.toBe(
      PLAIN_NOTE_ID,
    );
    expect(computeEventId({ ...base, kind: 7 })).not.toBe(PLAIN_NOTE_ID);
    expect(computeEventId({ ...base, content: "hello nostr " })).not.toBe(
      PLAIN_NOTE_ID,
    );
    expect(computeEventId({ ...base, tags: [["t", "x"]] })).not.toBe(
      PLAIN_NOTE_ID,
    );
  });
});

describe("verifyEventSignature", () => {
  it("accepts a real signed event (plain note)", async () => {
    const signed = await signer.signEvent(PLAIN_NOTE);
    expect(signed.id).toBe(PLAIN_NOTE_ID);
    expect(signed.pubkey).toBe(PK);
    expect(verifyEventSignature(signed)).toBe(true);
  });

  it("accepts a real signed event (tagged note with unicode)", async () => {
    const signed = await signer.signEvent(TAGGED_NOTE);
    expect(signed.id).toBe(TAGGED_NOTE_ID);
    expect(verifyEventSignature(signed)).toBe(true);
  });

  it("produces a fresh signature each time that still verifies", async () => {
    const a = await signer.signEvent(PLAIN_NOTE);
    const b = await signer.signEvent(PLAIN_NOTE);
    expect(a.id).toBe(b.id);
    expect(verifyEventSignature(a)).toBe(true);
    expect(verifyEventSignature(b)).toBe(true);
  });

  it("rejects tampered content (id no longer matches)", async () => {
    const signed = await signer.signEvent(PLAIN_NOTE);
    const tampered: NostrEvent = { ...signed, content: "goodbye nostr" };
    expect(verifyEventSignature(tampered)).toBe(false);
  });

  it("rejects tampered tags", async () => {
    const signed = await signer.signEvent(TAGGED_NOTE);
    const tampered: NostrEvent = {
      ...signed,
      tags: [...signed.tags, ["t", "injected"]],
    };
    expect(verifyEventSignature(tampered)).toBe(false);
  });

  it("rejects a tampered id", async () => {
    const signed = await signer.signEvent(PLAIN_NOTE);
    const tampered: NostrEvent = { ...signed, id: TAGGED_NOTE_ID };
    expect(verifyEventSignature(tampered)).toBe(false);
  });

  it("rejects a tampered signature of the right shape", async () => {
    const signed = await signer.signEvent(PLAIN_NOTE);
    const flipped = signed.sig.startsWith("0")
      ? `1${signed.sig.slice(1)}`
      : `0${signed.sig.slice(1)}`;
    expect(verifyEventSignature({ ...signed, sig: flipped })).toBe(false);
    expect(verifyEventSignature({ ...signed, sig: "0".repeat(128) })).toBe(
      false,
    );
  });

  it("rejects an event re-signed under a different author's key", async () => {
    const other = LocalSigner.generate();
    const signed = await other.signEvent(PLAIN_NOTE);
    // Same content, but claim it came from PK: id and sig both stop matching.
    expect(verifyEventSignature({ ...signed, pubkey: PK })).toBe(false);
  });

  it("rejects structurally invalid events without throwing", () => {
    expect(verifyEventSignature({} as unknown as NostrEvent)).toBe(false);
    expect(verifyEventSignature(null as unknown as NostrEvent)).toBe(false);
  });
});

describe("isValidEventShape", () => {
  const valid = {
    id: PLAIN_NOTE_ID,
    pubkey: PK,
    created_at: 1700000000,
    kind: 1,
    tags: [["t", "setu"]],
    content: "hello nostr",
    sig: "a".repeat(128),
  };

  it("accepts a well-formed event", () => {
    expect(isValidEventShape(valid)).toBe(true);
  });

  it("accepts an event with empty tags and empty content", () => {
    expect(isValidEventShape({ ...valid, tags: [], content: "" })).toBe(true);
  });

  const rejected: readonly [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "not an event"],
    ["an array", []],
    ["missing id", { ...valid, id: undefined }],
    ["short id", { ...valid, id: "abc" }],
    ["long id", { ...valid, id: `${PLAIN_NOTE_ID}00` }],
    ["uppercase id", { ...valid, id: PLAIN_NOTE_ID.toUpperCase() }],
    ["non-hex id", { ...valid, id: "z".repeat(64) }],
    ["short pubkey", { ...valid, pubkey: PK.slice(0, 62) }],
    ["short sig", { ...valid, sig: "a".repeat(126) }],
    ["missing sig", { ...valid, sig: undefined }],
    ["non-integer kind", { ...valid, kind: 1.5 }],
    ["string kind", { ...valid, kind: "1" }],
    ["NaN created_at", { ...valid, created_at: Number.NaN }],
    ["Infinity created_at", { ...valid, created_at: Number.POSITIVE_INFINITY }],
    ["string created_at", { ...valid, created_at: "1700000000" }],
    ["tags not an array", { ...valid, tags: "t" }],
    ["tag row not an array", { ...valid, tags: ["t"] }],
    ["tag element not a string", { ...valid, tags: [["e", 1]] }],
    ["nested tag element", { ...valid, tags: [["e", ["nested"]]] }],
    ["content not a string", { ...valid, content: 42 }],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      expect(isValidEventShape(input)).toBe(false);
    });
  }
});
