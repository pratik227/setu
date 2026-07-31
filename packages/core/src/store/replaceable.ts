/**
 * Last-write-wins arbitration and provenance merging, shared by every
 * {@link ../contracts.EventStore} implementation.
 *
 * Deliberately pure: both stores hand it the incoming event plus whatever they
 * already hold and act on the returned decision. That is what keeps the memory
 * store honest as the reference implementation — there is no second copy of these
 * rules to drift.
 */

import type { NostrEvent, Timestamp } from "@setu/protocol";
import type { EventProvenance, StoredEvent } from "../contracts";

/**
 * NIP-01 tiebreaker for replaceable/addressable events.
 *
 * Newer `created_at` wins. On a tie the **lower lexical id** wins, which is the
 * rule that makes every client converge on the same version — the alternative
 * (first-seen wins) makes the store depend on relay response ordering.
 */
export function shouldReplace(
  incoming: NostrEvent,
  existing: NostrEvent,
): boolean {
  if (incoming.created_at > existing.created_at) return true;
  if (incoming.created_at < existing.created_at) return false;
  return incoming.id < existing.id;
}

/** What a store should do with an incoming event. */
export type PutDecision =
  | { readonly type: "insert" }
  /** Same id already held: merge provenance, do not duplicate the row. */
  | { readonly type: "mergeProvenance"; readonly stored: StoredEvent }
  /** Newer version of a replaceable/addressable event: evict `supersededId`. */
  | { readonly type: "replace"; readonly supersededId: string }
  | { readonly type: "reject"; readonly reason: RejectReason };

/** Why a `put` was refused. Surfaced for debug UIs, never silently swallowed. */
export type RejectReason = "invalid-shape" | "ephemeral" | "deleted" | "stale";

/**
 * Merges a newly-observed relay into existing provenance.
 *
 * Never loses a relay: knowing which relays served an event is what makes outbox
 * hints and "why do I have this?" debugging possible. Returns the same object
 * when nothing changed so callers can skip a write.
 */
export function mergeProvenance(
  existing: EventProvenance,
  relay: string | undefined,
): EventProvenance {
  if (relay === undefined || relay === "") return existing;
  if (existing.relays.includes(relay)) return existing;
  return {
    relays: [...existing.relays, relay],
    firstSeen: existing.firstSeen,
  };
}

/** Provenance for a first sighting. */
export function initialProvenance(
  relay: string | undefined,
  now: Timestamp,
): EventProvenance {
  return {
    relays: relay === undefined || relay === "" ? [] : [relay],
    firstSeen: now,
  };
}

/**
 * The canonical feed/query ordering: newest first, ties broken by ascending id.
 *
 * Stable and total, so paginating with `until` cannot skip or repeat an event
 * just because two events share a second.
 */
export function compareEventsNewestFirst(a: NostrEvent, b: NostrEvent): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** {@link compareEventsNewestFirst} lifted to {@link StoredEvent}. */
export function compareStoredNewestFirst(
  a: StoredEvent,
  b: StoredEvent,
): number {
  return compareEventsNewestFirst(a.event, b.event);
}
