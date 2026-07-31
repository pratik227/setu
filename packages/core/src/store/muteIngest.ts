/**
 * The mute list as a *storage* policy: which muted events are refused before they
 * are written at all.
 *
 * {@link ./muteFilter} is the predicate; this is the one place that decides how far
 * down the stack it is allowed to reach. The shape is copied from
 * {@link ./tombstones.TombstoneIndex.blocks} deliberately — a store asks one object
 * "may I keep this?" and gets a boolean — because that is the only shape an ingest
 * check can have without the store learning what a mute is.
 *
 * ## The trade-off, and why the line is drawn where it is
 *
 * Refusing at ingest is not free, and the costs are not the obvious ones:
 *
 *  - **Un-muting cannot bring back what was never stored.** A mute list is a
 *    *reading preference*, and a reading preference that destroys data is a
 *    different feature than the one the reader asked for. Whatever is refused here
 *    only returns after a refetch, and a refetch only returns what the relays still
 *    hold — which for anything older than a relay's retention window is nothing.
 *  - **The store stops being a faithful copy of what the relays sent.** Everything
 *    above it — provenance, `newestTimestamp`-driven incremental `since`, the
 *    offline read — is written on the assumption that the store holds what arrived.
 *    A refusal that silently punches holes in that makes every one of those
 *    slightly wrong in ways that do not announce themselves.
 *
 * So the answer is not "drop muted events". It is: **refuse exactly the muted
 * events that have no representation of their own, and keep everything a reader
 * could ever want back.**
 *
 * ### Refused: reactions, reposts and zap receipts from a muted author
 *
 * These three are pure arithmetic. Setu never renders a kind 7 or a kind 9735 as a
 * row — they exist only to be summed into a note's counts — and a kind 6 exists
 * only to put a name in a "reposted by" line, which the feed's mute pass already
 * removes. So there is nothing for un-muting to restore except a number, and that
 * number recomputes from the next interaction subscription. They are also the
 * highest-volume kinds on the network, which is the whole reason this hook is worth
 * having: a brigading account's ten thousand reactions were being fetched, verified,
 * stored, indexed and then discarded one layer from the screen.
 *
 * ### Kept: notes, replies and comments, whoever wrote them
 *
 * Refusing a kind 1 or kind 1111 would be the destructive version of this feature,
 * for three reasons that are each sufficient on their own:
 *
 *  1. **A reply is load-bearing structure.** Drop a muted account's reply and every
 *    reply *below* it loses its parent. The reader's own answer then hangs off
 *    nothing and renders as an orphan at the root of a thread it does not belong to
 *    — so muting one account visibly corrupts a conversation the reader is in.
 *  2. **"Reply" is not a kind.** A reply and a top-level note are both kind 1;
 *    telling them apart means inspecting `e` tags, and "carries an `e` tag" also
 *    matches a quote and a NIP-10 mention. An ingest policy that guesses wrong
 *    deletes top-level notes. The kind list below is the only line that can be
 *    drawn without guessing.
 *  3. **Notes are what a reader un-mutes to see.** The single most likely reason to
 *    un-mute somebody is to read something of theirs. A feature that makes that
 *    impossible has answered the wrong request.
 *
 * ### Only the author rule applies
 *
 * Word and hashtag rules are matched against `content`, and the content of the
 * kinds refused here is not prose: a reaction's is `+` or a single emoji, a zap
 * receipt's is a bolt11 invoice, a repost's is an embedded JSON blob. Matching words
 * there is noise at best — a reader whose word list happens to contain `+` would
 * have *every* like on the network refused, permanently, with no error anywhere. The
 * thread rule is excluded for a weaker but sufficient reason: a muted thread's own
 * rows are already gone from the feed, so refusing its reactions buys a count that
 * nothing displays.
 *
 * ### The reader is never refused
 *
 * The viewer's own reaction and repost are what `viewerReacted` and `viewerReposted`
 * are read from, so refusing them would leave the row offering to react a second
 * time to something this account already reacted to. `useMuteAction` will not write
 * a self-mute, but a list edited in another client can contain one, so the exemption
 * is enforced here rather than assumed.
 */

import type { Hex32, NostrEvent } from "@setu/protocol";
import type { MuteRules } from "./muteFilter";
import { isMuteRulesEmpty, NO_MUTES } from "./muteFilter";

/**
 * The kinds a mute rule may refuse at ingest.
 *
 * Numeric literals with comments, matching {@link ./retention.EVICTABLE_KINDS}:
 * this is a storage policy, and storage policy in this package does not depend on
 * the protocol package's kind table.
 */
