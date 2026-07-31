import { describe, expect, it } from "vitest";
import {
  balanceFromResult,
  buildWalletRequest,
  msat,
  msatFromSat,
  parseWalletInfo,
  parseWalletResponse,
  parseWalletUri,
  satFromMsat,
  supportsNip44,
  WALLET_REQUEST_KIND,
  walletRequestPayload,
  walletUriMessage,
} from "./nip47";
import type { NostrEvent } from "./types";

const WALLET = "a".repeat(64);
const SECRET = "b".repeat(64);
const URI = `nostr+walletconnect://${WALLET}?relay=wss://relay.example&secret=${SECRET}`;

function infoEvent(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: WALLET,
    created_at: 1_700_000_000,
    kind: 13194,
    tags: [],
    content: "pay_invoice get_balance make_invoice",
    sig: "0".repeat(128),
    ...over,
  };
}

describe("parseWalletUri", () => {
  it("parses pubkey, relay and secret", () => {
    const result = parseWalletUri(URI);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.walletPubkey).toBe(WALLET);
    expect(result.connection.relays).toEqual(["wss://relay.example"]);
    expect(result.connection.secret).toBe(SECRET);
  });

  it("keeps every relay, in order, deduplicated", () => {
    const result = parseWalletUri(
      `nostr+walletconnect://${WALLET}?relay=wss://a.example&relay=wss://b.example&relay=wss://a.example&secret=${SECRET}`,
    );
    expect(result.ok && result.connection.relays).toEqual([
      "wss://a.example",
      "wss://b.example",
    ]);
  });

  it("accepts the legacy scheme and a trailing slash before the query", () => {
    for (const uri of [
      `nostrwalletconnect://${WALLET}?relay=wss://a.example&secret=${SECRET}`,
      `nostr+walletconnect://${WALLET}/?relay=wss://a.example&secret=${SECRET}`,
    ]) {
      expect(parseWalletUri(uri).ok).toBe(true);
    }
  });

  it("lowercases hex so downstream filters match", () => {
    const result = parseWalletUri(
      `nostr+walletconnect://${WALLET.toUpperCase()}?relay=wss://a.example&secret=${SECRET.toUpperCase()}`,
    );
    expect(result.ok && result.connection.walletPubkey).toBe(WALLET);
    expect(result.ok && result.connection.secret).toBe(SECRET);
  });

  it.each([
    ["https://example.com", "not-a-wallet-uri"],
    [
      `nostr+walletconnect://?relay=wss://a.example&secret=${SECRET}`,
      "missing-pubkey",
    ],
    [
      `nostr+walletconnect://zz?relay=wss://a.example&secret=${SECRET}`,
      "bad-pubkey",
    ],
    [`nostr+walletconnect://${WALLET}?secret=${SECRET}`, "missing-relay"],
    [
      `nostr+walletconnect://${WALLET}?relay=http://a.example&secret=${SECRET}`,
      "bad-relay",
    ],
    [`nostr+walletconnect://${WALLET}?relay=wss://a.example`, "missing-secret"],
    [
      `nostr+walletconnect://${WALLET}?relay=wss://a.example&secret=nope`,
      "bad-secret",
    ],
  ])("rejects %s as %s", (uri, reason) => {
    const result = parseWalletUri(uri);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(reason);
  });

  it("never echoes the input in the reader-facing message", () => {
    // The whole reason parsing returns a code. The secret is a live spending key, and
    // an error string containing it ends up in a console, a log or a bug report.
    const result = parseWalletUri(
      `nostr+walletconnect://${WALLET}?relay=wss://a.example&secret=short`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = walletUriMessage(result.reason);
    expect(message).not.toContain("short");
    expect(message).not.toContain(WALLET);
    for (const reason of [
      "not-a-wallet-uri",
      "missing-pubkey",
      "bad-pubkey",
      "missing-relay",
      "bad-relay",
      "missing-secret",
      "bad-secret",
    ] as const) {
      expect(walletUriMessage(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("msat units", () => {
  it("converts sats to msat", () => {
    expect(msatFromSat(21)).toBe(21_000);
    expect(msatFromSat(0)).toBe(0);
  });

  it("rounds a fractional sat rather than truncating", () => {
    // A fractional sat can only come from a rate conversion, and flooring there
    // underpays by up to a sat on every payment.
    expect(msatFromSat(0.5)).toBe(500);
    expect(msatFromSat(1.9994)).toBe(1999);
  });

  it("floors when showing sats, so a balance is never overstated", () => {
    expect(satFromMsat(msat(5_999))).toBe(5);
    expect(satFromMsat(msat(0))).toBe(0);
  });

  it("refuses a negative or non-integer msat amount", () => {
    expect(() => msat(-1)).toThrow(RangeError);
    expect(() => msat(1.5)).toThrow(RangeError);
    expect(() => msat(Number.NaN)).toThrow(RangeError);
    expect(() => msatFromSat(-1)).toThrow(RangeError);
  });
});

describe("buildWalletRequest", () => {
  it("tags the wallet and carries the ciphertext unchanged", () => {
    const template = buildWalletRequest({
      walletPubkey: WALLET as never,
      content: "ciphertext",
      createdAt: 1_700_000_000,
    });
    expect(template.kind).toBe(WALLET_REQUEST_KIND);
    expect(template.content).toBe("ciphertext");
    expect(template.tags).toEqual([["p", WALLET]]);
  });

  it("marks nip44 and carries an expiration when asked", () => {
    const template = buildWalletRequest({
      walletPubkey: WALLET as never,
      content: "c",
      createdAt: 1_700_000_000,
      nip44: true,
      expiration: 1_700_000_060.9,
    });
    expect(template.tags).toContainEqual(["encryption", "nip44_v2"]);
    // Floored: a relay parses this as an integer and a decimal is not one.
    expect(template.tags).toContainEqual(["expiration", "1700000060"]);
  });

  it("serialises a payload as method plus params", () => {
    expect(
      walletRequestPayload({
        method: "pay_invoice",
        params: { invoice: "lnbc1" },
      }),
    ).toBe('{"method":"pay_invoice","params":{"invoice":"lnbc1"}}');
  });
});

describe("parseWalletResponse", () => {
  it("reads a success result", () => {
    const parsed = parseWalletResponse(
      '{"result_type":"get_balance","result":{"balance":1000}}',
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.resultType).toBe("get_balance");
    expect(parsed.ok && parsed.result.balance).toBe(1000);
  });

  it("reads an error with its code and message", () => {
    const parsed = parseWalletResponse(
      '{"error":{"code":"INSUFFICIENT_BALANCE","message":"not enough"}}',
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.code).toBe("INSUFFICIENT_BALANCE");
    expect(!parsed.ok && parsed.message).toBe("not enough");
  });

  it("prefers the error over a null result on the same body", () => {
    // Order is load-bearing: reading `result` first would turn a refusal into a
    // success, and the user would be told a failed payment went through.
    const parsed = parseWalletResponse(
      '{"result_type":"pay_invoice","result":null,"error":{"code":"PAYMENT_FAILED"}}',
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.code).toBe("PAYMENT_FAILED");
  });

  it("maps an unknown code to OTHER rather than dropping it", () => {
    const parsed = parseWalletResponse('{"error":{"code":"WEIRD_NEW_CODE"}}');
    expect(!parsed.ok && parsed.code).toBe("OTHER");
    // And it still carries readable copy rather than an empty string.
    expect(!parsed.ok && parsed.message.length).toBeGreaterThan(0);
  });

  it.each([
    "not json",
    "null",
    '"a string"',
    "[]",
    '{"result_type":"pay_invoice"}',
    '{"result_type":"pay_invoice","result":null}',
  ])("treats %o as an error, never an empty success", (body) => {
    // The failure being guarded: a reply whose result never arrived read as
    // `{ok:true, result:{}}` and rendered as a completed payment.
    expect(parseWalletResponse(body).ok).toBe(false);
  });
});

describe("parseWalletInfo", () => {
  it("splits the advertised method list", () => {
    expect(parseWalletInfo(infoEvent())).toEqual([
      "pay_invoice",
      "get_balance",
      "make_invoice",
    ]);
  });

  it("tolerates odd whitespace and an empty list", () => {
    expect(
      parseWalletInfo(infoEvent({ content: "  pay_invoice \n\n x " })),
    ).toEqual(["pay_invoice", "x"]);
    expect(parseWalletInfo(infoEvent({ content: "   " }))).toEqual([]);
  });

  it("ignores an event of the wrong kind", () => {
    expect(parseWalletInfo(infoEvent({ kind: 1 }))).toEqual([]);
    expect(supportsNip44(infoEvent({ kind: 1 }))).toBe(false);
  });

  it("detects advertised nip44 support", () => {
    expect(supportsNip44(infoEvent())).toBe(false);
    expect(
      supportsNip44(infoEvent({ tags: [["encryption", "nip44_v2"]] })),
    ).toBe(true);
    expect(
      supportsNip44(infoEvent({ tags: [["encryption", "nip04", "nip44_v2"]] })),
    ).toBe(true);
  });
});

describe("balanceFromResult", () => {
  it("reads a numeric balance as msat", () => {
    expect(balanceFromResult({ balance: 21_000 })).toBe(21_000);
  });

  it("returns undefined rather than 0 when the wallet did not answer", () => {
    // Same rule as `formatCount`: a zero balance for a wallet that never said is a
    // statement about the user's money that we have no basis for.
    for (const result of [
      {},
      { balance: "1000" },
      { balance: null },
      { balance: Number.NaN },
      { balance: -5 },
    ]) {
      expect(balanceFromResult(result)).toBeUndefined();
    }
  });
});
