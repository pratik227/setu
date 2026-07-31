/**
 * Local retention policy: which stored events a persistent store may delete to
 * stay inside the browser's storage quota.
 *
 * NIP-40 expiry (see {@link ./expiration}) bounds nothing in practice, because
 * almost no event carries an `expiration` tag. So a store that only ever grows
 * eventually meets the quota, and the failure mode when it does is a *write*
 * error on the ingest path: the client keeps rendering but stops being able to
 * record anything new, which reads as a client that has silently stopped
 * following the network.
 *
 * The policy is default-deny and stated as an allowlist, because the cost of the
 * two mistakes is nowhere near symmetric. Keeping too much costs disk. Deleting
 * the wrong row can destroy the only copy in existence:
 *
 *  - **Our own events, whatever their kind.** Relays are not archives and are
 *    under no obligation to keep anything. A note the user wrote, evicted here
 *    and no longer fetchable anywhere, was destroyed by their own cache.
 *  - **Private messages** (NIP-04 kind 4; NIP-17/NIP-59 kinds 13, 14, 15, 1059).
 *    Same reasoning, sharper: an inbox relay that has dropped a gift wrap cannot
 *    be asked for it again, and nobody else has it either.
 *  - **Replaceable and addressable kinds** — profile, follow list, relay list,
 *    mute list, bookmarks, drafts, articles. These are configuration, they are
 *    small, and refetching them is not safe: dropping a follow list and then
 *    reading an older version back from a relay that kept one silently unfollows
 *    people. Only the newest version of each is ever stored anyway, so they
 *    cannot be what filled the quota.
 *  - **NIP-70 protected events**, which only their author is allowed to
 *    republish — so for anyone else's protected event, refetching may be the one
 *    thing that never works.
 *
 * What is left is exactly the high-volume, re-fetchable traffic: other people's
 * old notes, reposts, reactions, comments and zap receipts.
 *
 * Age is measured against **both** `created_at` and `provenance.firstSeen`, and
 * that second condition is the one that matters: `created_at` is author-supplied,
 * so a note written three years ago can arrive in the store five minutes ago and
 * be on screen right now. Evicting on `created_at` alone would delete rows out
 * from under a reader scrolling someone's history.
 */

import type { Hex32, Timestamp } from "@setu/protocol";
import type { StoredEvent } from "../contracts";
import { isAddressableKind, isReplaceableKind } from "./kinds";

/** Thirty days: long enough that ordinary reading never notices an eviction. */
export const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * Rows examined per sweep.
 *
 * A cap, not a target: a sweep is a range read into memory, and one that loads
 * an entire year of history to decide what to delete would stall the tab it was
 * meant to protect. Sweeps repeat, so a backlog drains over several of them.
 */
export const DEFAULT_MAX_PER_SWEEP = 2_000;

/**
 * Kinds that may be evicted once old. Anything absent is kept forever — see the
 * module doc for why this is an allowlist and not a denylist.
 */
export const EVICTABLE_KINDS: readonly number[] = [
  1, // short text note
  6, // repost (NIP-18)
  7, // reaction (NIP-25)
  16, // generic repost (NIP-18)
  1111, // comment (NIP-22)
  9735, // zap receipt (NIP-57)
];

/**
 * A store that can reclaim space under a policy.
 *
 * Separate from {@link ../contracts.EventStore} on purpose: eviction is only
 * meaningful for a store that outlives the tab, and every caller has to cope with
 * a store that does not implement it anyway (the in-memory one).
 */
export interface EvictingEventStore {
  /** Deletes evictable rows, returning how many went. */
  evictStale(policy: RetentionPolicy): Promise<number>;
}

export interface RetentionPolicy {
  /** Events younger than this, by either clock, are never evicted. */
  readonly maxAgeSeconds: number;
  /** Authors whose events are kept regardless of age — normally just us. */
  readonly keepAuthors: readonly Hex32[];
  readonly evictableKinds: readonly number[];
  readonly maxPerSweep: number;
}

/** The default policy, protecting `accountPubkey`'s own events. */
export function defaultRetentionPolicy(
  options: {
    readonly accountPubkey?: Hex32;
    readonly maxAgeSeconds?: number;
    readonly maxPerSweep?: number;
  } = {},
): RetentionPolicy {
  return {
    maxAgeSeconds: options.maxAgeSeconds ?? DEFAULT_RETENTION_SECONDS,
    keepAuthors: options.accountPubkey ? [options.accountPubkey] : [],
    evictableKinds: EVICTABLE_KINDS,
    maxPerSweep: options.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP,
  };
}

/**
 * Whether `stored` may be deleted, given the cutoff timestamp both of its clocks
 * must predate.
 *
 * Pure so the rule that decides what gets destroyed is readable and tested in
 * one place rather than inferred from a query.
 */
export function isEvictable(
  stored: StoredEvent,
  cutoff: Timestamp,
  policy: RetentionPolicy,
): boolean {
  const { event } = stored;
  if (event.created_at >= cutoff) return false;
  // Held locally for less than the horizon: fetched recently, so quite possibly
  // being looked at, whatever its author put in `created_at`.
  if (stored.provenance.firstSeen >= cutoff) return false;
  if (stored.protected === true) return false;
  if (policy.keepAuthors.includes(event.pubkey)) return false;
  if (isReplaceableKind(event.kind) || isAddressableKind(event.kind)) {
    return false;
  }
  return policy.evictableKinds.includes(event.kind);
}
