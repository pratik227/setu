import { describe, expect, it } from "vitest";
import {
  decryptNip04,
  encryptNip04,
  looksLikeNip04,
  Nip04Error,
} from "./nip04";
import { generateSecretKey, getPublicKey } from "./signers";
import type { Hex32 } from "./types";

const alice = generateSecretKey();
const bob = generateSecretKey();
const alicePub = getPublicKey(alice) as Hex32;
const bobPub = getPublicKey(bob) as Hex32;

describe("NIP-04 round trip", () => {
  it("decrypts what the other party encrypted", () => {
    // The property that matters: ECDH is symmetric, so Bob's key against Alice's
    // pubkey derives the same secret as Alice's key against Bob's.
    const payload = '{"method":"get_balance","params":{}}';
    const ciphertext = encryptNip04(alice, bobPub, payload);
    expect(decryptNip04(bob, alicePub, ciphertext)).toBe(payload);
  });

  it("produces the NIP-04 wire shape", () => {
    const ciphertext = encryptNip04(alice, bobPub, "hi");
    expect(looksLikeNip04(ciphertext)).toBe(true);
    expect(ciphertext).toContain("?iv=");
  });

  it("uses a fresh IV, so the same plaintext does not repeat", () => {
    // Deterministic ciphertext would tell a relay that two requests were identical —
    // "this client asked the same thing twice" is metadata worth not leaking.
    const a = encryptNip04(alice, bobPub, "same");
    const b = encryptNip04(alice, bobPub, "same");
    expect(a).not.toBe(b);
    expect(decryptNip04(bob, alicePub, a)).toBe("same");
    expect(decryptNip04(bob, alicePub, b)).toBe("same");
  });

  it("round-trips unicode and an empty string", () => {
    for (const text of ["₿ 21", "日本語", "🙂", ""]) {
      const ciphertext = encryptNip04(alice, bobPub, text);
      expect(decryptNip04(bob, alicePub, ciphertext)).toBe(text);
    }
  });

  it("round-trips a payload larger than one AES block", () => {
    const long = JSON.stringify({
      method: "pay_invoice",
      params: { invoice: "x".repeat(700) },
    });
    const ciphertext = encryptNip04(alice, bobPub, long);
    expect(decryptNip04(bob, alicePub, ciphertext)).toBe(long);
  });
});

describe("NIP-04 failure", () => {
  it("throws for the wrong key rather than returning garbage", () => {
    const eve = generateSecretKey();
    const ciphertext = encryptNip04(alice, bobPub, "secret");
    // CBC is unauthenticated, so a wrong key can occasionally decrypt to bytes that
    // are not valid UTF-8 or fail padding — either way it must throw, never return a
    // string a caller might parse.
    expect(() => decryptNip04(eve, alicePub, ciphertext)).toThrow(Nip04Error);
  });

  it("throws on malformed ciphertext", () => {
    for (const bad of ["", "not-base64!!", "abc", "abc?iv=", "?iv=abc"]) {
      expect(() => decryptNip04(bob, alicePub, bad)).toThrow(Nip04Error);
    }
  });

  it("never puts the plaintext, key or peer in the error message", () => {
    // This runs on a wallet command path; an error string in a console is the one
    // place a spending key or a payment amount could leak from.
    try {
      decryptNip04(bob, alicePub, "not-base64!!");
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(alicePub);
      expect(message).not.toContain("not-base64");
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe("looksLikeNip04", () => {
  it("recognises the NIP-04 shape", () => {
    expect(looksLikeNip04("YWJj?iv=ZGVm")).toBe(true);
  });

  it("rejects a NIP-44 payload and other strings", () => {
    // NIP-44 v2 is a single base64 blob with no `?iv=`. Telling them apart is what
    // lets the transport recover when a wallet's advertised encryption disagrees with
    // what it actually sent.
    for (const value of [
      "AinT3ZGVmYWJjZGVm",
      "",
      "?iv=",
      "YWJj?iv=",
      "YWJj?iv=ZGVm?iv=ZGVm",
      '{"method":"get_balance"}',
    ]) {
      expect(looksLikeNip04(value)).toBe(false);
    }
  });
});
