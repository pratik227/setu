/**
 * In-memory secret-key signer.
 *
 * The key lives in this object and nowhere else; callers get signatures, never
 * the bytes. Async like every other signer even though it could be sync —
 * `NostrSigner` has no sync escape hatch on purpose, so a screen written
 * against `LocalSigner` keeps working when the user moves to a bunker.
 */

import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import {
  finalizeEvent,
  generateSecretKey as nostrGenerateSecretKey,
  getPublicKey as nostrGetPublicKey,
} from "nostr-tools/pure";
import { hexToBytes } from "../hex";
import { decodeAny } from "../nip19";
import type { EventTemplate, Hex32, NostrEvent, NostrSigner } from "../types";
import { SignerError } from "../types";

/** Fresh 32-byte secret key from the platform CSPRNG. */
export function generateSecretKey(): Uint8Array {
  return nostrGenerateSecretKey();
}

/** x-only public key (32-byte hex) for a secret key. */
export function getPublicKey(secretKey: Uint8Array): Hex32 {
  return nostrGetPublicKey(secretKey);
}

/**
 * Accept a secret key as raw bytes, 64-char hex, or `nsec1…` and normalize it
 * to bytes. Returns `undefined` rather than throwing: this runs on the login
 * form's keystroke path, where "not a key yet" is the normal state.
 */
export function parseSecretKey(
  input: string | Uint8Array,
): Uint8Array | undefined {
  if (input instanceof Uint8Array) {
    return input.length === 32 ? input : undefined;
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("nsec1") || trimmed.startsWith("nostr:nsec1")) {
    const ref = decodeAny(trimmed);
    if (ref?.type !== "nsec") return undefined;
    return ref.secretKey.length === 32 ? ref.secretKey : undefined;
  }
  if (trimmed.length !== 64) return undefined;
  const bytes = hexToBytes(trimmed.toLowerCase());
  return bytes?.length === 32 ? bytes : undefined;
}

/** Signs with a secret key held in memory. */
export class LocalSigner implements NostrSigner {
  readonly kind = "local" as const;

  private constructor(
    private readonly secretKey: Uint8Array,
    private readonly publicKey: Hex32,
  ) {}

  /**
   * Build a signer from bytes, hex, or `nsec1…`.
   * @throws SignerError when the input is not a valid secret key.
   */
  static fromSecretKey(input: string | Uint8Array): LocalSigner {
    const signer = LocalSigner.tryFromSecretKey(input);
    if (!signer) {
      throw new SignerError("not a valid secret key (expected hex or nsec)");
    }
    return signer;
  }

  /** Non-throwing counterpart of {@link LocalSigner.fromSecretKey}. */
  static tryFromSecretKey(input: string | Uint8Array): LocalSigner | undefined {
    const bytes = parseSecretKey(input);
    if (!bytes) return undefined;
    return new LocalSigner(bytes, getPublicKey(bytes));
  }

  /** Create a signer for a brand-new identity. */
  static generate(): LocalSigner {
    const secretKey = generateSecretKey();
    return new LocalSigner(secretKey, getPublicKey(secretKey));
  }

  /** The signer's public key. Async to match the `NostrSigner` contract. */
  pubkey(): Promise<Hex32> {
    return Promise.resolve(this.publicKey);
  }

  /** Sync accessor for the rare call site that provably has a local key. */
  pubkeySync(): Hex32 {
    return this.publicKey;
  }

  /** Fill in pubkey/created_at, compute the id, and sign. */
  signEvent(template: EventTemplate): Promise<NostrEvent> {
    try {
      const signed = finalizeEvent(
        {
          kind: template.kind,
          content: template.content,
          tags: (template.tags ?? []).map((tag) => [...tag]),
          created_at: template.created_at ?? Math.floor(Date.now() / 1000),
        },
        this.secretKey,
      );
      // Copied into a plain object on purpose: nostr-tools stamps a hidden
      // "already verified" symbol onto events it produces, and we never want a
      // marker like that travelling into the store, where it could let an event
      // skip verification later.
      return Promise.resolve({
        id: signed.id,
        pubkey: signed.pubkey,
        created_at: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        sig: signed.sig,
      });
    } catch (cause) {
      return Promise.reject(new SignerError("failed to sign event", cause));
    }
  }

  /** NIP-44 v2 encryption to `peer`. */
  nip44Encrypt(peer: Hex32, plaintext: string): Promise<string> {
    try {
      const key = getConversationKey(this.secretKey, peer);
      return Promise.resolve(encrypt(plaintext, key));
    } catch (cause) {
      return Promise.reject(new SignerError("nip44 encrypt failed", cause));
    }
  }

  /** NIP-44 v2 decryption from `peer`. */
  nip44Decrypt(peer: Hex32, ciphertext: string): Promise<string> {
    try {
      const key = getConversationKey(this.secretKey, peer);
      return Promise.resolve(decrypt(ciphertext, key));
    } catch (cause) {
      return Promise.reject(new SignerError("nip44 decrypt failed", cause));
    }
  }
}
