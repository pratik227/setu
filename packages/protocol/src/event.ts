/**
 * Event identity, signature verification, shape validation, and filter
 * matching — the trust boundary of the whole client.
 *
 * Everything a relay hands us is untrusted JSON. `isValidEventShape` is the
 * structural gate and `verifyEventSignature` is the cryptographic one; nothing
 * reaches the store without passing both.
 */

// @noble v2 publishes only extension-ful subpath exports.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, isHex32, isHex64 } from "./hex";
import type { Filter, Hex32, NostrEvent, UnsignedEvent } from "./types";

const utf8 = new TextEncoder();

/**
 * Canonical NIP-01 serialization: a JSON array with no whitespace, used as the
 * sha256 preimage for the event id.
 *
 * `[0, pubkey, created_at, kind, tags, content]`
 */
export function serializeEvent(e: UnsignedEvent): string {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}

/** sha256 of the canonical serialization, lowercase hex. */
export function computeEventId(e: UnsignedEvent): Hex32 {
  return bytesToHex(sha256(utf8.encode(serializeEvent(e))));
}

/**
 * Verify an event end to end: the id must equal the recomputed hash **and** the
 * schnorr signature must validate against that hash.
 *
 * Both halves are mandatory. Checking only the signature lets an attacker
 * mislabel an event's id (breaking dedup and deletion bookkeeping); checking
 * only the id lets anyone forge authorship outright.
 *
 * We compute this ourselves rather than delegating to a library helper that
 * memoises its result onto the event object: a cached "already verified" marker is
 * one refactor away from becoming a way to skip the check entirely, and a
 * client whose verification can be bypassed makes every downstream trust decision
 * meaningless. So there is exactly one verification function, it has no fast path,
 * no "trusted relay" bypass, and no branch that returns `true` without having
 * run schnorr verification.
 */
export function verifyEventSignature(e: NostrEvent): boolean {
  if (!isValidEventShape(e)) return false;
  if (computeEventId(e) !== e.id) return false;
  const sig = hexToBytes(e.sig);
  const id = hexToBytes(e.id);
  const pubkey = hexToBytes(e.pubkey);
  if (!sig || !id || !pubkey) return false;
  try {
    return schnorr.verify(sig, id, pubkey);
  } catch {
    // Malformed points / non-canonical scalars land here. A throwing verifier
    // is a failed verification, never a pass.
    return false;
  }
}

/**
 * Structural validation for untrusted relay JSON. Checks hex field lengths,
 * that `kind` is an integer, that `created_at` is a finite number, and that
 * `tags` is an array of arrays of strings.
 *
 * This runs before any crypto so a hostile relay cannot make us hash garbage.
 */
export function isValidEventShape(x: unknown): x is NostrEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  if (!isHex32(e.id)) return false;
  if (!isHex32(e.pubkey)) return false;
  if (!isHex64(e.sig)) return false;
  if (typeof e.content !== "string") return false;
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind)) {
    return false;
  }
  const createdAt = e.created_at;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return false;
  }
  const tags = e.tags;
  if (!Array.isArray(tags)) return false;
  for (const tag of tags) {
    if (!Array.isArray(tag)) return false;
    for (const item of tag) {
      if (typeof item !== "string") return false;
    }
  }
  return true;
}

/** True if the object has the shape of an unsigned event (no id/sig yet). */
export function isValidUnsignedShape(x: unknown): x is UnsignedEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return isValidEventShape({
    ...e,
    id: "0".repeat(64),
    sig: "0".repeat(128),
  });
}

/** Single-letter (or any) tag-filter key, e.g. `"#e"`. */
type TagFilterKey = `#${string}`;

function isTagFilterKey(key: string): key is TagFilterKey {
  return key.charCodeAt(0) === 35 /* # */ && key.length > 1;
}

/**
 * Full NIP-01 filter semantics for a single event.
 *
 * `ids` and `authors` are exact matches (prefix matching was removed from the
 * spec and relays no longer implement it consistently). `since`/`until` are
 * inclusive. Tag filters AND across different letters and OR within one
 * letter. `limit` and `search` are intentionally ignored — they are properties
 * of a query against a set, not of a single event.
 */
export function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }

  for (const key of Object.keys(filter)) {
    if (!isTagFilterKey(key)) continue;
    const wanted = filter[key];
    if (wanted === undefined) continue;
    // An explicitly empty tag filter can never be satisfied.
    if (wanted.length === 0) return false;
    const name = key.slice(1);
    if (!hasAnyTagValue(event, name, wanted)) return false;
  }
  return true;
}

function hasAnyTagValue(
  event: NostrEvent,
  name: string,
  wanted: readonly string[],
): boolean {
  for (const tag of event.tags) {
    if (tag[0] !== name) continue;
    const value = tag[1];
    if (value !== undefined && wanted.includes(value)) return true;
  }
  return false;
}

/** True if the event matches at least one of the filters (REQ semantics). */
export function matchesAnyFilter(
  event: NostrEvent,
  filters: readonly Filter[],
): boolean {
  for (const filter of filters) {
    if (matchesFilter(event, filter)) return true;
  }
  return false;
}
