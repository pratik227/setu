/**
 * What a note row can act through, assembled from the four action hooks.
 *
 * The rows themselves take view models, not events — that is what keeps rendering
 * free of store access. But every write needs the actual event: a reaction tags
 * the target's id, pubkey *and* kind, and a reply's thread position is read off
 * the parent's own `e` tags. So the surface that owns the events (a feed, a
 * thread) hands them in here as a map, and the row keeps passing ids.
 *
 * This is also the single place where the four independent hooks' states are
 * merged into one answer per row, which is what lets the row show exactly one
 * spinner and one message without knowing that reactions, bookmarks and zaps are
 * three different subsystems.
 *
 * ## Two returns, not one
 *
 * The capabilities and the transient state are handed back separately because
 * they change on completely different clocks, and merging them cost the feed its
 * row memoisation entirely. Measured on a live timeline: with `pendingFor`,
 * `noticeFor` and `errorFor` on the same object, that object had a new identity on
 * every single render — 1558 `actions` prop changes across 1558 row renders — so
 * every row on screen re-rendered on every tick whether or not the memo was there.
 *
 * `actions` is now reference-stable for the life of a surface, and `statuses` is
 * sparse: only the rows with something in flight appear in it, so a spinner on one
 * row leaves the other eighty rows' props untouched.
 *
 * ## Why mute and report are rendered, not fired
 *
 * The two moderation actions hand back a *dialog* rather than performing a write, and
 * that is what keeps them out of `statuses` entirely: their in-flight and failure
 * state lives in the dialog that owns the edit, so adding them cost this object
 * nothing. Both also need a confirmation step for reasons that are about honesty
 * rather than caution — a mute is not a block, and a report moderates nothing — and
 * that copy belongs next to the button, not in a toast.
 */

import type { NostrEvent } from "@setu/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { Composer } from "../compose/Composer";
import { useSession } from "../identity/SessionProvider";
import { MuteDialog } from "../moderation/MuteDialog";
import { ReportDialog } from "../moderation/ReportDialog";
import { useMuteRules } from "../moderation/useMuteList";
import type { NoteRowActions, NoteRowStatus } from "./NoteActionRow";
import { copyMessage, copyText, noteReference } from "./noteLink";
import { noteRowStatuses } from "./noteRowStatus";
import { useBookmarks } from "./useBookmarks";
import { useNoteActions } from "./useNoteActions";
import { useZap } from "./useZap";

/** How long a "Link copied" style confirmation stays on screen. */
const NOTICE_MS = 4000;

export interface NoteRowActionsApi {
  /** Stable for the life of the surface, so a memoised row can skip on it. */
  readonly actions: NoteRowActions;
  /**
   * Keyed by note id, and holding only the rows that have something to report.
   * A row missing from the map has nothing in flight.
   */
  readonly statuses: ReadonlyMap<string, NoteRowStatus>;
}

