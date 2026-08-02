import { describe, expect, it } from "vitest";
import {
  deriveFromSeedPhrase,
  generateSeedPhrase,
  normalizeSeedPhrase,
  seedPhraseMessage,
  seedPhraseWordCount,
  validateSeedPhrase,
} from "./nip06";

/**
 * NIP-06 seed phrases.
 *
 * The failure worth guarding is not a crash: derivation succeeds on a mistyped
 * word and produces a *different, valid-looking* key, so the user signs in to an
 * empty profile and concludes their notes are gone. Everything here exists to make
 * that impossible.
 */

// The canonical BIP-39 test vector, and the key NIP-06 derives from it. Fixed
// rather than generated: this is the one calculation that must agree byte for byte
// with every other client, so the expected value has to come from outside.
const VECTOR =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";
const VECTOR_SECRET =
  "7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("normalizeSeedPhrase", () => {
  it("collapses the formatting a pasted phrase carries", () => {
    // Rejecting this would be a validation failure about whitespace rather than
    // about the words, which is not the user's mistake.
    expect(normalizeSeedPhrase("  Leader   monkey\nparrot ")).toBe(
      "leader monkey parrot",
    );
  });

  it("counts words after normalising", () => {
    expect(seedPhraseWordCount("  leader   monkey ")).toBe(2);
    expect(seedPhraseWordCount("   ")).toBe(0);
  });
});

describe("validateSeedPhrase", () => {
  it("accepts the reference phrase", () => {
    expect(validateSeedPhrase(VECTOR)).toBeUndefined();
  });

  it("accepts it despite messy formatting and case", () => {
    expect(validateSeedPhrase(`  ${VECTOR.toUpperCase()}\n`)).toBeUndefined();
  });

  it("separates a length problem from a checksum problem", () => {
    // Different remedies: "you are missing a word" versus "one word is mistyped".
    // A single "invalid phrase" leaves the user re-reading all twelve.
    expect(validateSeedPhrase("")).toBe("empty");
    expect(validateSeedPhrase("   ")).toBe("empty");
    expect(validateSeedPhrase("leader monkey parrot")).toBe("wrong-length");
    expect(validateSeedPhrase(VECTOR.split(" ").slice(0, 11).join(" "))).toBe(
      "wrong-length",
    );
  });

  it("catches a phrase whose words are real but whose checksum fails", () => {
    // The whole point. Every word below is in the BIP-39 list, so only the
    // checksum distinguishes this from the real phrase.
    const words = VECTOR.split(" ");
    words[0] = "zebra";
    expect(validateSeedPhrase(words.join(" "))).toBe("bad-checksum");
  });

  it("catches a word that is not in the list at all", () => {
    const words = VECTOR.split(" ");
    words[3] = "notaword";
    expect(validateSeedPhrase(words.join(" "))).toBe("bad-checksum");
  });
});

describe("deriveFromSeedPhrase", () => {
  it("derives the documented key for the reference phrase", () => {
    // Interoperability, asserted against a value from outside this codebase: a
    // path implemented subtly wrong still produces a valid key, and the user only
    // finds out when their account is empty.
    const derived = deriveFromSeedPhrase(VECTOR);
    expect(derived).toBeDefined();
    expect(hex(derived?.secretKey ?? new Uint8Array())).toBe(VECTOR_SECRET);
    expect(derived?.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across formatting differences", () => {
    const a = deriveFromSeedPhrase(VECTOR);
    const b = deriveFromSeedPhrase(`  ${VECTOR.toUpperCase()}  `);
    expect(hex(b?.secretKey ?? new Uint8Array())).toBe(
      hex(a?.secretKey ?? new Uint8Array()),
    );
  });

  it("refuses an invalid phrase instead of deriving something", () => {
    // Never return a key for a phrase that failed the checksum: that key is a
    // real, usable, *wrong* account.
    const words = VECTOR.split(" ");
    words[0] = "zebra";
    expect(deriveFromSeedPhrase(words.join(" "))).toBeUndefined();
    expect(deriveFromSeedPhrase("")).toBeUndefined();
  });

  it("treats a passphrase as a different key, not a password", () => {
    // BIP-39's 25th word changes the derived account. There is no wrong-passphrase
    // error to give, which is why the caller shows the pubkey for confirmation.
    const plain = deriveFromSeedPhrase(VECTOR);
    const salted = deriveFromSeedPhrase(VECTOR, { passphrase: "extra" });
    expect(salted).toBeDefined();
    expect(salted?.pubkey).not.toBe(plain?.pubkey);
  });

  it("derives a different account per index", () => {
    const first = deriveFromSeedPhrase(VECTOR, { accountIndex: 0 });
    const second = deriveFromSeedPhrase(VECTOR, { accountIndex: 1 });
    expect(second?.pubkey).not.toBe(first?.pubkey);
  });
});

describe("generateSeedPhrase", () => {
  it("produces a valid twelve-word phrase that derives a key", () => {
    const phrase = generateSeedPhrase();
    expect(seedPhraseWordCount(phrase)).toBe(12);
    expect(validateSeedPhrase(phrase)).toBeUndefined();
    expect(deriveFromSeedPhrase(phrase)).toBeDefined();
  });

  it("does not repeat itself", () => {
    expect(generateSeedPhrase()).not.toBe(generateSeedPhrase());
  });
});

describe("seedPhraseMessage", () => {
  it("words every failure without echoing the phrase", () => {
    for (const error of ["empty", "wrong-length", "bad-checksum"] as const) {
      const message = seedPhraseMessage(error);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("leader");
    }
  });
});
