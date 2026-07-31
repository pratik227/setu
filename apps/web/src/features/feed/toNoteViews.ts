import type { FeedEntry } from "@setu/core";
import type { NostrEvent } from "@setu/protocol";
import { getTagged, getTagValue, rootAndReplyIds } from "@setu/protocol";
import {
  EMPTY_INTERACTIONS,
  type NoteInteractions,
} from "../notes/interactionCounts";
import { noteMediaViews } from "../notes/noteMediaViews";
import type { AuthorView, MediaView, NoteView } from "../notes/types";
import { fallbackAuthor } from "../profiles/useAuthors";

/**
 * Turn feed rows into render models.
 *
 * A pure function, deliberately: given the same rows, authors and counts it
 * produces the same output, so it is trivially testable and cannot accidentally
 * touch the store during render. Everything the row needs is resolved before it
 * gets here.
 */
/**
 * Same author, by value.
 *
 * Reference equality is not enough: an *unresolved* author is built fresh by
 * `fallbackAuthor` on every call, so two views of the same unnamed pubkey hold
 * different objects with identical contents. Comparing by reference alone made
 * every row look changed for exactly the rows most likely to be stable.
 */
function sameAuthor(a: AuthorView, b: AuthorView): boolean {
  if (a === b) return true;
  return (
    a.pubkey === b.pubkey &&
    a.resolved === b.resolved &&
    a.displayName === b.displayName &&
    a.handle === b.handle &&
    a.avatarUrl === b.avatarUrl &&
    a.verified === b.verified &&
    a.lightning === b.lightning
  );
}

/**
 * Is this view identical, field for field, to the one we built last tick?
 *
 * Shallow on the scalars, by-value on the author. `media` is still compared by
 * reference, and that is sound rather than lucky: it is derived from the event,
 * which is immutable, so `mediaFor` below hands back the previous array whenever
 * the row still shows the same note. Building a fresh array here and comparing it
 * by reference would mark every media row changed on every tick.
 *
 * `tags` is the same bargain for free: it *is* the event's own array, so the same
 * note always presents the same reference. Anything added to `NoteView` has to
 * appear here and has to be either a scalar or a reference held across ticks —
 * otherwise every row looks changed on every tick and the memo below skips
 * nothing.
 */
function sameView(a: NoteView, b: NoteView): boolean {
  return (
    a.id === b.id &&
    a.rowKey === b.rowKey &&
    a.kind === b.kind &&
    a.tags === b.tags &&
    a.content === b.content &&
    a.createdAt === b.createdAt &&
    sameAuthor(a.author, b.author) &&
    a.replyCount === b.replyCount &&
    a.repostCount === b.repostCount &&
    a.reactionCount === b.reactionCount &&
    a.zapSats === b.zapSats &&
    a.viewerReacted === b.viewerReacted &&
    a.viewerReposted === b.viewerReposted &&
    a.countsApproximate === b.countsApproximate &&
    a.justArrived === b.justArrived &&
    a.contentWarning === b.contentWarning &&
    a.media === b.media &&
    a.replyingTo?.author === b.replyingTo?.author &&
    a.repostedBy?.length === b.repostedBy?.length &&
    (a.repostedBy ?? []).every((r, i) => {
      const other = b.repostedBy?.[i];
      return other !== undefined && sameAuthor(r, other);
    })
  );
}

/**
 * The row's media, reusing the previous array whenever the row still shows the
 * same note.
 *
 * Both halves matter. Deriving media here rather than from the rendered body is
 * what gets the author's declared `imeta` dimensions onto the view model, which is
 * the only way a row can reserve an image's box before it loads. Reusing the
 * previous array is what keeps that from costing the row's memoisation: events are
 * immutable, so identical `id` and `content` means identical media, and handing
 * back the same array lets `sameView` keep comparing `media` by reference.
 *
 * Tokenizing the content is the expensive part, and this is what confines it to
 * rows that are actually new — not to every row on every store tick.
 */
function mediaFor(
  source: NostrEvent,
  earlier: NoteView | undefined,
): readonly MediaView[] | undefined {
  if (
    earlier !== undefined &&
    earlier.id === source.id &&
    earlier.content === source.content
  ) {
    return earlier.media;
  }
  return noteMediaViews(source);
}

/**
 * Feed rows from feed entries.
 *
 * `previous` exists so unchanged rows keep their object identity. The store
 * re-emits the whole matching set on every tick, so without it every row is a new
 * object every time any single interaction count lands — and `React.memo` on the
 * row would compare fresh objects and never skip anything. Reusing the previous
 * object is what makes memoisation downstream actually work.
 */
