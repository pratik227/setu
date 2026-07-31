/**
 * Thread events -> render models.
 *
 * This is a thin adapter over `toNoteViews`, not a second mapper. Content
 * warnings, reply context lines, repost coalescing and the "just arrived"
 * animation flag all have exactly one implementation, and a thread row must
 * behave identically to a feed row or the two surfaces drift on every rule added
 * later. So thread events are wrapped as single-note feed entries and handed to
 * the same pure function the feed uses.
 */

import type { FeedEntry } from "@setu/core";
import type { NostrEvent } from "@setu/protocol";
import { toNoteViews } from "../feed/toNoteViews";
import type { NoteInteractions } from "../notes/interactionCounts";
import type { AuthorView, NoteView } from "../notes/types";

const NO_REPOSTS: readonly string[] = [];

/** Wrap a thread event as the single-note feed row it is. */
function asEntry(event: NostrEvent): FeedEntry {
  return {
    key: `note:${event.id}`,
    kind: "note",
    event,
    createdAt: event.created_at,
    reposters: NO_REPOSTS,
    repostIds: NO_REPOSTS,
  };
}

/** Render models for a thread, keyed by event id for lookup during layout. */
export function threadNoteViews(
  events: readonly NostrEvent[],
  authors: ReadonlyMap<string, AuthorView>,
  interactions: ReadonlyMap<string, NoteInteractions>,
  arrivedAfter: number,
): ReadonlyMap<string, NoteView> {
  const views = toNoteViews(
    events.map(asEntry),
    authors,
    interactions,
    arrivedAfter,
  );
  const byId = new Map<string, NoteView>();
  for (const view of views) byId.set(view.id, view);
  return byId;
}
