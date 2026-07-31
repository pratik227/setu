/**
 * NIP-01 kind classification and addressing.
 *
 * These ranges decide storage behaviour, so they live in one place rather than
 * being re-derived at each call site (the "is this replaceable?" check
 * duplicated across a codebase is how LWW bugs get in).
 */

import type { Hex32, NostrEvent } from "@setu/protocol";

/** Kind 0 — user metadata (replaceable). */
export const KIND_METADATA = 0;
/** Kind 3 — follow list (replaceable). */
export const KIND_CONTACTS = 3;
/** Kind 5 — deletion request (NIP-09). */
export const KIND_DELETION = 5;
/** Kind 6 — repost (NIP-18). */
export const KIND_REPOST = 6;
/** Kind 16 — generic repost (NIP-18). */
export const KIND_GENERIC_REPOST = 16;
/** Kind 10002 — relay list metadata (NIP-65). */
export const KIND_RELAY_LIST = 10002;

/** Regular replaceable: only the newest event per `(kind, pubkey)` is kept. */
export function isReplaceableKind(kind: number): boolean {
  return (
    kind === KIND_METADATA ||
    kind === KIND_CONTACTS ||
    (kind >= 10000 && kind < 20000)
  );
}

/** Ephemeral: relays and clients must not persist these at all. */
export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

/**
 * Addressable (a.k.a. parameterised replaceable): newest event per
 * `(kind, pubkey, d-tag)`.
 */
export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/** The `d` tag value, or `""` when absent (NIP-01 treats those as equivalent). */
export function dTagOf(event: NostrEvent): string {
  for (const tag of event.tags) {
    if (tag[0] === "d") return tag[1] ?? "";
  }
  return "";
}

/**
 * The NIP-01 address (`kind:pubkey:dTag`) used as the last-write-wins key.
 *
 * Returns `undefined` for kinds that are neither replaceable nor addressable —
 * those are stored one row per id with no supersede semantics. Regular
 * replaceable kinds get an empty d-tag component so both families share one
 * index and one code path.
 */
export function addressOf(event: NostrEvent): string | undefined {
  if (isAddressableKind(event.kind)) {
    return `${event.kind}:${event.pubkey}:${dTagOf(event)}`;
  }
  if (isReplaceableKind(event.kind)) {
    return `${event.kind}:${event.pubkey}:`;
  }
  return undefined;
}

/** Builds an address from its parts, for parsing NIP-09 `a` tags. */
export function makeAddress(kind: number, pubkey: Hex32, dTag: string): string {
  return `${kind}:${pubkey}:${dTag}`;
}

/** The pubkey component of an address, or `undefined` if malformed. */
export function addressAuthor(address: string): Hex32 | undefined {
  const parts = address.split(":");
  if (parts.length < 2) return undefined;
  return parts[1];
}
