/**
 * One object a note row can act through, assembled from the four action hooks.
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
 */

import type { NostrEvent } from "@setu/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { Composer } from "../compose/Composer";
import { useSession } from "../identity/SessionProvider";
import type { NoteActionControl, NoteRowActions } from "./NoteActionRow";
import { copyMessage, copyText, noteReference } from "./noteLink";
import { useBookmarks } from "./useBookmarks";
import { slotOf, useNoteActions } from "./useNoteActions";
import { useZap } from "./useZap";

/** How long a "Link copied" style confirmation stays on screen. */
const NOTICE_MS = 4000;

export function useNoteRowActions(
  events: ReadonlyMap<string, NostrEvent>,
): NoteRowActions {
  const engine = useEngine();
  const { session } = useSession();
  const noteActions = useNoteActions();
  const bookmarks = useBookmarks();
  const zapping = useZap();

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
      const event = events.get(noteId);
      if (!event) return;
      void (active ? noteActions.unreact(event) : noteActions.react(event));
    },
    [events, noteActions],
  );

  const repost = useCallback(
    (noteId: string, active: boolean) => {
      const event = events.get(noteId);
      if (!event) return;
      void (active ? noteActions.unrepost(event) : noteActions.repost(event));
    },
    [events, noteActions],
  );

  const bookmark = useCallback(
    (noteId: string) => {
      const event = events.get(noteId);
      if (!event) return;
      void bookmarks.toggle(event);
    },
    [bookmarks, events],
  );

  const zap = useCallback(
    (noteId: string) => {
      const event = events.get(noteId);
      if (!event) return;
      void zapping.zap(event);
    },
    [events, zapping],
  );

  const share = useCallback(
    (noteId: string) => {
      const event = events.get(noteId);
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
    [engine, events, notice],
  );

  const pendingFor = useCallback(
    (noteId: string): NoteActionControl | undefined => {
      if (shareBusy.has(noteId)) return "share";
      const action = noteActions.states.get(noteId);
      if (action?.status === "working") return slotOf(action.action);
      if (
        bookmarks.state.status === "working" &&
        bookmarks.state.target === noteId
      ) {
        return "bookmark";
      }
      if (zapping.states.get(noteId)?.status === "working") return "zap";
      return undefined;
    },
    [bookmarks.state, noteActions.states, shareBusy, zapping.states],
  );

  const noticeFor = useCallback(
    (noteId: string) => {
      const zapState = zapping.states.get(noteId);
      if (zapState?.status === "handed-off") {
        return zapState.invoice
          ? `${zapState.message} ${zapState.invoice}`
          : zapState.message;
      }
      return notices.get(noteId);
    },
    [notices, zapping.states],
  );

  const errorFor = useCallback(
    (noteId: string) => {
      const action = noteActions.states.get(noteId);
      if (action?.status === "error") return action.message;
      const zapState = zapping.states.get(noteId);
      if (zapState?.status === "error") return zapState.message;
      // The bookmark list is one document, so a failure carries the id of the
      // note that asked for it — otherwise every row would show the message.
      if (
        bookmarks.state.status === "error" &&
        bookmarks.state.target === noteId
      ) {
        return bookmarks.state.message;
      }
      return undefined;
    },
    [bookmarks.state, noteActions.states, zapping.states],
  );

  const renderReplyComposer = useCallback(
    (noteId: string, close: () => void, authorName?: string) => {
      const parent = events.get(noteId);
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
    [events],
  );

  const canDelete = useCallback(
    (noteId: string) => {
      if (!canSign || !session) return false;
      const event = events.get(noteId);
      return event !== undefined && event.pubkey === session.pubkey;
    },
    [canSign, events, session],
  );

  const deleteNote = useCallback(
    (noteId: string) => {
      const event = events.get(noteId);
      if (!event) return;
      void noteActions.deleteNote(event);
    },
    [events, noteActions],
  );

  return useMemo(
    () => ({
      canSign,
      react,
      repost,
      bookmark,
      zap,
      share,
      canDelete,
      deleteNote,
      isBookmarked: bookmarks.isBookmarked,
      pendingFor,
      noticeFor,
      errorFor,
      renderReplyComposer,
    }),
    [
      bookmark,
      bookmarks.isBookmarked,
      canDelete,
      canSign,
      deleteNote,
      errorFor,
      noticeFor,
      pendingFor,
      react,
      renderReplyComposer,
      repost,
      share,
      zap,
    ],
  );
}
