import { describe, expect, it } from "vitest";
import {
  nip05DisplayName,
  nip05MappedPubkey,
  nip05MatchesPubkey,
  nip05WellKnownUrl,
  parseNip05,
} from "./nip05";

const PUBKEY = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("parseNip05", () => {
  it("splits a normal identifier and lowercases both halves", () => {
    expect(parseNip05("Alice@Example.com")).toEqual({
      local: "alice",
      domain: "example.com",
    });
  });

  it("accepts the characters NIP-05 allows in a local part", () => {
    expect(parseNip05("a.b-c_1@sub.example.co.uk")).toEqual({
      local: "a.b-c_1",
      domain: "sub.example.co.uk",
    });
  });

  it("treats an identifier with no @ that looks like a domain as _@domain", () => {
    expect(parseNip05("example.com")).toEqual({
      local: "_",
      domain: "example.com",
    });
  });

  it("rejects an identifier with no @ that is not a hostname", () => {
    expect(parseNip05("notanidentifier")).toBeUndefined();
  });

  it("rejects an empty or whitespace identifier", () => {
    expect(parseNip05("")).toBeUndefined();
    expect(parseNip05("   ")).toBeUndefined();
  });

  it("rejects more than one @", () => {
    expect(parseNip05("a@b@example.com")).toBeUndefined();
  });

  it("rejects a local part with characters NIP-05 does not allow", () => {
    expect(parseNip05("al ice@example.com")).toBeUndefined();
    expect(parseNip05("al/ice@example.com")).toBeUndefined();
    expect(parseNip05("ali+ce@example.com")).toBeUndefined();
  });

  it("rejects a domain carrying a path, query, port or credentials", () => {
    expect(parseNip05("a@example.com/evil")).toBeUndefined();
    expect(parseNip05("a@example.com?x=1")).toBeUndefined();
    expect(parseNip05("a@example.com:8080")).toBeUndefined();
    expect(parseNip05("a@user:pw@example.com")).toBeUndefined();
  });

  it("rejects a dotless host", () => {
    expect(parseNip05("a@localhost")).toBeUndefined();
  });
});

describe("nip05WellKnownUrl", () => {
  it("builds the https well-known URL with the name encoded", () => {
    expect(nip05WellKnownUrl({ local: "alice", domain: "example.com" })).toBe(
      "https://example.com/.well-known/nostr.json?name=alice",
    );
  });

  it("uses _ for a domain-root identifier", () => {
    expect(nip05WellKnownUrl({ local: "_", domain: "example.com" })).toBe(
      "https://example.com/.well-known/nostr.json?name=_",
    );
  });
});

describe("nip05MappedPubkey", () => {
  it("reads the mapped pubkey for the local part", () => {
    const body = JSON.stringify({ names: { alice: PUBKEY, bob: OTHER } });
    expect(nip05MappedPubkey(body, "alice")).toBe(PUBKEY);
  });

  it("normalizes an uppercase hex mapping", () => {
    const body = JSON.stringify({ names: { alice: PUBKEY.toUpperCase() } });
    expect(nip05MappedPubkey(body, "alice")).toBe(PUBKEY);
  });

  it("returns undefined on malformed JSON", () => {
    expect(nip05MappedPubkey("{not json", "alice")).toBeUndefined();
    expect(nip05MappedPubkey("", "alice")).toBeUndefined();
    expect(nip05MappedPubkey("<html>404</html>", "alice")).toBeUndefined();
  });

  it("returns undefined when the names key is missing or not an object", () => {
    expect(nip05MappedPubkey(JSON.stringify({}), "alice")).toBeUndefined();
    expect(
      nip05MappedPubkey(JSON.stringify({ relays: {} }), "alice"),
    ).toBeUndefined();
    expect(
      nip05MappedPubkey(JSON.stringify({ names: [PUBKEY] }), "alice"),
    ).toBeUndefined();
    expect(
      nip05MappedPubkey(JSON.stringify({ names: null }), "alice"),
    ).toBeUndefined();
    expect(nip05MappedPubkey(JSON.stringify(null), "alice")).toBeUndefined();
  });

  it("returns undefined when the local part is absent from names", () => {
    const body = JSON.stringify({ names: { bob: OTHER } });
    expect(nip05MappedPubkey(body, "alice")).toBeUndefined();
  });

  it("rejects a mapping that is not 32-byte hex", () => {
    expect(
      nip05MappedPubkey(JSON.stringify({ names: { alice: "nope" } }), "alice"),
    ).toBeUndefined();
    expect(
      nip05MappedPubkey(JSON.stringify({ names: { alice: 42 } }), "alice"),
    ).toBeUndefined();
    expect(
      nip05MappedPubkey(
        JSON.stringify({ names: { alice: `${PUBKEY}ff` } }),
        "alice",
      ),
    ).toBeUndefined();
  });
});

describe("nip05MatchesPubkey", () => {
  it("passes on a correct round trip", () => {
    const body = JSON.stringify({ names: { alice: PUBKEY } });
    expect(nip05MatchesPubkey(body, "alice", PUBKEY)).toBe(true);
    expect(nip05MatchesPubkey(body, "alice", PUBKEY.toUpperCase())).toBe(true);
  });

  it("fails when the domain names a different pubkey", () => {
    const body = JSON.stringify({ names: { alice: OTHER } });
    expect(nip05MatchesPubkey(body, "alice", PUBKEY)).toBe(false);
  });

  it("fails on malformed JSON rather than passing by default", () => {
    expect(nip05MatchesPubkey("{", "alice", PUBKEY)).toBe(false);
  });

  it("fails when names is missing", () => {
    expect(nip05MatchesPubkey("{}", "alice", PUBKEY)).toBe(false);
  });
});

describe("nip05DisplayName", () => {
  it("hides the _ local part", () => {
    expect(nip05DisplayName("_@example.com")).toBe("example.com");
    expect(nip05DisplayName("example.com")).toBe("example.com");
  });

  it("keeps a normal identifier intact", () => {
    expect(nip05DisplayName("Alice@Example.com")).toBe("alice@example.com");
  });

  it("returns an unparseable identifier unchanged", () => {
    expect(nip05DisplayName("nonsense")).toBe("nonsense");
  });
});
