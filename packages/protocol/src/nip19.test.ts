import { describe, expect, it } from "vitest";
import { hexToBytes } from "./hex";
import {
  decodeAny,
  encodeNaddr,
  encodeNevent,
  encodeNote,
  encodeNprofile,
  encodeNpub,
  encodeNsec,
  encodeRef,
  looksLikeNip19,
  stripNostrScheme,
  toEventId,
  toPubkey,
  truncateNpub,
} from "./nip19";

const PUBKEY =
  "53aba620395a09ade0d0115678215b1d565f680adeef7a5c385988a49447eb3c";
const NPUB = "npub12w46vgpetgy6mcxsz9t8sg2mr4t976q2mmhh5hpctxy2f9z8av7qktfcnk";
const SECRET_HEX =
  "5426e4dbdda01dd54f0d5b1d1a0e9db4c8b3d0e5a2b1f4c7d9e8a6b5c4d3e2f1";
const NSEC = "nsec12snwfk7a5qwa2ncdtvw35r5aknyt858952clf37eazntt3xnutcs7rnylr";
const EVENT_ID =
  "11808a5462dda72e28fc3301d8b773e5f5272c8d5d5577a267c1920b646fa160";
const NOTE = "note1zxqg54rzmknju28uxvqa3dmnuh6jwtydt42h0gn8cxfqker059sqdqxghe";
const RELAYS = ["wss://relay.example.com", "wss://nos.lol"];

describe("known vectors", () => {
  it("encodes and decodes a known npub", () => {
    expect(encodeNpub(PUBKEY)).toBe(NPUB);
    expect(decodeAny(NPUB)).toEqual({ type: "npub", pubkey: PUBKEY });
  });

  it("encodes and decodes a known note", () => {
    expect(encodeNote(EVENT_ID)).toBe(NOTE);
    expect(decodeAny(NOTE)).toEqual({ type: "note", id: EVENT_ID });
  });

  it("encodes and decodes a known nsec", () => {
    const bytes = hexToBytes(SECRET_HEX);
    expect(bytes).toBeDefined();
    expect(encodeNsec(bytes as Uint8Array)).toBe(NSEC);
    const decoded = decodeAny(NSEC);
    expect(decoded?.type).toBe("nsec");
    if (decoded?.type === "nsec") {
      expect(decoded.secretKey).toEqual(bytes);
    }
  });
});

describe("round trips", () => {
  it("npub", () => {
    const encoded = encodeNpub(PUBKEY);
    expect(encoded).toBeDefined();
    expect(decodeAny(encoded as string)).toEqual({
      type: "npub",
      pubkey: PUBKEY,
    });
  });

  it("note", () => {
    const encoded = encodeNote(EVENT_ID);
    expect(decodeAny(encoded as string)).toEqual({
      type: "note",
      id: EVENT_ID,
    });
  });

  it("nprofile with relays", () => {
    const encoded = encodeNprofile({ pubkey: PUBKEY, relays: RELAYS });
    expect(encoded?.startsWith("nprofile1")).toBe(true);
    expect(decodeAny(encoded as string)).toEqual({
      type: "nprofile",
      pubkey: PUBKEY,
      relays: RELAYS,
    });
  });

  it("nprofile without relays", () => {
    const encoded = encodeNprofile({ pubkey: PUBKEY });
    expect(decodeAny(encoded as string)).toEqual({
      type: "nprofile",
      pubkey: PUBKEY,
      relays: undefined,
    });
  });

  it("nevent with author and kind", () => {
    const encoded = encodeNevent({
      id: EVENT_ID,
      relays: [RELAYS[0] as string],
      author: PUBKEY,
      kind: 1,
    });
    expect(encoded?.startsWith("nevent1")).toBe(true);
    expect(decodeAny(encoded as string)).toEqual({
      type: "nevent",
      id: EVENT_ID,
      relays: [RELAYS[0]],
      author: PUBKEY,
      kind: 1,
    });
  });

  it("naddr", () => {
    const encoded = encodeNaddr({
      identifier: "setu-manifesto",
      pubkey: PUBKEY,
      kind: 30023,
      relays: RELAYS,
    });
    expect(encoded?.startsWith("naddr1")).toBe(true);
    expect(decodeAny(encoded as string)).toEqual({
      type: "naddr",
      identifier: "setu-manifesto",
      pubkey: PUBKEY,
      kind: 30023,
      relays: RELAYS,
    });
  });

  it("naddr with an empty identifier", () => {
    const encoded = encodeNaddr({
      identifier: "",
      pubkey: PUBKEY,
      kind: 30000,
    });
    const decoded = decodeAny(encoded as string);
    expect(decoded).toEqual({
      type: "naddr",
      identifier: "",
      pubkey: PUBKEY,
      kind: 30000,
      relays: undefined,
    });
  });

  it("encodeRef re-encodes every decoded ref", () => {
    for (const encoded of [NPUB, NOTE, NSEC]) {
      const ref = decodeAny(encoded);
      expect(ref).toBeDefined();
      expect(encodeRef(ref as NonNullable<typeof ref>)).toBe(encoded);
    }
  });
});

