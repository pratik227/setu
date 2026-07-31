/**
 * NIP-19 bech32 entity codecs — typed, total, and non-throwing.
 *
 * `nostr-tools/nip19` throws on malformed input, which is the wrong default for
 * this layer: NIP-19 strings arrive from note content, URL bars, and paste
 * buffers, i.e. always from users. Every function here returns `undefined`
 * instead of throwing, so callers can branch instead of wrapping each call in
 * try/catch. A parser that throws on user input turns every call site into a
 * decision about error handling, and one missed call site into a crash.
 */

import * as nip19 from "nostr-tools/nip19";
import { isHex32 } from "./hex";
import type { Hex32 } from "./types";

/** Pointer to a profile with optional relay hints (nprofile payload). */
export interface ProfileRef {
  readonly pubkey: Hex32;
  readonly relays?: readonly string[];
}

/** Pointer to an event with optional hints (nevent payload). */
export interface EventRef {
  readonly id: Hex32;
  readonly relays?: readonly string[];
  readonly author?: Hex32;
  readonly kind?: number;
}

/** Pointer to an addressable event (naddr payload). */
export interface AddressRef {
  readonly identifier: string;
  readonly pubkey: Hex32;
  readonly kind: number;
  readonly relays?: readonly string[];
}

/**
 * Any decoded NIP-19 entity, as a discriminated union keyed on `type` — the
 * same tag bech32 already carries in its human-readable part.
 */
export type Nip19Ref =
  | { readonly type: "npub"; readonly pubkey: Hex32 }
  | { readonly type: "nsec"; readonly secretKey: Uint8Array }
  | { readonly type: "note"; readonly id: Hex32 }
  | ({ readonly type: "nprofile" } & ProfileRef)
  | ({ readonly type: "nevent" } & EventRef)
  | ({ readonly type: "naddr" } & AddressRef);

/** The bech32 prefixes this module understands. */
export type Nip19Prefix = Nip19Ref["type"];

const PREFIXES: readonly Nip19Prefix[] = [
  "npub",
  "nsec",
  "note",
  "nprofile",
  "nevent",
  "naddr",
];

/** True if `s` starts with a NIP-19 prefix we can decode. */
export function looksLikeNip19(s: string): boolean {
  const bare = stripNostrScheme(s);
  for (const prefix of PREFIXES) {
    if (bare.startsWith(`${prefix}1`)) return true;
  }
  return false;
}

/** Remove a leading `nostr:` URI scheme, if present. */
export function stripNostrScheme(s: string): string {
  return s.startsWith("nostr:") ? s.slice(6) : s;
}

