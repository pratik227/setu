/**
 * Read-only identity.
 *
 * Browsing someone else's feed, or your own from a pubkey pasted into the URL,
 * is a first-class mode — not "logged in with a null key". Modelling it as a
 * nullable key is what spreads `if (secretKey)` checks through the UI. Here the
 * type system carries it: a `ReadonlySigner` satisfies `NostrSigner`, so any screen
 * can render with one, and the moment a screen tries to publish it gets a
 * `SignerError` naming the reason instead of a crash.
 */

import { isHex32 } from "../hex";
import { decodeAny } from "../nip19";
import type { EventTemplate, Hex32, NostrEvent, NostrSigner } from "../types";
import { SignerError } from "../types";

/** A signer that knows who you are but cannot act as you. */
export class ReadonlySigner implements NostrSigner {
  readonly kind = "readonly" as const;

  private constructor(private readonly publicKey: Hex32) {}

  /**
   * Build from hex or `npub1…`/`nprofile1…`.
   * @throws SignerError when the input is not a public key.
   */
  static fromPubkey(input: string): ReadonlySigner {
    const signer = ReadonlySigner.tryFromPubkey(input);
    if (!signer) {
      throw new SignerError("not a valid public key (expected hex or npub)");
    }
    return signer;
  }

  /** Non-throwing counterpart of {@link ReadonlySigner.fromPubkey}. */
  static tryFromPubkey(input: string): ReadonlySigner | undefined {
    const trimmed = input.trim();
    if (isHex32(trimmed.toLowerCase())) {
      return new ReadonlySigner(trimmed.toLowerCase());
    }
    const ref = decodeAny(trimmed);
    if (!ref) return undefined;
    if (ref.type === "npub" || ref.type === "nprofile") {
      return isHex32(ref.pubkey) ? new ReadonlySigner(ref.pubkey) : undefined;
    }
    return undefined;
  }

  /** The observed pubkey. */
  pubkey(): Promise<Hex32> {
    return Promise.resolve(this.publicKey);
  }

  /** Sync accessor, safe here because the key is always already known. */
  pubkeySync(): Hex32 {
    return this.publicKey;
  }

  /** Always rejects — there is no secret key to sign with. */
  signEvent(_template: EventTemplate): Promise<NostrEvent> {
    return Promise.reject(
      new SignerError(
        "this session is read-only; sign in with a key to publish",
      ),
    );
  }
}

/** True when the signer cannot publish — use to gate compose UI. */
export function isReadonly(signer: NostrSigner): boolean {
  return signer.kind === "readonly";
}
