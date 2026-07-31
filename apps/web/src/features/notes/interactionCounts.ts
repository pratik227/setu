/**
 * Interaction counts for a set of notes, as a pure function of held events.
 *
 * Split out of the hook because every interesting rule here is a property of a
 * function over a list of events, and because the *identity* of the result is
 * itself load-bearing:
 *
 *  - A note whose events did not change must come back as the **same object**. A
 *    feed renders forty rows off this map; allocating a fresh entry per store tick
 *    makes one arriving reaction re-render every row.
 *  - When nothing changed for any note, the whole map comes back unchanged, so a
 *    consumer memoizing on it does no work at all.
 *
 * Counts are computed from events we hold and verified, so they lag a relay's own
 * totals. That is the honest trade: NIP-45 `COUNT` would be one round trip but
 * asks the relay to be authoritative for a number we cannot check. Because the
 * network query is bounded (see `useInteractions`), a note can also have *more*
 * interactions than we were served — `approximate` marks the ones where that is
 * demonstrably possible, and the UI must then present the number as a floor
 * rather than a total.
 *
 * ## Mutes reach the arithmetic, not just the rows
 *
 * A mute list that only hides rows leaves the muted account's replies and reactions
 * inflating the totals on every note the reader *can* see — so a note with three
 * visible answers reads "12 replies", and the nine missing ones are attributed to a
 * bug rather than to a rule the reader set. `muteRules` closes that, and what is
 * excluded is counted into {@link NoteInteractions.mutedOut} rather than silently
 * subtracted: a number that got smaller with no explanation is the same failure
 * wearing the other hat.
 */

import { isMuted, isMuteRulesEmpty, type MuteRules } from "@setu/core";
import { Kind, type NostrEvent } from "@setu/protocol";
import { zapReceiptSats } from "./bolt11";

export interface NoteInteractions {
  readonly replies: number;
  readonly reposts: number;
  readonly reactions: number;
  readonly zapSats: number;
  /** True when the signed-in account has reacted. */
  readonly viewerReacted: boolean;
  readonly viewerReposted: boolean;
  /**
   * True when this note's counts are a floor rather than a total: it reached the
   * bound we asked relays for, so there may be more we were never served. The UI
   * must render such a count as "500+", never as an exact number.
   */
  readonly approximate: boolean;
  /**
   * Interactions the reader's mute list removed from the numbers above.
   *
   * Optional, and absent rather than `0` when nothing was removed, so a surface
   * can branch on presence and so the several places that build a
   * `NoteInteractions` literal did not all have to change to say "nothing".
   *
   * This exists because the counts must never quietly shrink. It is one figure
   * covering replies, reposts, reactions and zaps together: a reader being told
   * "your mute list removed 9 of these" needs to know the number is filtered, not
   * a per-kind breakdown of who they muted.
   */
  readonly mutedOut?: number;
}

export const EMPTY_INTERACTIONS: NoteInteractions = {
  replies: 0,
  reposts: 0,
  reactions: 0,
  zapSats: 0,
  viewerReacted: false,
  viewerReposted: false,
  approximate: false,
};

/**
 * Kinds that count as an interaction with a note.
 *
 * Kind 1111 is here because NIP-22 comments are replies: the thread view already
 * renders them (`useThread`'s `REPLY_KINDS`) and notifications already group them,
 * so leaving them out made a note with ten comments show a reply count of zero.
 */
export const INTERACTION_KINDS: readonly number[] = [
  Kind.ShortTextNote,
  Kind.Comment,
  Kind.Repost,
  Kind.Reaction,
  Kind.Zap,
];

/**
 * The event ids an interaction points at.
 *
 * Lowercase `e` is the NIP-01/NIP-10 reference. Uppercase `E` is NIP-22's root
 * scope, and a comment on a note may name the note in either — so reading only
 * lowercase undercounts comments that scope by root. Ids are de-duplicated because
 * a comment that carries the same id as both `E` and `e` is one comment, not two.
 */