function relayList(relays: unknown): readonly string[] | undefined {
  if (!Array.isArray(relays) || relays.length === 0) return undefined;
  const out: string[] = [];
  for (const r of relays) {
    if (typeof r === "string" && r.length > 0) out.push(r);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Decode any NIP-19 string (with or without a `nostr:` prefix) into a
 * discriminated union. Returns `undefined` for anything unrecognized,
 * malformed, or of an unsupported prefix. Never throws.
 */
export function decodeAny(input: string): Nip19Ref | undefined {
  const bare = stripNostrScheme(input.trim());
  const candidate = bare === bare.toUpperCase() ? bare.toLowerCase() : bare;
  let decoded: nip19.DecodedResult;
  try {
    decoded = nip19.decode(candidate);
  } catch {
    return undefined;
  }
  switch (decoded.type) {
    case "npub":
      return isHex32(decoded.data)
        ? { type: "npub", pubkey: decoded.data }
        : undefined;
    case "nsec":
      return { type: "nsec", secretKey: decoded.data };
    case "note":
      return isHex32(decoded.data)
        ? { type: "note", id: decoded.data }
        : undefined;
    case "nprofile":
      return {
        type: "nprofile",
        pubkey: decoded.data.pubkey,
        relays: relayList(decoded.data.relays),
      };
    case "nevent":
      return {
        type: "nevent",
        id: decoded.data.id,
        relays: relayList(decoded.data.relays),
        author: decoded.data.author,
        kind: decoded.data.kind,
      };
    case "naddr":
      return {
        type: "naddr",
        identifier: decoded.data.identifier,
        pubkey: decoded.data.pubkey,
        kind: decoded.data.kind,
        relays: relayList(decoded.data.relays),
      };
    default:
      // Unsupported prefixes (e.g. `nrelay`) are treated as undecodable.
      return undefined;
  }
}

/** Encode a 32-byte hex pubkey as `npub1…`; `undefined` if not valid hex. */
export function encodeNpub(pubkey: Hex32): string | undefined {
  if (!isHex32(pubkey)) return undefined;
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return undefined;
  }
}

/** Encode a 32-byte secret key as `nsec1…`; `undefined` on bad length. */
export function encodeNsec(secretKey: Uint8Array): string | undefined {
  if (secretKey.length !== 32) return undefined;
  try {
    return nip19.nsecEncode(secretKey);
  } catch {
    return undefined;
  }
}

/** Encode a 32-byte hex event id as `note1…`. */
export function encodeNote(id: Hex32): string | undefined {
  if (!isHex32(id)) return undefined;
  try {
    return nip19.noteEncode(id);
  } catch {
    return undefined;
  }
}

/** Encode a profile pointer as `nprofile1…`. */
export function encodeNprofile(ref: ProfileRef): string | undefined {
  if (!isHex32(ref.pubkey)) return undefined;
  try {
    return nip19.nprofileEncode({
      pubkey: ref.pubkey,
      relays: ref.relays ? [...ref.relays] : undefined,
    });
  } catch {
    return undefined;
  }
}

/** Encode an event pointer as `nevent1…`. */
export function encodeNevent(ref: EventRef): string | undefined {
  if (!isHex32(ref.id)) return undefined;
  try {
    return nip19.neventEncode({
      id: ref.id,
      relays: ref.relays ? [...ref.relays] : undefined,
      author: ref.author,
      kind: ref.kind,
    });
  } catch {
    return undefined;
  }
}

/** Encode an addressable-event coordinate as `naddr1…`. */
export function encodeNaddr(ref: AddressRef): string | undefined {
  if (!isHex32(ref.pubkey) || !Number.isInteger(ref.kind)) return undefined;
  try {
    return nip19.naddrEncode({
      identifier: ref.identifier,
      pubkey: ref.pubkey,
      kind: ref.kind,
      relays: ref.relays ? [...ref.relays] : undefined,
    });
  } catch {
    return undefined;
  }
}

/** Encode any decoded ref back to its bech32 form. */
export function encodeRef(ref: Nip19Ref): string | undefined {
  switch (ref.type) {
    case "npub":
      return encodeNpub(ref.pubkey);
    case "nsec":
      return encodeNsec(ref.secretKey);
    case "note":
      return encodeNote(ref.id);
    case "nprofile":
      return encodeNprofile(ref);
    case "nevent":
      return encodeNevent(ref);
    case "naddr":
      return encodeNaddr(ref);
    default:
      return undefined;
  }
}

/**
 * Best-effort hex pubkey from an npub/nprofile string, for call sites that only
 * need an author key.
 */
export function toPubkey(input: string): Hex32 | undefined {
  const ref = decodeAny(input);
  if (!ref) return undefined;
  if (ref.type === "npub" || ref.type === "nprofile") return ref.pubkey;
  if (ref.type === "nevent") return ref.author;
  if (ref.type === "naddr") return ref.pubkey;
  return undefined;
}

/**
 * Best-effort hex event id from a note/nevent string.
 */
export function toEventId(input: string): Hex32 | undefined {
  const ref = decodeAny(input);
  if (!ref) return undefined;
  if (ref.type === "note") return ref.id;
  if (ref.type === "nevent") return ref.id;
  return undefined;
}

/**
 * Shorten a bech32 identifier for display, keeping `chars` characters from each
 * end: `npub1abc…wxyz`. Returns the input unchanged when it is already short
 * enough. Purely cosmetic — never use the result as a key.
 */
export function truncateNpub(npub: string, chars = 8): string {
  if (chars <= 0) return npub;
  if (npub.length <= chars * 2 + 1) return npub;
  return `${npub.slice(0, chars)}…${npub.slice(-chars)}`;
}