export function useNoteRowActions(
  events: ReadonlyMap<string, NostrEvent>,
): NoteRowActionsApi {
  /*
   * The events map is read through a ref, not closed over.
   *
   * Callers rebuild it whenever the feed changes — which is on every arriving
   * reaction — so closing over it made every callback, and therefore this whole
   * object, a new identity on each tick. Rows are memoised on their props, so a
   * churning `actions` object defeated the memoisation entirely: measured at 462
   * row renders where 462 was also the un-memoised number.
   *
   * A ref keeps the lookups current while the returned API stays stable.
   */
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const engine = useEngine();
  const { session } = useSession();
  const noteActions = useNoteActions();
  const bookmarks = useBookmarks();
  const zapping = useZap();
  /*
   * Read half only. `rules` holds one identity for as long as the list is
   * unchanged (see the projection memo in `useMuteList`), which is what lets
   * `isAuthorMuted` — and therefore the whole `actions` object — keep its identity
   * while the store re-emits the mute list on every tick. Muting someone does give
   * `actions` a new identity and re-render the rows once, which is correct: the
   * menu's wording and the feed's contents both change.
   */
  const { rules: muteRules } = useMuteRules();

  /*
   * Depended on member by member, never on the hook objects.
   *
   * All three hooks return a fresh object literal every render while the
   * callbacks inside it are memoised. Listing `noteActions` as a dependency
   * therefore rebuilt `react`, `repost` and `deleteNote` on every render for no
   * reason at all — which is most of why the assembled object never held an
   * identity, and so why the feed's rows could not be memoised.
   */
  const {
    react: publishReaction,
    unreact,
    repost: publishRepost,
    unrepost,
    deleteNote: publishDeletion,
    states: actionStates,
  } = noteActions;
  const {
    toggle: toggleBookmark,
    isBookmarked,
    state: bookmarkState,
  } = bookmarks;
  const { zap: startZap, states: zapStates } = zapping;

  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [shareBusy, setShareBusy] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const notice = useCallback((noteId: string, message: string) => {
    setNotices((previous) => new Map(previous).set(noteId, message));
    const existing = timers.current.get(noteId);
    if (existing) clearTimeout(existing);
    timers.current.set(
      noteId,
      setTimeout(() => {
        timers.current.delete(noteId);
        setNotices((previous) => {
          const next = new Map(previous);
          next.delete(noteId);
          return next;
        });
      }, NOTICE_MS),
    );
  }, []);

  // A pending timer that fires after unmount is a setState on a dead component.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const canSign = Boolean(session?.canSign);

  const react = useCallback(
    (noteId: string, active: boolean) => {
      const event = eventsRef.current.get(noteId);
      if (!event) return;
      void (active ? unreact(event) : publishReaction(event));
    },
    [publishReaction, unreact],
  );

  const repost = useCallback(
    (noteId: string, active: boolean) => {
      const event = eventsRef.current.get(noteId);
      if (!event) return;
      void (active ? unrepost(event) : publishRepost(event));
    },
    [publishRepost, unrepost],
  );

  const bookmark = useCallback(
    (noteId: string) => {
      const event = eventsRef.current.get(noteId);
      if (!event) return;
      void toggleBookmark(event);
    },
    [toggleBookmark],
  );

  const zap = useCallback(
    (noteId: string) => {
      const event = eventsRef.current.get(noteId);
      if (!event) return;
      void startZap(event);
    },
    [startZap],
  );

  const share = useCallback(
    (noteId: string) => {
      const event = eventsRef.current.get(noteId);
      if (!event) return;
      setShareBusy((previous) => new Set(previous).add(noteId));
      void (async () => {
        try {
          // A relay we have actually seen the note on, so the reference resolves
          // for someone whose relay set does not overlap ours.
          const stored = await engine.store.get(noteId).catch(() => undefined);
          const relayHint =
            stored?.provenance.relays[0] ?? engine.relays[0] ?? undefined;
          const reference = noteReference({
            id: noteId,
            author: event.pubkey,
            kind: event.kind,
            ...(relayHint ? { relayHint } : {}),
          });
          if (!reference) {
            notice(noteId, "This note's id could not be encoded as a link.");
            return;
          }
          const result = await copyText(reference);
          notice(
            noteId,
            result.ok
              ? copyMessage(result)
              : `${copyMessage(result)} ${result.text}`,
          );
        } finally {
          setShareBusy((previous) => {
            const next = new Set(previous);
            next.delete(noteId);
            return next;
          });
        }
      })();
    },
    [engine, notice],
  );

  /*
   * Rebuilt only when one of the four states actually moves, which is only ever a
   * user action — so the sparse map, and therefore every idle row's `undefined`,
   * survives the store re-emitting its whole matching set on every arriving event.
   */
  const statuses = useMemo(
    () =>
      noteRowStatuses({
        shareBusy,
        actions: actionStates,
        notices,
        zaps: zapStates,
        bookmark: bookmarkState,
      }),
    [actionStates, bookmarkState, notices, shareBusy, zapStates],
  );

  const renderReplyComposer = useCallback(
    (noteId: string, close: () => void, authorName?: string) => {
      const parent = eventsRef.current.get(noteId);
      if (!parent) return null;
      return (
        <Composer
          autoFocus
          reply={{ parent, ...(authorName ? { authorName } : {}) }}
          // The card already draws the row separator; a second one under the
          // composer reads as the end of a note that has not ended.
          className="border-b-0"
          onCancel={close}
          // Collapse only on acceptance. `Composer` keeps the text when every
          // relay rejected it, and closing the box would discard it.
          onPosted={close}
        />
      );
    },
    [],
  );

  const canDelete = useCallback(
    (noteId: string) => {
      if (!canSign || !session) return false;
      const event = eventsRef.current.get(noteId);
      return event !== undefined && event.pubkey === session.pubkey;
    },
    [canSign, session],
  );

  const deleteNote = useCallback(
    (noteId: string) => {
      const event = eventsRef.current.get(noteId);
      if (!event) return;
      void publishDeletion(event);
    },
    [publishDeletion],
  );

  const isAuthorMuted = useCallback(
    (noteId: string) => {
      const event = eventsRef.current.get(noteId);
      return event !== undefined && muteRules.pubkeys.has(event.pubkey);
    },
    [muteRules],
  );

  const renderMuteDialog = useCallback(
    (noteId: string, close: () => void, authorName?: string) => {
      const event = eventsRef.current.get(noteId);
      if (!event) return null;
      return (
        <MuteDialog
          target={{ kind: "pubkey", value: event.pubkey }}
          name={authorName ?? "this account"}
          onClose={close}
        />
      );
    },
    [],
  );

  const renderReportDialog = useCallback(
    (noteId: string, close: () => void, authorName?: string) => {
      const event = eventsRef.current.get(noteId);
      if (!event) return null;
      return (
        <ReportDialog
          pubkey={event.pubkey}
          noteId={event.id}
          name={authorName ?? "this account"}
          onClose={close}
        />
      );
    },
    [],
  );

  const actions = useMemo(
    () => ({
      canSign,
      react,
      repost,
      bookmark,
      zap,
      share,
      canDelete,
      deleteNote,
      isBookmarked,
      isAuthorMuted,
      renderReplyComposer,
      renderMuteDialog,
      renderReportDialog,
    }),
    [
      bookmark,
      canDelete,
      canSign,
      deleteNote,
      isAuthorMuted,
      isBookmarked,
      react,
      renderMuteDialog,
      renderReplyComposer,
      renderReportDialog,
      repost,
      share,
      zap,
    ],
  );

  return useMemo(() => ({ actions, statuses }), [actions, statuses]);
}