export function toNoteViews(
  entries: readonly FeedEntry[],
  authors: ReadonlyMap<string, AuthorView>,
  interactions: ReadonlyMap<string, NoteInteractions>,
  arrivedAfter: number,
  previous: readonly NoteView[] = [],
): readonly NoteView[] {
  const before = new Map(previous.map((view) => [view.rowKey, view]));
  const views: NoteView[] = [];

  for (const entry of entries) {
    // For a repost row the displayed content is the *target* note when we hold
    // it; falling back to the repost event itself would render an empty body,
    // since a kind-6 usually carries no content of its own.
    const source =
      entry.kind === "repost" ? (entry.target ?? entry.event) : entry.event;
    const author = authors.get(source.pubkey) ?? fallbackAuthor(source.pubkey);
    const counts = interactions.get(source.id) ?? EMPTY_INTERACTIONS;
    const { reply: replyId } = rootAndReplyIds(source);
    // NIP-36: the *presence* of the tag means "warn". A bare
    // `["content-warning"]` carries no reason but still must blur, so presence
    // and reason are read separately — keying off the value alone renders
    // sensitive notes unblurred.
    const hasWarning = getTagged(source, "content-warning").length > 0;
    const warningReason = getTagValue(source, "content-warning");

    const reposters: AuthorView[] = entry.reposters.map(
      (pubkey) => authors.get(pubkey) ?? fallbackAuthor(pubkey),
    );

    const earlier = before.get(entry.key);
    const media = mediaFor(source, earlier);

    const built: NoteView = {
      id: source.id,
      // The entry's key, not the note's id: a reposted note also appears on its
      // own, and both rows would otherwise claim the same React key.
      rowKey: entry.key,
      author,
      kind: source.kind,
      // The event's own array, deliberately not a copy — see `NoteView.tags`.
      tags: source.tags,
      createdAt: source.created_at,
      content: source.content,
      replyCount: counts.replies,
      repostCount: Math.max(counts.reposts, entry.reposters.length),
      reactionCount: counts.reactions,
      zapSats: counts.zapSats,
      viewerReacted: counts.viewerReacted,
      viewerReposted: counts.viewerReposted,
      ...(media ? { media } : {}),
      ...(counts.approximate ? { countsApproximate: true } : {}),
      ...(reposters.length > 0 ? { repostedBy: reposters } : {}),
      ...(hasWarning
        ? {
            contentWarning: warningReason || "Marked sensitive by the author",
          }
        : {}),
      ...(replyId
        ? {
            replyingTo: {
              id: replyId,
              author: authors.get(source.pubkey)?.displayName ?? "someone",
            },
          }
        : {}),
      // Only animate rows that appeared after the first paint; animating the
      // initial page would blur-in the whole screen on load.
      ...(source.created_at > arrivedAfter ? { justArrived: true } : {}),
    };

    // Keep the previous object when nothing about the row changed, so a memoised
    // row can skip re-rendering. A tick that only resolved one author's name
    // should re-render one row, not the whole page.
    views.push(
      earlier !== undefined && sameView(earlier, built) ? earlier : built,
    );
  }

  return views;
}

/** Distinct pubkeys a page of rows needs metadata for, authors and reposters. */
export function pubkeysIn(entries: readonly FeedEntry[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) {
    const source =
      entry.kind === "repost" ? (entry.target ?? entry.event) : entry.event;
    set.add(source.pubkey);
    for (const reposter of entry.reposters) set.add(reposter);
  }
  return [...set];
}

/** Note ids a page of rows needs interaction counts for. */
export function noteIdsIn(entries: readonly FeedEntry[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) {
    const source =
      entry.kind === "repost" ? (entry.target ?? entry.event) : entry.event;
    set.add(source.id);
  }
  return [...set];
}

/**
 * The events behind a page of rows, keyed by the id the row renders under.
 *
 * Acting on a note needs the event, not the view model: a reaction tags the
 * target's id, pubkey *and* kind, and a reply's thread position is read off the
 * parent's own `e` tags. Rendering still takes only `NoteView`s — this map is the
 * separate, explicit channel for the write path, so no row reaches back into the
 * store while rendering.
 *
 * For a repost row the mapped event is the *target* note, matching the id
 * `toNoteViews` gives that row: reacting to a repost row must react to the note
 * being reposted, not to the kind-6.
 */
export function noteEventsIn(
  entries: readonly FeedEntry[],
): Map<string, NostrEvent> {
  const events = new Map<string, NostrEvent>();
  for (const entry of entries) {
    const source =
      entry.kind === "repost" ? (entry.target ?? entry.event) : entry.event;
    events.set(source.id, source);
  }
  return events;
}
