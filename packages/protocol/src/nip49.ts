/**
 * NIP-49 passphrase-encrypted secret keys (`ncryptsec1…`).
 *
 * A thin wrapper over `nostr-tools/nip49`. The scrypt parameters and the XChaCha
 * construction are deliberately not reimplemented here — hand-rolling password
 * KDFs is how key material gets lost, and the installed nostr-tools already
 * ships the audited implementation.
 *
 * Decryption returns `undefined` on a wrong passphrase instead of throwing,
 * because "wrong passphrase" is an expected outcome of a login form, not an
 * exceptional one.
 */

import * as nip49 from "nostr-tools/nip49";
import { parseSecretKey } from "./signers/local";

/** Default scrypt work factor (2^16), the NIP-49 recommendation. */
export const DEFAULT_LOG_N = 16;

/** How the key was stored, per NIP-49's key-security byte. */
export const KeySecurity = {
  /** Key has been handled insecurely (e.g. seen in plaintext). */
  Insecure: 0x00,
  /** Key has never been handled insecurely. */
  Secure: 0x01,
  /** Client does not track this. */
  Unknown: 0x02,
} as const;

/** Value union of {@link KeySecurity}. */
export type KeySecurityByte = (typeof KeySecurity)[keyof typeof KeySecurity];

/**
 * Encrypt a secret key (bytes, hex, or `nsec1…`) with a passphrase.
 * Returns `undefined` if the input is not a valid secret key.
 *
 * `logN` is a CPU/memory tradeoff: 16 takes roughly a second on a laptop, which
 * is the point — it is what makes a weak passphrase survive an offline attack.
 */
export function encryptSecretKey(
  secretKey: string | Uint8Array,
  passphrase: string,
  logN: number = DEFAULT_LOG_N,
  keySecurity: KeySecurityByte = KeySecurity.Unknown,
): string | undefined {
  const bytes = parseSecretKey(secretKey);
  if (!bytes) return undefined;
  try {
    return nip49.encrypt(bytes, passphrase, logN, keySecurity);
  } catch {
    return undefined;
  }
}

/**
 * Decrypt an `ncryptsec1…` string. Returns `undefined` for a wrong passphrase
 * or malformed input — the two are indistinguishable by design.
 */
export function decryptSecretKey(
  ncryptsec: string,
  passphrase: string,
): Uint8Array | undefined {
  const trimmed = ncryptsec.trim();
  if (!trimmed.startsWith("ncryptsec1")) return undefined;
  try {
    const bytes = nip49.decrypt(trimmed, passphrase);
    return bytes.length === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** True if the string looks like a NIP-49 encrypted key. */
export function isNcryptsec(value: string): boolean {
  return value.trim().startsWith("ncryptsec1");
}
