/**
 * Four subsystems' states, merged into at most one answer per note row.
 *
 * A row must show exactly one spinner, one transient notice and one error, and
 * reactions, bookmarks, zaps and share are four independent hooks with four
 * independent notions of "working". Resolving that here rather than in the row
 * keeps `NoteActionRow` ignorant of which subsystem is talking, and — because it
 * is a pure function of the four states — makes the precedence testable, which a
 * closure over live hook state was not.
 *
 * The result is **sparse**: a row with nothing happening gets no entry, so the
 * feed hands it `undefined` and a memoised row sees no prop change while a
 * different row acts. Walking the four state sources rather than the rows on
 * screen is what guarantees that — walking the rows would mint eighty status
 * objects per tick and defeat the memoisation this exists to enable.
 */

import type { MiningProgress } from "../compose/pow";
import type { NoteActionControl, NoteRowStatus } from "./NoteActionRow";
import type { BookmarkActionState } from "./useBookmarks";
import type { NoteActionState } from "./useNoteActions";
import { slotOf } from "./useNoteActions";
import type { ZapState } from "./useZap";

export interface NoteRowStatusSources {
  /** Note ids whose share/copy is mid-flight. */
  readonly shareBusy: ReadonlySet<string>;
  readonly actions: ReadonlyMap<string, NoteActionState>;
  /** Locally raised confirmations, already expiring on their own timers. */
  readonly notices: ReadonlyMap<string, string>;
  readonly zaps: ReadonlyMap<string, ZapState>;
  /**
   * One state, not a map: the bookmark list is a single document, so a failed
   * toggle names the note it was about or every row would show the message.
   */
  readonly bookmark: BookmarkActionState;
  /**
   * Proof of work in flight, and how to abandon it.
   *
   * Attached to whichever row is *pending*, because a single publisher serves
   * every note action — so the mining that is happening belongs to the one row
   * already showing a spinner, and showing it on any other would be a lie.
   */
  readonly mining?: MiningProgress | undefined;
  readonly onSkipMining?: (() => void) | undefined;
}

export function noteRowStatuses(
  sources: NoteRowStatusSources,
): ReadonlyMap<string, NoteRowStatus> {
  const { shareBusy, actions, notices, zaps, bookmark, mining, onSkipMining } =
    sources;

  const ids = new Set<string>([
    ...shareBusy,
    ...actions.keys(),
    ...notices.keys(),
    ...zaps.keys(),
  ]);
  if (bookmark.status !== "idle") ids.add(bookmark.target);

  const statuses = new Map<string, NoteRowStatus>();
  for (const noteId of ids) {
    const action = actions.get(noteId);
    const zap = zaps.get(noteId);
    const listWrite =
      bookmark.status !== "idle" && bookmark.target === noteId
        ? bookmark
        : undefined;

    // Share first: it is the one control a read-only session can use, so its
    // spinner must not be shadowed by a stale state from something that refused.
    let pending: NoteActionControl | undefined;
    if (shareBusy.has(noteId)) pending = "share";
    else if (action?.status === "working") pending = slotOf(action.action);
    else if (listWrite?.status === "working") pending = "bookmark";
    else if (zap?.status === "working") pending = "zap";

    // A handed-off zap outranks a local notice: it carries an invoice somebody
    // has to pay, and "Link copied" replacing it would lose the only copy.
    let notice: string | undefined;
    if (zap?.status === "handed-off") {
      notice = zap.invoice ? `${zap.message} ${zap.invoice}` : zap.message;
    } else notice = notices.get(noteId);

    let error: string | undefined;
    if (action?.status === "error") error = action.message;
    else if (zap?.status === "error") error = zap.message;
    else if (listWrite?.status === "error") error = listWrite.message;

    if (pending === undefined && notice === undefined && error === undefined) {
      continue;
    }
    // Only the acting row: `pending` is what identifies it, and mining without a
    // pending control would be work attributed to a row that is not doing it.
    const rowMining = pending !== undefined ? mining : undefined;
    statuses.set(noteId, {
      ...(pending !== undefined ? { pending } : {}),
      ...(notice !== undefined ? { notice } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(rowMining !== undefined ? { mining: rowMining } : {}),
      ...(rowMining !== undefined && onSkipMining !== undefined
        ? { onSkipMining }
        : {}),
    });
  }
  return statuses;
}