describe("nostr: URI scheme", () => {
  it("decodes with the scheme prefix", () => {
    expect(decodeAny(`nostr:${NPUB}`)).toEqual({
      type: "npub",
      pubkey: PUBKEY,
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(decodeAny(`  nostr:${NPUB}  `)).toEqual({
      type: "npub",
      pubkey: PUBKEY,
    });
  });

  it("strips the scheme", () => {
    expect(stripNostrScheme(`nostr:${NPUB}`)).toBe(NPUB);
    expect(stripNostrScheme(NPUB)).toBe(NPUB);
  });

  it("recognizes decodable prefixes", () => {
    expect(looksLikeNip19(NPUB)).toBe(true);
    expect(looksLikeNip19(`nostr:${NOTE}`)).toBe(true);
    expect(looksLikeNip19("ncryptsec1abc")).toBe(false);
    expect(looksLikeNip19(PUBKEY)).toBe(false);
  });

  it("decodes an all-uppercase entity", () => {
    expect(decodeAny(NPUB.toUpperCase())).toEqual({
      type: "npub",
      pubkey: PUBKEY,
    });
  });
});

describe("malformed input never throws", () => {
  const bad = [
    "",
    " ",
    "nostr:",
    "npub",
    "npub1",
    "npub1!!!",
    "npub1notavalidkeyatall",
    `${NPUB}extra`,
    NPUB.slice(0, -1),
    `${NPUB.slice(0, -1)}q`,
    "note1qqqq",
    "nprofile1",
    "naddr1zzzz",
    "hello world",
    PUBKEY,
    "ncryptsec1abcdef",
    "nrelay1qqqq",
    "0x1234",
    "🙂",
    "nostr:nostr:npub1",
  ];

  for (const input of bad) {
    it(`returns undefined for ${JSON.stringify(input)}`, () => {
      expect(() => decodeAny(input)).not.toThrow();
      expect(decodeAny(input)).toBeUndefined();
    });
  }

  it("rejects bad encode inputs without throwing", () => {
    expect(encodeNpub("nothex")).toBeUndefined();
    expect(encodeNpub(PUBKEY.toUpperCase())).toBeUndefined();
    expect(encodeNote("abc")).toBeUndefined();
    expect(encodeNsec(new Uint8Array(31))).toBeUndefined();
    expect(encodeNprofile({ pubkey: "short" })).toBeUndefined();
    expect(encodeNevent({ id: "" })).toBeUndefined();
    expect(
      encodeNaddr({ identifier: "x", pubkey: "short", kind: 30023 }),
    ).toBeUndefined();
    expect(
      encodeNaddr({ identifier: "x", pubkey: PUBKEY, kind: 1.5 }),
    ).toBeUndefined();
  });
});

describe("projections", () => {
  it("toPubkey extracts a pubkey where one exists", () => {
    expect(toPubkey(NPUB)).toBe(PUBKEY);
    expect(toPubkey(encodeNprofile({ pubkey: PUBKEY }) as string)).toBe(PUBKEY);
    expect(
      toPubkey(
        encodeNaddr({ identifier: "d", pubkey: PUBKEY, kind: 30023 }) as string,
      ),
    ).toBe(PUBKEY);
    expect(
      toPubkey(encodeNevent({ id: EVENT_ID, author: PUBKEY }) as string),
    ).toBe(PUBKEY);
    expect(toPubkey(NOTE)).toBeUndefined();
    expect(toPubkey("garbage")).toBeUndefined();
  });

  it("toEventId extracts an event id where one exists", () => {
    expect(toEventId(NOTE)).toBe(EVENT_ID);
    expect(toEventId(encodeNevent({ id: EVENT_ID }) as string)).toBe(EVENT_ID);
    expect(toEventId(NPUB)).toBeUndefined();
    expect(toEventId("garbage")).toBeUndefined();
  });
});

describe("truncateNpub", () => {
  it("keeps characters from both ends", () => {
    expect(truncateNpub(NPUB)).toBe("npub12w4…7qktfcnk");
    expect(truncateNpub(NPUB, 4)).toBe("npub…fcnk");
  });

  it("returns short input unchanged", () => {
    expect(truncateNpub("npub1abc", 8)).toBe("npub1abc");
    expect(truncateNpub("", 8)).toBe("");
  });

  it("returns the input unchanged for a non-positive width", () => {
    expect(truncateNpub(NPUB, 0)).toBe(NPUB);
  });
});
