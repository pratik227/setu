/**
 * Local fallback implementations of the two `@setu/protocol` runtime helpers
 * this package needs on its hot paths.
 *
 * The layering rule is that `@setu/core` may depend on protocol *types* freely
 * but must not hard-wire protocol *behaviour*: matching and shape validation are
 * injected into every constructor/factory that needs them (see
 * {@link MatchesFilterFn} and {@link IsValidEventShapeFn}). These fallbacks are
 * the defaults used when nothing is injected, which keeps the store and pool
 * unit-testable with zero dependency on the protocol package's progress.
 *
 * FOLLOW-UP: once `@setu/protocol` exports `matchesFilter` / `isValidEventShape`
 * at runtime, wire them in at the app composition root (or swap the defaults
 * here for re-exports) and delete the bodies below. They are intentionally a
 * faithful but minimal NIP-01 implementation, not a second permanent one.
 */

import type { Filter, NostrEvent } from "@setu/protocol";

/** Signature of the injected NIP-01 filter matcher. */
export type MatchesFilterFn = (event: NostrEvent, filter: Filter) => boolean;

/** Signature of the injected structural event validator. */
export type IsValidEventShapeFn = (value: unknown) => value is NostrEvent;

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

/**
 * True when `value` has the exact NIP-01 event shape: lowercase hex id/pubkey,
 * lowercase hex signature, integral kind and `created_at`, string tag arrays and
 * string content.
 *
 * This is a *shape* check only — it says nothing about the signature being valid
 * (that is {@link "../verify/verifier".BatchingEventVerifier}'s job) and nothing
 * about `id` being the correct hash of the serialised event.
 */
export const isValidEventShape: IsValidEventShapeFn = (
  value: unknown,
): value is NostrEvent => {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || !HEX32.test(e.id)) return false;
  if (typeof e.pubkey !== "string" || !HEX32.test(e.pubkey)) return false;
  if (typeof e.sig !== "string" || !HEX64.test(e.sig)) return false;
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind)) return false;
  if (e.kind < 0 || e.kind > 65535) return false;
  if (typeof e.created_at !== "number" || !Number.isInteger(e.created_at)) {
    return false;
  }
  if (typeof e.content !== "string") return false;
  if (!Array.isArray(e.tags)) return false;
  for (const tag of e.tags) {
    if (!Array.isArray(tag)) return false;
    for (const part of tag) {
      if (typeof part !== "string") return false;
    }
  }
  return true;
};

/** Every `#<letter>` key present on a filter, e.g. `["#e", "#p"]`. */
export function tagFilterKeys(filter: Filter): readonly `#${string}`[] {
  const out: `#${string}`[] = [];
  for (const key of Object.keys(filter)) {
    if (key.startsWith("#") && key.length === 2) {
      out.push(key as `#${string}`);
    }
  }
  return out;
}

/** True when the event carries a single-letter tag `letter` with `value`. */
function hasTagValue(
  event: NostrEvent,
  letter: string,
  values: readonly string[],
): boolean {
  for (const tag of event.tags) {
    if (tag.length < 2) continue;
    if (tag[0] !== letter) continue;
    const v = tag[1];
    if (v !== undefined && values.includes(v)) return true;
  }
  return false;
}

/**
 * NIP-01 filter matching, fallback implementation.
 *
 * `limit` is deliberately *not* considered here: it is a property of the result
 * set, not of an individual event, and is applied after sorting by the store.
 *
 * `search` (NIP-50) is relay-defined. Locally we approximate it as a
 * case-insensitive substring match on `content`, which is the only
 * interpretation that keeps a local-only read from returning obviously
 * non-matching rows.
 */
export const matchesFilter: MatchesFilterFn = (
  event: NostrEvent,
  filter: Filter,
): boolean => {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }
  if (filter.search !== undefined && filter.search !== "") {
    if (!event.content.toLowerCase().includes(filter.search.toLowerCase())) {
      return false;
    }
  }
  for (const key of tagFilterKeys(filter)) {
    const values = filter[key];
    if (!values || values.length === 0) return false;
    if (!hasTagValue(event, key.slice(1), values)) return false;
  }
  return true;
};
