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
 */

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
    a.approximate === b.approximate
  );
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

  const wanted = new Set(noteIds);
  const tallies = new Map<string, Tally>();
  /** Events attributed to each note, to detect a note at the query's bound. */
  const seen = new Map<string, number>();
  for (const id of wanted) {
    tallies.set(id, emptyTally());
    seen.set(id, 0);
  }

  for (const event of events) {
    for (const target of interactionTargets(event)) {
      const tally = tallies.get(target);
      if (tally === undefined) continue;
      seen.set(target, (seen.get(target) ?? 0) + 1);
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
    const candidate: NoteInteractions = {
      ...tally,
      approximate: (seen.get(id) ?? 0) >= limit,
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
