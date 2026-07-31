/**
 * Applying a mute list to feed rows, before anything downstream can charge for
 * them.
 *
 * Placed here — between the feed engine's rows and the surface that resolves
 * metadata for them — because of what lives on the other side of this call in
 * `LiveFeed`: the bounded metadata window, the author interest set, the interaction
 * interest set, and the events map handed to the row action hook. A muted account
 * that survives this pass takes one of the forty metadata slots, one of the tracked
 * note ids, and a profile fetch, and it does all of that whether or not a row is
 * ever painted. Filtering in the row component instead would keep every one of
 * those costs and save only the pixels.
 *
 * Three properties this pass has to hold, all of them for reasons that were
 * measured elsewhere in this feature and documented in `LiveFeed` and `FeedView`:
 *
 *  1. **Identity is preserved.** An unchanged row comes back as the *same object*,
 *     and a pass that removed nothing returns the *same array*. Rows are memoised
 *     on their props; rebuilding them here would re-tokenize every note's content
 *     on every store tick and undo the feed's row memoisation wholesale.
 *  2. **Nothing is hidden silently.** The counts come back with the rows so the
 *     surface can state them. A feed that quietly drops rows is indistinguishable
 *     from a broken feed, and the reader has no way to tell which they are looking
 *     at.
 *  3. **A reposter is a separate decision from an author.** Muting someone has to
 *     stop them pushing content into the reader's feed by reposting it, but their
 *     repost of an unmuted note is not a reason to hide the note.
 */

import {
  type FeedEntry,
  isMuted,
  isMuteRulesEmpty,
  type MuteRules,
} from "@setu/core";

export interface MutedFeed {
  /** Rows the reader should see. The input array itself when nothing changed. */
  readonly entries: readonly FeedEntry[];
  /** Rows removed entirely. */
  readonly hiddenRows: number;
  /** Rows kept, with at least one muted account dropped from "reposted by". */
  readonly trimmedReposts: number;
}

export interface MuteFilterOptions {
  readonly rules: MuteRules;
  /**
   * The reader's own key, never hidden from them.
   *
   * A word mute is a rule about what the reader wants to read *from others*. Left
   * unchecked it also swallows the reader's own note the instant they post it, which
   * reads as a failed publish — and the reply they were composing is gone with it.
   */
  readonly viewerPubkey?: string | undefined;
  /**
   * Per-row memo, so a row that survived last tick comes back as the same object.
   * `null` marks a row that was dropped. Must be discarded when the rules change.
   */
  readonly cache?: WeakMap<FeedEntry, FeedEntry | null> | undefined;
}

/** The event a row is really about: for a repost, the note being reposted. */
function displayedEvent(entry: FeedEntry) {
  return entry.kind === "repost" ? (entry.target ?? entry.event) : entry.event;
}

/** Drops muted rows and muted reposters, counting both. */
export function filterMutedEntries(
  entries: readonly FeedEntry[],
  options: MuteFilterOptions,
): MutedFeed {
  const { rules, viewerPubkey, cache } = options;
  // The common case by a wide margin, and the one that must cost nothing: same
  // array back, so every memo downstream of here stays valid.
  if (isMuteRulesEmpty(rules)) {
    return { entries, hiddenRows: 0, trimmedReposts: 0 };
  }

  const kept: FeedEntry[] = [];
  let hiddenRows = 0;
  let trimmedReposts = 0;
  let changed = false;

  for (const entry of entries) {
    const memo = cache?.get(entry);
    if (memo !== undefined) {
      if (memo === null) {
        hiddenRows += 1;
        changed = true;
        continue;
      }
      if (memo !== entry) {
        trimmedReposts += 1;
        changed = true;
      }
      kept.push(memo);
      continue;
    }

    const resolved = resolveEntry(entry, rules, viewerPubkey);
    cache?.set(entry, resolved);
    if (resolved === null) {
      hiddenRows += 1;
      changed = true;
      continue;
    }
    if (resolved !== entry) {
      trimmedReposts += 1;
      changed = true;
    }
    kept.push(resolved);
  }

  return {
    entries: changed ? kept : entries,
    hiddenRows,
    trimmedReposts,
  };
}

/** The row as it should appear, a rewritten row, or `null` to drop it. */
function resolveEntry(
  entry: FeedEntry,
  rules: MuteRules,
  viewerPubkey: string | undefined,
): FeedEntry | null {
  const source = displayedEvent(entry);
  if (source.pubkey !== viewerPubkey && isMuted(source, rules)) return null;
  if (entry.kind !== "repost" || entry.reposters.length === 0) return entry;

  // Only the author rule applies to a reposter: a reposter contributes a pubkey to
  // the row, not content, so word and hashtag rules have nothing to match against.
  const reposters = entry.reposters.filter(
    (pubkey) => pubkey === viewerPubkey || !rules.pubkeys.has(pubkey),
  );
  if (reposters.length === entry.reposters.length) return entry;
  // The row exists only because muted accounts reposted, so it goes with them. The
  // note itself is unaffected and still appears on its own if the feed holds it.
  if (reposters.length === 0) return null;
  // `repostIds` is left alone: it is not index-aligned with `reposters` (reposters
  // are deduped and sorted by time) and nothing in the view path reads it, so
  // filtering it would be guesswork for no gain.
  return { ...entry, reposters };
}

/**
 * One sentence stating what the mute list removed from this page, or `undefined`
 * when it removed nothing.
 *
 * Says *why* rather than only how many. "3 notes hidden" from a feed the reader did
 * not knowingly filter is a bug report waiting to happen; naming the mute list makes
 * it an explanation and points at the thing to change.
 */
export function muteFilterNotice(result: MutedFeed): string | undefined {
  const parts: string[] = [];
  if (result.hiddenRows > 0) {
    parts.push(
      `${result.hiddenRows} ${result.hiddenRows === 1 ? "note" : "notes"} hidden by your mute list`,
    );
  }
  if (result.trimmedReposts > 0) {
    parts.push(
      `${result.trimmedReposts} ${
        result.trimmedReposts === 1 ? "repost" : "reposts"
      } by muted accounts not credited`,
    );
  }
  if (parts.length === 0) return undefined;
  return `${parts.join(", ")}.`;
}