export function interactionTargets(event: NostrEvent): readonly string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    const name = tag[0];
    if (name !== "e" && name !== "E") continue;
    const id = tag[1];
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

interface Tally {
  replies: number;
  reposts: number;
  reactions: number;
  zapSats: number;
  viewerReacted: boolean;
  viewerReposted: boolean;
}

function emptyTally(): Tally {
  return {
    replies: 0,
    reposts: 0,
    reactions: 0,
    zapSats: 0,
    viewerReacted: false,
    viewerReposted: false,
  };
}

function sameCounts(a: NoteInteractions, b: NoteInteractions): boolean {
  return (
    a.replies === b.replies &&
    a.reposts === b.reposts &&
    a.reactions === b.reactions &&
    a.zapSats === b.zapSats &&
    a.viewerReacted === b.viewerReacted &&
    a.viewerReposted === b.viewerReposted &&
    a.approximate === b.approximate &&
    // Compared through a default because the field is absent when zero. Left out
    // of this check, a mute would change the number a row displays while the row
    // kept the object it was already rendering — the count would not update until
    // something else about the note changed.
    (a.mutedOut ?? 0) === (b.mutedOut ?? 0)
  );
}

/**
 * Does the reader's mute list cover this interaction?
 *
 * The rule is split by kind, and the split is the whole judgement here:
 *
 *  - **Replies and comments get every rule.** They carry prose the reader would be
 *    shown in a thread, so a word or hashtag mute means the same thing about them
 *    that it means about a feed row. Counting an answer the reader will never be
 *    shown is what makes a reply count a promise the thread cannot keep.
 *  - **Everything else gets the author rule alone.** A reaction's content is `+` or
 *    a single emoji and a zap receipt's is a bolt11 invoice, so word rules have
 *    nothing meaningful to match there — and a reader whose word list happened to
 *    contain `+` would see every like count on the network drop to zero. Same
 *    reasoning as the reposter rule in `moderation/muteEntries.ts`: these events
 *    contribute a pubkey and a number, not content.
 */
function mutedInteraction(event: NostrEvent, rules: MuteRules): boolean {
  if (event.kind === Kind.ShortTextNote || event.kind === Kind.Comment) {
    return isMuted(event, rules);
  }
  return rules.pubkeys.has(event.pubkey);
}

export interface CountInput {
  /** The notes counts are wanted for. Ids outside this set are ignored. */
  readonly noteIds: readonly string[];
  /** Every interaction event held for those notes, in any order. */
  readonly events: readonly NostrEvent[];
  /** The signed-in account, for `viewerReacted` / `viewerReposted`. */
  readonly viewerPubkey?: string;
  /**
   * The per-relay bound the network query carried. A note whose counted events
   * reach it is marked `approximate`, because the relay may have withheld older
   * interactions to honour the limit.
   */
  readonly limit: number;
  /**
   * The reader's mute rules. Interactions they cover are left out of the totals
   * and counted into `mutedOut` instead.
   *
   * Omitted (or `NO_MUTES`) means count everything, and costs nothing: the empty
   * case is checked once per call, not once per event.
   */
  readonly muteRules?: MuteRules;
  /** The previous result, for identity reuse. */
  readonly previous: ReadonlyMap<string, NoteInteractions>;
}

/**
 * Count interactions per note, reusing unchanged entries.
 *
 * Returns `previous` itself when no note's counts changed.
 */
