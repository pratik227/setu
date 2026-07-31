/**
 * Core Nostr wire types.
 *
 * Tags stay as `string[][]` — the raw wire shape. Wrapping them in objects costs
 * an allocation per tag on the hottest path in the app (timeline rendering walks
 * every event's tags), and buys nothing the helpers in `tags.ts` cannot give.
 * Keep the wire shape; put convenience in functions, not in the data.
 */

/** 32-byte lowercase hex (event id, pubkey). */
export type Hex32 = string;
/** 64-byte lowercase hex (schnorr signature). */
export type Hex64 = string;
/** Unix seconds. */
export type Timestamp = number;

export interface NostrEvent {
  readonly id: Hex32;
  readonly pubkey: Hex32;
  readonly created_at: Timestamp;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: Hex64;
}

/** An event before id/sig are computed. */
export interface UnsignedEvent {
  readonly pubkey: Hex32;
  readonly created_at: Timestamp;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
}

/** A draft where pubkey/created_at may be filled in by the signer. */
export interface EventTemplate {
  readonly kind: number;
  readonly content: string;
  readonly tags?: readonly (readonly string[])[];
  readonly created_at?: Timestamp;
}

/**
 * A NIP-01 REQ filter. Tag filters use the `#<letter>` convention and are
 * carried in the index signature.
 */
export interface Filter {
  ids?: Hex32[];
  authors?: Hex32[];
  kinds?: number[];
  since?: Timestamp;
  until?: Timestamp;
  limit?: number;
  /** NIP-50 full-text search. */
  search?: string;
  /** `#e`, `#p`, `#t`, `#a`, … */
  [tagFilter: `#${string}`]: string[] | undefined;
}

/**
 * A filter bound to a specific relay.
 *
 * This is the outbox-model primitive: reads about an author go to *that
 * author's* write relays, so a filter is never meaningful on its own — it is
 * always "this query, at this relay". Carrying the relay in the type makes it
 * impossible to accidentally broadcast a per-author query to every socket.
 */
export interface RelayBasedFilter {
  readonly relay: string;
  readonly filter: Filter;
}

/** Relay read/write intent from a NIP-65 relay list (kind 10002). */
export interface RelayUsage {
  readonly url: string;
  readonly read: boolean;
  readonly write: boolean;
}

/**
 * Signing abstraction.
 *
 * Every method is async, with no sync escape hatch. This is deliberate: NIP-46
 * remote signers and NIP-07 extensions are inherently async, and a single sync
 * assumption anywhere forces the whole call graph to be rewritten once a remote
 * signer is added. `pubkey()` is async for the same reason — with a bunker,
 * identity is resolved over the wire.
 */
export interface NostrSigner {
  readonly kind: "local" | "nip07" | "nip46" | "readonly";
  pubkey(): Promise<Hex32>;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt?(peer: Hex32, plaintext: string): Promise<string>;
  nip44Decrypt?(peer: Hex32, ciphertext: string): Promise<string>;
}

export class SignerError extends Error {
  constructor(
    message: string,
    // `override` because Error already declares `cause` in lib.es2022.
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SignerError";
  }
}