export const MUTE_REFUSABLE_KINDS: readonly number[] = [
  6, // repost (NIP-18) — a name in a "reposted by" line, nothing more
  7, // reaction (NIP-25) — never rendered as a row, only summed
  16, // generic repost (NIP-18)
  9735, // zap receipt (NIP-57) — a number, published by an LNURL server
];

const REFUSABLE = new Set(MUTE_REFUSABLE_KINDS);

export interface MuteIngestOptions {
  readonly rules: MuteRules;
  /** The reader's own key, never refused. See the module doc. */
  readonly viewerPubkey?: Hex32 | undefined;
}

/**
 * True when the reader's mute list forbids storing `event` at all.
 *
 * Pure, so the decision can be tested and so both store implementations can share
 * it the way they share {@link ./tombstones.isTombstonedBy}.
 */
export function mutedAtIngest(
  event: NostrEvent,
  options: MuteIngestOptions,
): boolean {
  const { rules, viewerPubkey } = options;
  if (rules.pubkeys.size === 0) return false;
  if (!REFUSABLE.has(event.kind)) return false;
  if (event.pubkey === viewerPubkey) return false;
  return rules.pubkeys.has(event.pubkey);
}

/**
 * A store's mute-ingest gate.
 *
 * Deliberately the same shape as {@link ./tombstones.TombstoneIndex}: constructed
 * once, updated as facts arrive, and asked `blocks(event)` on the write path. The
 * difference is that a tombstone is permanent and global while this holds one
 * mutable reading preference, so it also has {@link update} — and the store must
 * treat a rule change as *forward-looking only*. Nothing here evicts what is
 * already stored: an eviction would turn every mute into an irreversible delete,
 * which is the outcome the module doc rules out.
 */
export class MuteIngestPolicy {
  private rules: MuteRules = NO_MUTES;
  private viewer: Hex32 | undefined;

  constructor(options?: Partial<MuteIngestOptions>) {
    if (options?.rules !== undefined) this.rules = options.rules;
    this.viewer = options?.viewerPubkey;
  }

  /** True when no rule could ever refuse anything, so callers can skip the check. */
  get inert(): boolean {
    return this.rules.pubkeys.size === 0;
  }

  /**
   * Replace the rules in force. Returns true when the policy actually changed.
   *
   * The boolean is what lets a caller avoid recomputing anything on the several
   * store ticks per second that re-emit an unchanged mute list.
   */
  update(rules: MuteRules, viewerPubkey?: Hex32 | undefined): boolean {
    if (this.rules === rules && this.viewer === viewerPubkey) return false;
    this.rules = rules;
    this.viewer = viewerPubkey;
    return true;
  }

  /** True when a mute rule forbids storing (or re-storing) `event`. */
  blocks(event: NostrEvent): boolean {
    if (isMuteRulesEmpty(this.rules)) return false;
    return mutedAtIngest(event, {
      rules: this.rules,
      viewerPubkey: this.viewer,
    });
  }

  /** Drops every rule, so nothing is refused. */
  clear(): void {
    this.rules = NO_MUTES;
    this.viewer = undefined;
  }
}

/**
 * A store that can be told the reader's mute rules.
 *
 * A separate interface rather than a member of {@link ../contracts.EventStore}, for
 * the same reason {@link ./retention.EvictingEventStore} is separate: it is a
 * *capability*, not part of what makes something an event store. A test double, an
 * in-memory fixture, or a future remote-backed store is a perfectly complete
 * `EventStore` without it, and widening the core contract would break every one of
 * them to add a hook only two implementations can honour.
 *
 * Callers feature-detect with {@link supportsMuteIngest} instead of assuming.
 */
export interface MuteAwareEventStore {
  /**
   * Replace the mute rules the write path enforces.
   *
   * **Forward-looking only.** Nothing already stored is evicted — see the module
   * doc: an eviction here would turn a reading preference into an irreversible
   * delete. Safe to call on every tick; an unchanged list costs one reference
   * comparison.
   */
  setMuteRules(rules: MuteRules, viewerPubkey?: Hex32 | undefined): void;
}

/** True when this store enforces mute rules on its write path. */
export function supportsMuteIngest<T>(
  store: T,
): store is T & MuteAwareEventStore {
  return (
    typeof (store as { setMuteRules?: unknown }).setMuteRules === "function"
  );
}
