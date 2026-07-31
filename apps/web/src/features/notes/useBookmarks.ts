/**
 * The viewer's bookmark list (NIP-51 kind 10003), read and written safely.
 *
 * The read half is unremarkable: subscribe, observe the store, project the `e`
 * tags. The write half is the dangerous one, and it is the same hazard as a follow
 * list — a kind-10003 is *replaceable*, so publishing one built from a stale or
 * partial fetch deletes every bookmark missing from our copy. So every toggle:
 *
 *  1. **re-fetches** the newest kind-10003 from the relays rather than trusting
 *     the copy already in the store;
 *  2. **requires every configured relay to be connected** before it will accept
 *     "you have no list" as true. A partial answer and a genuinely empty account
 *     look identical, and guessing wrong replaces a real list with one entry;
 *  3. **merges** into the fetched event, preserving `content` (the encrypted
 *     private bookmarks) and every non-`e` tag (bookmarked articles, hashtags and
 *     links) — see `bookmarkList.ts`;
 *  4. **re-checks plausibility** before publishing, and blocks a write that would
 *     lose more than the one bookmark being changed.
 *
 * The cost is that an unreachable relay blocks a *first* bookmark. That is the
 * correct trade: refusing is recoverable, publishing a truncated list is not.
 *
 * The read half is shared app-wide. This hook is called from `useNoteRowActions`,
 * which mounts once per surface, so a feed with a thread panel beside it used to
 * open two identical kind-10003 subscriptions and keep two independent copies of
 * the answer — the second of which is how one surface comes to disagree with
 * another about whether a note is bookmarked. The *write* half stays local: which
 * note a failed toggle was about is a fact about this surface, not about the list.
 */

import type { StoredEvent } from "@setu/core";
import { Kind, type NostrEvent } from "@setu/protocol";
import { useCallback, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { useSharedStoreQuery } from "../../engine/sharedStoreQuery";
import { usePublish } from "../compose/usePublish";
import { useSession } from "../identity/SessionProvider";
import {
  bookmarkedIds,
  editBookmarkList,
  isPlausibleBookmarkWrite,
} from "./bookmarkList";

export type BookmarkActionState =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly target: string }
  /**
   * `target` is the note the failed toggle was about. The list is one document,
   * so without it every row in the feed would show the same error message.
   */
  | {
      readonly status: "error";
      readonly target: string;
      readonly message: string;
    };

export interface BookmarksApi {
  /** Bookmarked note ids, newest list wins. Empty until the list arrives. */
  readonly ids: readonly string[];
  /** False while we have not yet seen a kind-10003 for this account. */
  readonly loaded: boolean;
  readonly state: BookmarkActionState;
  isBookmarked(noteId: string): boolean;
  /** Add or remove. Resolves true only when a relay accepted the write. */
  toggle(note: NostrEvent): Promise<boolean>;
  reset(): void;
}

/** How long to wait for relays to answer with the newest list. */
const FETCH_TIMEOUT_MS = 6000;

interface BookmarkSnapshot {
  readonly ids: readonly string[];
  readonly loaded: boolean;
}

const EMPTY: BookmarkSnapshot = { ids: [], loaded: false };

/** Newest kind-10003 -> bookmarked ids. Pure; the store orders the rows. */
function projectBookmarks(events: readonly StoredEvent[]): BookmarkSnapshot {
  // The store enforces replaceable last-write-wins, so row 0 is newest.
  const newest = events[0]?.event;
  if (!newest) return EMPTY;
  return { ids: bookmarkedIds(newest), loaded: true };
}

