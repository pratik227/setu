import { describe, expect, it } from "vitest";
import { bolt11Sats, zapReceiptSats } from "./bolt11";

describe("bolt11Sats", () => {
  it("reads the standard multiplier suffixes", () => {
    // 2500u BTC = 0.0025 BTC = 250_000 sats
    expect(bolt11Sats("lnbc2500u1pvjluezpp5abc")).toBe(250_000);
    // 1m BTC = 0.001 BTC = 100_000 sats
    expect(bolt11Sats("lnbc1m1pvjluez")).toBe(100_000);
    // 100n BTC = 10 sats
    expect(bolt11Sats("lnbc100n1pvjluez")).toBe(10);
    // 1000p BTC = 0.1 sat: floored to 0 rather than rounded up, so a total is
    // never larger than what was paid.
    expect(bolt11Sats("lnbc1000p1pvjluez")).toBe(0);
  });

  it("treats an amount with no multiplier as whole bitcoin", () => {
    // "lnbc2" + separator "1" + data → 2 BTC.
    expect(bolt11Sats("lnbc21pvjluez")).toBe(200_000_000);
  });

  it("handles testnet and regtest prefixes", () => {
    expect(bolt11Sats("lntb100n1pvjluez")).toBe(10);
    expect(bolt11Sats("lnbcrt100n1pvjluez")).toBe(10);
  });

  it("is case insensitive and tolerates surrounding space", () => {
    expect(bolt11Sats("  LNBC100N1PVJLUEZ  ")).toBe(10);
  });

  it("returns undefined for an amountless or unreadable invoice", () => {
    // `lnbc1…`: the 1 is the bech32 separator, so there is NO amount. Reading it
    // as 1 BTC is the bug this case exists to pin down.
    expect(bolt11Sats("lnbc1pvjluez")).toBe(undefined);
    expect(bolt11Sats("not-an-invoice")).toBe(undefined);
    expect(bolt11Sats("")).toBe(undefined);
    expect(bolt11Sats("lnbc")).toBe(undefined);
  });
});

describe("zapReceiptSats", () => {
  it("prefers the paid invoice over the requested amount tag", () => {
    // The amount tag states the sender's intent; the invoice is what was paid.
    // When they disagree the invoice wins, so a total can never be inflated by
    // a client that lies in its zap request.
    const sats = zapReceiptSats([
      ["bolt11", "lnbc100n1pvjluez"],
      ["amount", "999000"],
    ]);
    expect(sats).toBe(10);
  });

  it("falls back to the amount tag when the invoice has no amount", () => {
    expect(zapReceiptSats([["amount", "21000"]])).toBe(21);
  });

  it("is zero when neither source is usable", () => {
    expect(zapReceiptSats([])).toBe(0);
    expect(zapReceiptSats([["amount", "not-a-number"]])).toBe(0);
    expect(zapReceiptSats([["amount", "-5"]])).toBe(0);
    expect(zapReceiptSats([["bolt11", "garbage"]])).toBe(0);
  });
});
