/**
 * Which encryption a NIP-46 frame is in, and how to read one either way.
 *
 * The current NIP-46 says kind-24133 `content` is NIP-44, and that is what Setu
 * sends. It is not what every deployed signer can read: NIP-46 predates NIP-44, a
 * good number of signers shipped against the older text and were never revised, and
 * against one of those a NIP-44-only client does not *fail* — it goes silent. The
 * signer cannot decrypt the request, so it never answers, and every deadline in
 * `rpc.ts` then reports "the remote signer did not answer" about a signer that never
 * heard the question. That is the worst diagnosis this code can hand a user, because
 * it points at their phone when the problem is the envelope.
 *
 * ## The scheme is read off the payload, never assumed
 *
 * NIP-46 has no capability exchange: a peer never states which encryption it speaks,
 * and there is no version field to inspect. So an inbound frame is classified by
 * shape. NIP-04 ciphertext is `<base64>?iv=<base64>`; a NIP-44 payload is unbroken
 * base64 with no `?` in it, so the `?iv=` marker separates the two with no overlap in
 * either direction (see `looksLikeNip04`). Deriving it from anything else — the URI
 * scheme we arrived by, a `name` in the handshake metadata, whether the peer looks
 * modern — is guessing, and a wrong guess costs a whole request deadline before
 * anyone finds out.
 *
 * Shape is a hint, not a verdict, so `decrypt` also tries the other scheme when the
 * implied one fails. A frame that decrypts is from the holder of the peer's secret
 * whichever envelope carried it; one that decrypts under neither was not for this
 * conversation at all.
 *
 * ## Nothing here downgrades on its own
 *
 * This module encrypts in whichever scheme it is told to. Choosing is the caller's
 * job precisely because the rule is about evidence rather than crypto: NIP-44 until
 * the peer has demonstrably answered in NIP-04. NIP-04 has no integrity — a relay can
 * garble a frame undetectably — so handing it to a signer that could have read NIP-44
 * gives up a real protection for nothing. See `signer.ts` for the state that decides.
 */

import { decryptNip04, encryptNip04, looksLikeNip04 } from "../../nip04";
import type { Hex32 } from "../../types";
import { SignerError } from "../../types";
import { LocalSigner } from "../local";

/** The two encryptions a NIP-46 peer may be speaking. */
export type Nip46Scheme = "nip44" | "nip04";

/** The scheme an inbound payload's shape implies. See the module note. */
export function schemeOf(content: string): Nip46Scheme {
  return looksLikeNip04(content) ? "nip04" : "nip44";
}

/** A decrypted frame, with the scheme it arrived in — which is the useful part. */
export interface Nip46Frame {
  readonly payload: string;
  /** What the peer used. Evidence for what to send it next. */
  readonly scheme: Nip46Scheme;
}

/** Encrypts and decrypts kind-24133 content under a client key, either scheme. */
export class Nip46Codec {
  private readonly nip44: LocalSigner;

  constructor(private readonly clientSecret: Uint8Array) {
    this.nip44 = LocalSigner.fromSecretKey(clientSecret);
  }

  /** Encrypt for `peer` in exactly the scheme asked for. */
  encrypt(
    peer: Hex32,
    plaintext: string,
    scheme: Nip46Scheme,
  ): Promise<string> {
    if (scheme === "nip04") {
      return Promise.resolve(encryptNip04(this.clientSecret, peer, plaintext));
    }
    return this.nip44.nip44Encrypt(peer, plaintext);
  }

  /**
   * Decrypt a frame from `peer`, trying the shape-implied scheme first.
   *
   * Rejects when neither scheme reads it. The caller treats that as "not for this
   * conversation" rather than as an error worth reporting: the inbox is a public
   * relay subscription and anyone may publish a kind-24133 event addressed to our
   * client key, so undecryptable traffic is expected background noise.
   */
  async decrypt(peer: Hex32, content: string): Promise<Nip46Frame> {
    const implied = schemeOf(content);
    try {
      return {
        payload: await this.decryptAs(peer, content, implied),
        scheme: implied,
      };
    } catch {
      const other: Nip46Scheme = implied === "nip04" ? "nip44" : "nip04";
      return {
        payload: await this.decryptAs(peer, content, other),
        scheme: other,
      };
    }
  }

  private decryptAs(
    peer: Hex32,
    content: string,
    scheme: Nip46Scheme,
  ): Promise<string> {
    if (scheme === "nip04") {
      try {
        return Promise.resolve(decryptNip04(this.clientSecret, peer, content));
      } catch (cause) {
        return Promise.reject(
          new SignerError("nip46 frame did not decrypt as nip04", cause),
        );
      }
    }
    return this.nip44.nip44Decrypt(peer, content);
  }
}
