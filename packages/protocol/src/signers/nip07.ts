/**
 * NIP-07 browser-extension signer.
 *
 * The extension is an external process we cannot introspect, so every call is
 * wrapped: a missing extension, a user-declined prompt, and an extension that
 * lies about its capabilities all surface as `SignerError` rather than as an
 * unhandled rejection somewhere in a component.
 */

import { isHex32 } from "../hex";
import type { EventTemplate, Hex32, NostrEvent, NostrSigner } from "../types";
import { SignerError } from "../types";

/** The subset of `window.nostr` Setu relies on (NIP-07). */
export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: {
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
  }): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

/**
 * The injected provider, or `undefined` outside a browser / with no extension.
 *
 * Probes `globalThis` rather than `window` on purpose: this package is consumed
 * from Node too (the CLI, tests), and a bare `window` reference makes the whole
 * module fail to compile without the DOM lib. `globalThis` is available in every
 * target, so the browser-only path stays browser-only without forcing every
 * consumer to pull in DOM types.
 */
export function getNip07Provider(): Nip07Provider | undefined {
  const provider = (globalThis as { nostr?: Nip07Provider }).nostr;
  if (!provider || typeof provider.getPublicKey !== "function") {
    return undefined;
  }
  return provider;
}

/** True when a usable NIP-07 extension is present. */
export function isNip07Available(): boolean {
  return getNip07Provider() !== undefined;
}

/** Signs through a NIP-07 extension. */
export class Nip07Signer implements NostrSigner {
  readonly kind = "nip07" as const;

  /** Present only when the extension advertises NIP-44 support. */
  nip44Encrypt?: (peer: Hex32, plaintext: string) => Promise<string>;
  /** Present only when the extension advertises NIP-44 support. */
  nip44Decrypt?: (peer: Hex32, ciphertext: string) => Promise<string>;

  private cachedPubkey?: Hex32;

  constructor(private readonly provider: Nip07Provider) {
    // Feature-detected once, at construction: the optional methods on
    // `NostrSigner` exist only if the extension can actually do the work, so
    // callers can branch on `signer.nip44Encrypt !== undefined` instead of
    // discovering the gap through a runtime failure mid-DM.
    const nip44 = provider.nip44;
    if (nip44 && typeof nip44.encrypt === "function") {
      this.nip44Encrypt = (peer, plaintext) =>
        this.wrap("nip44 encrypt", () => nip44.encrypt(peer, plaintext));
    }
    if (nip44 && typeof nip44.decrypt === "function") {
      this.nip44Decrypt = (peer, ciphertext) =>
        this.wrap("nip44 decrypt", () => nip44.decrypt(peer, ciphertext));
    }
  }

  /**
   * Build a signer from `window.nostr`.
   * @throws SignerError when no extension is installed.
   */
  static fromWindow(): Nip07Signer {
    const provider = getNip07Provider();
    if (!provider) {
      throw new SignerError(
        "no NIP-07 extension found (window.nostr is unavailable)",
      );
    }
    return new Nip07Signer(provider);
  }

  /** Non-throwing counterpart of {@link Nip07Signer.fromWindow}. */
  static detect(): Nip07Signer | undefined {
    const provider = getNip07Provider();
    return provider ? new Nip07Signer(provider) : undefined;
  }

  private async wrap<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      throw new SignerError(`NIP-07 ${what} failed`, cause);
    }
  }

  /** Ask the extension for the active pubkey (cached after first success). */
  async pubkey(): Promise<Hex32> {
    if (this.cachedPubkey) return this.cachedPubkey;
    const pubkey = await this.wrap("getPublicKey", () =>
      this.provider.getPublicKey(),
    );
    if (!isHex32(pubkey)) {
      throw new SignerError(
        "NIP-07 extension returned a malformed public key",
        pubkey,
      );
    }
    this.cachedPubkey = pubkey;
    return pubkey;
  }

  /**
   * Hand the template to the extension. The result is re-checked here: an
   * extension is untrusted input like anything else crossing a process
   * boundary, and a wrong pubkey or missing signature must not reach the store.
   */
  async signEvent(template: EventTemplate): Promise<NostrEvent> {
    const signed = await this.wrap("signEvent", () =>
      this.provider.signEvent({
        kind: template.kind,
        content: template.content,
        tags: (template.tags ?? []).map((tag) => [...tag]),
        created_at: template.created_at ?? Math.floor(Date.now() / 1000),
      }),
    );
    if (!signed || typeof signed !== "object") {
      throw new SignerError("NIP-07 extension returned no event");
    }
    if (!isHex32(signed.id) || !isHex32(signed.pubkey)) {
      throw new SignerError("NIP-07 extension returned a malformed event");
    }
    return {
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      tags: signed.tags,
      content: signed.content,
      sig: signed.sig,
    };
  }
}