export function useBookmarks(): BookmarksApi {
  const engine = useEngine();
  const { session } = useSession();
  const { publish } = usePublish();
  const [state, setState] = useState<BookmarkActionState>({ status: "idle" });

  const pubkey = session?.pubkey;

  // Ask every configured relay. A replaceable list is the one place where missing
  // the newest copy has destructive consequences, so breadth beats economy — the
  // same reasoning as the follow list.
  const filter = useMemo(
    () =>
      pubkey
        ? {
            kinds: [Kind.Bookmarks],
            authors: [pubkey],
            limit: REPLACEABLE_LIST_LIMIT,
          }
        : undefined,
    [pubkey],
  );

  const { ids, loaded } = useSharedStoreQuery({
    key: pubkey ? `bookmarks:${pubkey}` : "",
    filter,
    project: projectBookmarks,
    initial: EMPTY,
  });

  const idSet = useMemo(() => new Set(ids), [ids]);
  const isBookmarked = useCallback(
    (noteId: string) => idSet.has(noteId),
    [idSet],
  );

  const toggle = useCallback(
    async (note: NostrEvent) => {
      if (!session?.canSign) {
        setState({
          status: "error",
          target: note.id,
          message:
            "This is a read-only session, so it cannot change your bookmarks.",
        });
        return false;
      }

      setState({ status: "working", target: note.id });

      const filter = {
        kinds: [Kind.Bookmarks],
        authors: [session.pubkey],
        limit: REPLACEABLE_LIST_LIMIT,
      };
      let fetched: readonly NostrEvent[] = [];
      try {
        fetched = await Promise.race([
          engine.subscriptions.fetch({
            filters: engine.relays.map((relay) => ({ relay, filter })),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out")), FETCH_TIMEOUT_MS),
          ),
        ]);
      } catch {
        setState({
          status: "error",
          target: note.id,
          message:
            "Could not reach the relays to read your current bookmarks. Nothing was changed.",
        });
        return false;
      }

      // Newest wins. The store enforces this for replaceable kinds too, but the
      // decision is explicit here because it is load-bearing.
      const current = [...fetched]
        .filter((event) => event.kind === Kind.Bookmarks)
        .sort((a, b) => b.created_at - a.created_at)[0];

      const health = engine.pool.health();
      const connected = health.filter((r) => r.status === "connected").length;
      const absenceConfirmed =
        engine.relays.length > 0 && connected === engine.relays.length;

      const stored = await engine.store.get(note.id).catch(() => undefined);
      const relayHint = stored?.provenance.relays[0];

      const alreadyBookmarked = (current?.tags ?? []).some(
        (tag) => tag[0] === "e" && tag[1] === note.id,
      );

      const edit = editBookmarkList({
        current,
        absenceConfirmed,
        target: note.id,
        action: alreadyBookmarked ? "remove" : "add",
        ...(relayHint ? { relayHint } : {}),
      });

      if (!edit.ok) {
        if (edit.reason === "no-change") {
          // Our view of the list was out of date; the network already agrees.
          setState({ status: "idle" });
          return true;
        }
        const unreachable = health
          .filter((r) => r.status !== "connected")
          .map((r) => r.url);
        setState({
          status: "error",
          target: note.id,
          message:
            "No bookmark list was found, and not every relay answered, so Setu " +
            "cannot tell whether you have one. Publishing now could erase it. " +
            (unreachable.length > 0
              ? `Unreachable: ${unreachable.join(", ")}.`
              : ""),
        });
        return false;
      }

      if (!isPlausibleBookmarkWrite(current, edit.template)) {
        setState({
          status: "error",
          target: note.id,
          message:
            "That edit would change far more than one bookmark, so it was blocked. " +
            "This is a bug, not something you did.",
        });
        return false;
      }

      try {
        const outcome = await publish(edit.template);
        if (!outcome.accepted) {
          setState({
            status: "error",
            target: note.id,
            message:
              outcome.results.find((r) => r.message)?.message ??
              "No relay accepted the updated bookmark list.",
          });
          return false;
        }
        // The list itself comes back through the store observer above, so there
        // is nothing to set here beyond clearing the in-flight state.
        setState({ status: "idle" });
        return true;
      } catch (cause) {
        setState({
          status: "error",
          target: note.id,
          message:
            cause instanceof Error ? cause.message : "Signing was declined.",
        });
        return false;
      }
    },
    [engine, publish, session],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { ids, loaded, state, isBookmarked, toggle, reset };
}
