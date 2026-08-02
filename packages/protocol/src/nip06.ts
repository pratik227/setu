/**
 * NIP-06: deriving a Nostr key from a BIP-39 seed phrase.
 *
 * Twelve words at `m/44'/1237'/0'/0/0`. Worth supporting for one reason that has
 * nothing to do with cryptography: it is how a large number of people already have
 * their key backed up. A client that only accepts `nsec` tells someone holding a
 * perfectly good seed phrase that their key is unusable here, and the workaround —
 * derive it somewhere else, paste the nsec — routes their secret through another
 * program.
 *
 * ## Derivation is not hand-rolled
 *
 * `nostr-tools/nip06` does the BIP-39 mnemonic-to-seed and the BIP-32 walk, exactly
 * as `signers/local.ts` uses `nostr-tools/nip44` and `nip04.ts` uses its NIP-04. A
 * derivation path implemented from the spec here would be a novel implementation of
 * the one calculation that must agree, byte for byte, with every other client the
 * user might restore into.
 *
 * ## Validation before derivation, always
 *
 * BIP-39 mnemonics carry a checksum, and that checksum is the only thing standing
 * between a mistyped word and a *silently different key*. Derivation itself does not
 * fail on a wrong word — it happily produces a valid-looking key for an account that
 * does not exist, so the user signs in to an empty profile and concludes their notes
 * are gone. So {@link validateSeedPhrase} runs first and the failure is reported as
 * a phrase problem, never as an empty account.
 *
 * ## An optional passphrase is a different key, not a password
 *
 * BIP-39's 25th-word passphrase changes the derived key rather than protecting it.
 * There is no wrong-passphrase error to give, because every passphrase is valid and
 * produces some key — which is why {@link deriveFromSeedPhrase} returns the pubkey
 * alongside, so a caller can show it and let the user confirm they recognise it
 * before anything is stored.
 */

import {
  accountFromSeedWords,
  generateSeedWords,
  validateWords,
} from "nostr-tools/nip06";
import type { Hex32 } from "./types";

/** Words a valid BIP-39 phrase may have. 12 and 24 are what wallets emit. */
export const SEED_PHRASE_LENGTHS: readonly number[] = [12, 15, 18, 21, 24];

export type SeedPhraseError =
  | "empty"
  | "wrong-length"
  /** Words are in the list but the BIP-39 checksum fails — usually a typo. */
  | "bad-checksum";

/**
 * Collapse whitespace and lowercase, the way every wallet displays them.
 *
 * Exported because a caller wants to normalise what it *stores or compares*, not
 * just what it validates: a phrase pasted from a screenshot commonly carries
 * newlines and double spaces, and rejecting that would be a validation failure
 * about formatting rather than about the words.
 */
export function normalizeSeedPhrase(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** Word count, after normalisation. */
export function seedPhraseWordCount(input: string): number {
  const normalized = normalizeSeedPhrase(input);
  return normalized === "" ? 0 : normalized.split(" ").length;
}

/**
 * Check a phrase before deriving anything from it.
 *
 * Length is checked separately from the checksum so the message can say which is
 * wrong: "11 words" and "one of these words is mistyped" have different remedies,
 * and a single "invalid seed phrase" leaves the user re-reading all twelve.
 */
export function validateSeedPhrase(input: string): SeedPhraseError | undefined {
  const normalized = normalizeSeedPhrase(input);
  if (normalized === "") return "empty";
  const words = normalized.split(" ");
  if (!SEED_PHRASE_LENGTHS.includes(words.length)) return "wrong-length";
  return validateWords(normalized) ? undefined : "bad-checksum";
}

/** Reader-facing copy. Never echoes the phrase — it is a secret. */
export function seedPhraseMessage(error: SeedPhraseError): string {
  switch (error) {
    case "empty":
      return "Enter your recovery phrase.";
    case "wrong-length":
      return "A recovery phrase is 12 or 24 words. Check that none are missing.";
    case "bad-checksum":
      return "Those words do not form a valid recovery phrase — one is probably mistyped. Recovery phrases have a built-in checksum, which is what caught this.";
  }
}

export interface DerivedAccount {
  readonly secretKey: Uint8Array;
  readonly pubkey: Hex32;
}

/**
 * Derive the account at `m/44'/1237'/<index>'/0/0`.
 *
 * Returns `undefined` for an invalid phrase rather than throwing, because the
 * caller has already been told what is wrong by {@link validateSeedPhrase} and a
 * second, differently-worded failure at this layer helps nobody.
 *
 * The returned `secretKey` is live key material: hold it in memory, encrypt it
 * before storing, never log it.
 */
export function deriveFromSeedPhrase(
  input: string,
  options: {
    readonly passphrase?: string;
    readonly accountIndex?: number;
  } = {},
): DerivedAccount | undefined {
  const normalized = normalizeSeedPhrase(input);
  if (validateSeedPhrase(normalized) !== undefined) return undefined;
  try {
    const account = accountFromSeedWords(
      normalized,
      options.passphrase ?? "",
      options.accountIndex ?? 0,
    );
    return {
      secretKey: account.privateKey,
      pubkey: account.publicKey as Hex32,
    };
  } catch {
    // The library throws on inputs `validateWords` accepted only in cases that
    // amount to "not a usable phrase" — reported the same way as the rest.
    return undefined;
  }
}

/**
 * A fresh 12-word phrase.
 *
 * Offered so that "create an identity" can produce something a user can actually
 * write down. An `nsec` is 63 characters of base32 that nobody transcribes
 * correctly; a phrase is the format the rest of this ecosystem already backs up.
 */
export function generateSeedPhrase(): string {
  return generateSeedWords();
}
