/**
 * Editing a follow list (kind 3) without destroying it.
 *
 * A kind-3 is *replaceable*: publishing one replaces the previous entirely.
 * There is no "add a follow" operation on the network — only "here is my whole
 * list now". That makes every write a chance to silently delete data, and it is
 * how clients unfollow hundreds of people at once. Three distinct ways to lose
 * data, all of which this module prevents:
 *
 *  1. **Writing from a stale snapshot.** Anyone added since our copy was fetched
 *     disappears. Mitigated by the caller (`useFollowAction`) re-fetching before
 *     every write; this module's job is to never invent a list from nothing.
 *  2. **Dropping non-`p` tags.** A kind-3 legitimately carries other tags, and a
 *     rebuild that emits only `p` tags deletes them.
 *  3. **Dropping `content`.** By long-standing convention kind-3 `content` holds
 *     a JSON relay configuration. It is easy to treat as empty and overwrite,
 *     which wipes the user's relay setup as a side effect of following someone.
 *
 * Petnames (the fourth element of a `p` tag) and relay hints (the third) are
 * likewise preserved per entry.
 */

import type { EventTemplate, Hex32, NostrEvent } from "@setu/protocol";
import { Kind } from "@setu/protocol";

/** Why a follow edit was refused. */
export type FollowEditRefusal =
  /** No kind-3 was found and we are not certain none exists. */
  | "unverified-absence"
  /** The target is already in the requested state; nothing to write. */
  | "no-change";

export type FollowEditResult =
  | { readonly ok: true; readonly template: EventTemplate }
  | { readonly ok: false; readonly reason: FollowEditRefusal };

export interface FollowEditInput {
  /** The newest kind-3 we could find, or undefined if none exists. */
  readonly current: NostrEvent | undefined;
  /**
   * True only when every queried relay answered and none held a kind-3.
   * Required to create a first list: "nobody returned one" and "we did not
   * finish asking" are indistinguishable from a partial result, and treating the
   * second as the first replaces a real list with a one-entry list.
   */
  readonly absenceConfirmed: boolean;
  readonly target: Hex32;
  readonly action: "follow" | "unfollow";
}

/** Does this event's `p` tags include `target`? */
export function followsPubkey(
  event: NostrEvent | undefined,
  target: Hex32,
): boolean {
  if (!event) return false;
  return event.tags.some((tag) => tag[0] === "p" && tag[1] === target);
}

/** Pubkeys followed, in list order, deduped. */
export function followedPubkeys(event: NostrEvent | undefined): Hex32[] {
  if (!event) return [];
  const seen = new Set<Hex32>();
  const out: Hex32[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "p") continue;
    const pubkey = tag[1];
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push(pubkey);
  }
  return out;
}

/**
 * Build the replacement kind-3 for a follow or unfollow.
 *
 * The returned template is the *entire* new list. Everything not explicitly
 * changed is copied through byte-for-byte.
 */
export function editFollowList(input: FollowEditInput): FollowEditResult {
  const { current, absenceConfirmed, target, action } = input;

  if (!current && !absenceConfirmed) {
    // Refusing is the whole point. A first follow that overwrites an existing
    // list we failed to fetch is indistinguishable, afterwards, from the user
    // having unfollowed everyone.
    return { ok: false, reason: "unverified-absence" };
  }

  const already = followsPubkey(current, target);
  if (action === "follow" && already) return { ok: false, reason: "no-change" };
  if (action === "unfollow" && !already) {
    return { ok: false, reason: "no-change" };
  }

  const existingTags = current?.tags ?? [];
  const tags: string[][] = [];

  if (action === "unfollow") {
    // Copy every tag except the target's `p` entries. Duplicated entries for the
    // same pubkey are all removed, or the unfollow silently does nothing.
    for (const tag of existingTags) {
      if (tag[0] === "p" && tag[1] === target) continue;
      tags.push([...tag]);
    }
  } else {
    for (const tag of existingTags) tags.push([...tag]);
    // Append rather than insert: order in a kind-3 is not meaningful, and
    // appending leaves every existing entry at its original index, which keeps
    // diffs between consecutive versions readable.
    tags.push(["p", target]);
  }

  return {
    ok: true,
    template: {
      kind: Kind.Contacts,
      // Carried through verbatim. This field holds the user's relay
      // configuration in many clients; regenerating or blanking it destroys it.
      content: current?.content ?? "",
      tags,
    },
  };
}

/**
 * Sanity check before publishing: refuse a write that loses an implausible
 * number of follows.
 *
 * A last line of defence against a bug upstream of here. Going from 400 follows
 * to 1 is never a user intent expressed through a follow button, so it is
 * treated as a defect and blocked rather than published.
 */
export function isPlausibleFollowWrite(
  before: NostrEvent | undefined,
  template: EventTemplate,
): boolean {
  const previous = followedPubkeys(before).length;
  const next = (template.tags ?? []).filter((tag) => tag[0] === "p").length;
  // A single follow/unfollow moves the count by exactly one.
  return Math.abs(next - previous) <= 1;
}

/**
 * Follow several people at once, for applying a follow pack.
 *
 * A separate entry point rather than a loop over {@link editFollowList}, because a
 * loop would be wrong in a way that is easy to miss: each iteration builds its
 * template from `current`, so publishing them in sequence produces N events that
 * each add one person and *drop the previous N−1*. The last one to win would leave
 * the account following exactly one of the pack's members. One event, built once,
 * is the only correct shape.
 *
 * Every other rule from the single-target path still applies — an unconfirmed
 * absence refuses, unknown tags are copied through byte-for-byte, and entries are
 * appended so existing indices do not move.
 */
export function followManyEdit(input: {
  readonly current: NostrEvent | undefined;
  readonly absenceConfirmed: boolean;
  readonly targets: readonly Hex32[];
}): FollowEditResult {
  const { current, absenceConfirmed, targets } = input;

  if (!current && !absenceConfirmed) {
    // Same reasoning as a first single follow: creating a list from an unverified
    // absence is indistinguishable, afterwards, from unfollowing everyone.
    return { ok: false, reason: "unverified-absence" };
  }

  const already = new Set(followedPubkeys(current));
  const additions = [...new Set(targets)].filter(
    (target) => !already.has(target),
  );
  if (additions.length === 0) return { ok: false, reason: "no-change" };

  const tags: string[][] = (current?.tags ?? []).map((tag) => [...tag]);
  for (const target of additions) tags.push(["p", target]);

  return {
    ok: true,
    template: {
      kind: Kind.Contacts,
      // Preserved verbatim: kind-3 `content` historically carried a relay map,
      // and dropping it is a silent data loss for whoever still reads one.
      content: current?.content ?? "",
      created_at: Math.floor(Date.now() / 1000),
      tags,
    },
  };
}

/**
 * Plausibility guard for a bulk follow.
 *
 * Different from {@link isPlausibleFollowWrite} because the expected delta is
 * different: applying a pack is purely *additive*. The count may rise by any
 * amount, but it must never fall — a bulk write that removes anybody is a bug in
 * the merge, and publishing it would silently unfollow people the user never
 * touched.
 */
export function isPlausibleBulkFollow(
  before: NostrEvent | undefined,
  template: EventTemplate,
): boolean {
  const previous = followedPubkeys(before).length;
  const next = (template.tags ?? []).filter((tag) => tag[0] === "p").length;
  return next >= previous;
}