export function countInteractions(
  input: CountInput,
): ReadonlyMap<string, NoteInteractions> {
  const { noteIds, events, viewerPubkey, limit, previous } = input;

  // Resolved once. An empty rule set is the common case and must not put a
  // per-event predicate call on the hot path of a live feed's tally.
  const rules =
    input.muteRules !== undefined && !isMuteRulesEmpty(input.muteRules)
      ? input.muteRules
      : undefined;

  const wanted = new Set(noteIds);
  const tallies = new Map<string, Tally>();
  /** Events attributed to each note, to detect a note at the query's bound. */
  const seen = new Map<string, number>();
  /** Attributed events the mute list removed, per note. */
  const excluded = new Map<string, number>();
  for (const id of wanted) {
    tallies.set(id, emptyTally());
    seen.set(id, 0);
  }

  for (const event of events) {
    // The reader's own interactions are never excluded: they are what
    // `viewerReacted` and `viewerReposted` are read from, and a row that loses
    // them offers to react a second time to something already reacted to.
    const muted =
      rules !== undefined &&
      event.pubkey !== viewerPubkey &&
      mutedInteraction(event, rules);

    for (const target of interactionTargets(event)) {
      const tally = tallies.get(target);
      if (tally === undefined) continue;
      // Counted before the mute check, and deliberately: `seen` measures what the
      // *relay* served, which is what decides `approximate`. Skipping muted events
      // here would mark a note whose 500 served interactions were all from muted
      // accounts as an exact zero, when the relay demonstrably had more.
      seen.set(target, (seen.get(target) ?? 0) + 1);
      if (muted) {
        excluded.set(target, (excluded.get(target) ?? 0) + 1);
        continue;
      }
      switch (event.kind) {
        // NIP-22 comments are replies. Both kinds land in the same bucket
        // because a reader counting answers does not distinguish them.
        case Kind.ShortTextNote:
        case Kind.Comment:
          tally.replies += 1;
          break;
        case Kind.Repost:
          tally.reposts += 1;
          if (event.pubkey === viewerPubkey) tally.viewerReposted = true;
          break;
        case Kind.Reaction:
          // NIP-25: "-" is an explicit downvote and must not read as a like.
          if (event.content.trim() === "-") break;
          tally.reactions += 1;
          if (event.pubkey === viewerPubkey) tally.viewerReacted = true;
          break;
        case Kind.Zap:
          tally.zapSats += zapReceiptSats(event.tags);
          break;
        default:
          break;
      }
    }
  }

  const next = new Map<string, NoteInteractions>();
  let changed = tallies.size !== previous.size;
  for (const [id, tally] of tallies) {
    const mutedOut = excluded.get(id) ?? 0;
    const candidate: NoteInteractions = {
      ...tally,
      approximate: (seen.get(id) ?? 0) >= limit,
      ...(mutedOut > 0 ? { mutedOut } : {}),
    };
    const before = previous.get(id);
    if (before !== undefined && sameCounts(before, candidate)) {
      // Same numbers: hand back the object the rows are already rendering, so a
      // reaction on one note does not invalidate every other row's props.
      next.set(id, before);
      continue;
    }
    next.set(id, candidate);
    changed = true;
  }

  return changed ? next : previous;
}

/**
 * One sentence stating what this note's counts leave out, or `undefined` when they
 * leave out nothing.
 *
 * Worded here rather than at the row so the disclosure cannot drift from the rule
 * that produced it. It names the mute list, because "9 hidden" on a number the
 * reader did not knowingly filter is a bug report, while "your mute list" is an
 * explanation and points at the thing to change.
 *
 * Takes the one field it reads rather than a whole {@link NoteInteractions}, so the
 * row can call it with a `NoteView` — which carries the same figure as
 * `countsMutedOut` and has no reason to reconstruct a tally object to ask a question
 * about one number.
 */
export function mutedCountNotice(counts: {
  readonly mutedOut?: number;
}): string | undefined {
  const removed = counts.mutedOut ?? 0;
  if (removed === 0) return undefined;
  return `${removed} ${
    removed === 1
      ? "reply, repost or reaction is"
      : "replies, reposts or reactions are"
  } not counted here because your mute list covers who made ${removed === 1 ? "it" : "them"}.`;
}
