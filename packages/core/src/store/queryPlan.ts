/**
 * A miniature query planner, shared by both stores.
 *
 * The point of a planner is not that indexes exist but that a query *chooses*
 * one: a filter naming ids, authors, kinds or tags should never cause a full table
 * scan. This is that idea at the smallest useful size — enumerate the
 * usable indexes, estimate each one's candidate-set size from index statistics,
 * and take the narrowest. The chosen index yields a superset which is then
 * filtered exactly by `matchesFilter`, so a wrong estimate costs time, never
 * correctness.
 */

import type { Filter, Hex32 } from "@setu/protocol";
import type { StoredEvent } from "../contracts";
import { tagFilterKeys } from "../internal/filterMatch";
import { compareStoredNewestFirst } from "./replaceable";

/** The index a query will read from. */
export type IndexPlan =
  /** Exact primary-key lookups — always optimal when `ids` is present. */
  | { readonly index: "ids"; readonly ids: readonly Hex32[] }
  /** Union of `letter:value` tag buckets for the most selective tag filter. */
  | { readonly index: "tag"; readonly tagKeys: readonly string[] }
  | { readonly index: "author"; readonly authors: readonly Hex32[] }
  | { readonly index: "kind"; readonly kinds: readonly number[] }
  /** No usable index; fall back to created_at order. */
  | { readonly index: "scan" };

/** Index cardinality lookups supplied by the owning store. */
export interface IndexStats {
  /** Total rows held, used as the cost of a scan. */
  readonly totalEvents: number;
  /** Rows carrying the tag bucket `letter:value`. */
  countForTagKey(key: string): number;
  countForAuthor(pubkey: Hex32): number;
  countForKind(kind: number): number;
}

/** Builds the `letter:value` bucket key used by the tag index. */
export function tagIndexKey(letter: string, value: string): string {
  return `${letter}:${value}`;
}

/** Every tag bucket key an event belongs to (single-letter tags only). */
export function tagIndexKeysOf(
  tags: readonly (readonly string[])[],
): readonly string[] {
  const keys: string[] = [];
  for (const tag of tags) {
    const letter = tag[0];
    const value = tag[1];
    if (letter === undefined || value === undefined) continue;
    if (letter.length !== 1) continue;
    const key = tagIndexKey(letter, value);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

interface Candidate {
  readonly plan: IndexPlan;
  readonly cost: number;
}

/**
 * Picks the narrowest usable index for `filter`.
 *
 * Without `stats` the order is the static selectivity ranking
 * `ids > tag > author > kind > scan`, which is the right guess for Nostr filters
 * in practice. With `stats` the estimate is the summed bucket size, so a query
 * for a hot kind and a cold author correctly picks the author.
 */
export function chooseIndex(filter: Filter, stats?: IndexStats): IndexPlan {
  // Primary-key lookups can never be beaten; short-circuit before estimating.
  if (filter.ids !== undefined && filter.ids.length > 0) {
    return { index: "ids", ids: filter.ids };
  }

  const candidates: Candidate[] = [];

  // Tag filters: each `#letter` is ANDed, so any single one is a valid superset.
  // Take the cheapest.
  let bestTag: Candidate | undefined;
  for (const key of tagFilterKeys(filter)) {
    const values = filter[key];
    if (values === undefined || values.length === 0) continue;
    const letter = key.slice(1);
    const tagKeys = values.map((value) => tagIndexKey(letter, value));
    const cost = stats
      ? tagKeys.reduce((sum, k) => sum + stats.countForTagKey(k), 0)
      : 1_000;
    if (bestTag === undefined || cost < bestTag.cost) {
      bestTag = { plan: { index: "tag", tagKeys }, cost };
    }
  }
  if (bestTag !== undefined) candidates.push(bestTag);

  if (filter.authors !== undefined && filter.authors.length > 0) {
    const authors = filter.authors;
    const cost = stats
      ? authors.reduce((sum, a) => sum + stats.countForAuthor(a), 0)
      : 10_000;
    candidates.push({ plan: { index: "author", authors }, cost });
  }

  if (filter.kinds !== undefined && filter.kinds.length > 0) {
    const kinds = filter.kinds;
    const cost = stats
      ? kinds.reduce((sum, k) => sum + stats.countForKind(k), 0)
      : 100_000;
    candidates.push({ plan: { index: "kind", kinds }, cost });
  }

  if (candidates.length === 0) return { index: "scan" };

  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.cost < best.cost) best = candidate;
  }
  // A scan is never worth it here: even a bad index beats reading everything,
  // and the estimates are upper bounds.
  return best.plan;
}

/**
 * Applies result-set semantics: canonical newest-first ordering, then `limit`.
 *
 * `limit` is applied only here and never during matching — NIP-01 defines it as
 * "the newest N matching events", which is meaningless before sorting.
 */
export function sortAndLimit(
  events: readonly StoredEvent[],
  filter: Filter,
): readonly StoredEvent[] {
  const sorted = [...events].sort(compareStoredNewestFirst);
  if (filter.limit !== undefined && filter.limit >= 0) {
    return sorted.slice(0, filter.limit);
  }
  return sorted;
}
