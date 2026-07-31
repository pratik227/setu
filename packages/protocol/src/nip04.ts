/**
 * NIP-04 encryption, for the one place Setu still needs it.
 *
 * NIP-04 is **deprecated and weaker than NIP-44**, and Setu deliberately does not use
 * it for private messages: `nip17.ts`/`nip59.ts` use NIP-44 inside a gift wrap, which
 * hides the metadata NIP-04 leaks. Nothing here changes that, and nothing here should
 * ever be reached for by a new feature.
 *
 * It exists because of NIP-47. A wallet service decides which encryption the client
 * must use, not the other way round — many deployed wallets still accept only NIP-04,
 * and a client that refuses it cannot talk to them at all. Refusing on principle would
 * not protect a user's messages (these are wallet commands, not conversations); it
 * would just mean the wallet does not work.
 *
 * ## What is actually at risk here, and what is not
 *
 * The plaintext is a JSON command like `{"method":"get_balance","params":{}}` and its
 * reply. NIP-04's known weaknesses are unauthenticated CBC and leaked message length —
 * neither of which reveals much about a fixed set of short method names, and both of
 * which the relay could infer from the event's existence anyway. What NIP-04 does *not*
 * protect is integrity: a relay could tamper with ciphertext and the client would see
 * garbage rather than a detectable forgery. That is survivable here for one reason
 * only: an unparseable reply is treated as an **error**, never as a success — see
 * `parseWalletResponse`. A tampered reply cannot become "payment sent".
 *
 * ## The primitive is not hand-rolled
 *
 * `nostr-tools/nip04` does the ECDH and the AES-256-CBC, exactly as `signers/local.ts`
 * uses `nostr-tools/nip44` for the modern path. Writing CBC and key derivation by hand
 * to save a dependency that is already installed would be the worst trade in this file.
 */

import {
  decrypt as nip04Decrypt,
  encrypt as nip04Encrypt,
} from "nostr-tools/nip04";
import type { Hex32 } from "./types";

/** Thrown when encryption or decryption fails. Carries no plaintext or key. */
export class Nip04Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Nip04Error";
  }
}

/**
 * Encrypt `plaintext` to `peer` using `secretKey`.
 *
 * The thrown message never contains the plaintext, the key or the peer: this runs on a
 * wallet command path, and an error string that ends up in a console is the one place a
 * spending key or a payment amount could leak from.
 */
export function encryptNip04(
  secretKey: Uint8Array | string,
  peer: Hex32,
  plaintext: string,
): string {
  try {
    return nip04Encrypt(secretKey, peer, plaintext);
  } catch {
    throw new Nip04Error("NIP-04 encryption failed.");
  }
}

/**
 * Decrypt `ciphertext` from `peer`.
 *
 * Throws rather than returning `undefined` on failure, because every caller has to
 * distinguish "could not decrypt" from "decrypted to something unexpected" — and a
 * silent empty string would be parsed as an unreadable *response*, which reports a
 * different thing to the user than a broken connection.
 */
export function decryptNip04(
  secretKey: Uint8Array | string,
  peer: Hex32,
  ciphertext: string,
): string {
  try {
    return nip04Decrypt(secretKey, peer, ciphertext);
  } catch {
    throw new Nip04Error("NIP-04 decryption failed.");
  }
}

/**
 * True when a string has NIP-04's shape: `<base64>?iv=<base64>`.
 *
 * Used to tell a NIP-04 payload from a NIP-44 one when a wallet's advertised
 * encryption disagrees with what it actually sent — which happens, and guessing wrong
 * costs a round trip on every request rather than failing loudly.
 */
export function looksLikeNip04(content: string): boolean {
  return /^[A-Za-z0-9+/=]+\?iv=[A-Za-z0-9+/=]+$/.test(content);
}
