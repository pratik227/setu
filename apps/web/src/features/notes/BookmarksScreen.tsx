import type { FeedEntry } from "@setu/core";
import type { Filter, NostrEvent } from "@setu/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { idLookupLimit } from "../../engine/queryLimits";
import { useSharedSubscription } from "../../engine/sharedSubscription";
import { useStoreEvents } from "../discover/useStoreEvents";
import { FeedView } from "../feed/FeedView";
import { noteIdsIn, pubkeysIn, toNoteViews } from "../feed/toNoteViews";
import { useSession } from "../identity/SessionProvider";
import type { NoteView } from "../notes/types";
import { useAuthors } from "../profiles/useAuthors";
import { NOTE_TARGET_KINDS } from "./noteKinds";
import { useBookmarks } from "./useBookmarks";
import { useInteractions } from "./useInteractions";
import { useNoteRowActions } from "./useNoteRowActions";

/**
 * Bookmarks — the notes on the account's kind-10003 list.
 *
 * The sidebar has offered this destination since the bookmark action shipped, and
 * until now it dead-ended on "not built yet" while every note row happily added
 * and removed bookmarks. The data was always there; only the screen was missing.
 *
 * Two things worth stating about how it reads:
 *
 * **Order is the list's order, not the notes' order.** A bookmark list is a
 * sequence the reader built, and the newest bookmark is the one they most likely
 * want. Re-sorting by `created_at` would scatter a note saved this morning back
 * into last year, which is the opposite of what saving it was for. So the kind-
 * 10003 order is preserved verbatim.
 *
 * **A bookmarked id we cannot fetch is not an empty row.** Bookmarks outlive the
 * relays that carried them: a note saved a year ago may exist on no relay this
 * client reads. Those ids are counted and stated rather than rendered as blanks,
 * because a bookmark list that silently shrinks looks like data loss.
 */

/** How many rows get author metadata and interaction counts. */
const METADATA_WINDOW = 40;

/**
 * How long to keep skeletoning before calling the list absent.
 *
 * `useBookmarks().loaded` flips when a kind-10003 arrives, and for an account
 * that has never bookmarked anything it never arrives — so a screen gated on
 * `loaded` alone skeletons forever. That is the worst of the three states to
 * show, because it says "still working" about something that has finished.
 *
 * So this screen holds three states apart, the same distinction `useFollows`
 * documents for follow lists: we have a list (render it, empty or not), we asked
 * and nothing came back (say so), and we are still waiting (skeleton).
 */
const ABSENT_AFTER_MS = 8000;

export interface BookmarksScreenProps {
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}

export function BookmarksScreen({
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
}: BookmarksScreenProps) {
  const { session } = useSession();
  const { ids, loaded } = useBookmarks();
  const mountedAt = useRef(Math.floor(Date.now() / 1000));

  // Waited long enough that "no list" is the answer rather than a delay.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), ABSENT_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  // Ids are unique, so n ids match at most n events — the limit is exact rather
  // than a guess, and the kinds are named so the relay plans a narrow query.
  const filter = useMemo(
    () =>
      ids.length > 0
        ? {
            kinds: [...NOTE_TARGET_KINDS],
            ids: [...ids],
            limit: idLookupLimit(ids.length),
          }
        : undefined,
    [ids],
  );

  useSharedSubscription(filter);
  const events = useStoreEvents(filter ?? MATCHES_NOTHING);

  const held = useMemo(() => {
    const map = new Map<string, NostrEvent>();
    for (const { event } of events) map.set(event.id, event);
    return map;
  }, [events]);

  // Walk the bookmark list, not the event list: the list defines the order, and
  // an id we hold no event for is skipped here and counted below.
  const entries = useMemo<readonly FeedEntry[]>(() => {
    const out: FeedEntry[] = [];
    for (const id of ids) {
      const event = held.get(id);
      if (!event) continue;
      out.push({
        key: `note:${event.id}`,
        kind: "note",
        event,
        createdAt: event.created_at,
        reposters: [],
        repostIds: [],
      });
    }
    return out;
  }, [ids, held]);

  const unresolved = ids.length - entries.length;

  const resolvable = useMemo(
    () => entries.slice(0, METADATA_WINDOW),
    [entries],
  );
  const pubkeys = useMemo(() => pubkeysIn(resolvable), [resolvable]);
  const noteIds = useMemo(() => noteIdsIn(resolvable), [resolvable]);
  const authors = useAuthors(pubkeys);
  const interactions = useInteractions(noteIds, session?.pubkey);
  const { actions, statuses } = useNoteRowActions(held);

  /*
   * The previous result feeds back in so unchanged rows keep their identity.
   * A ref rather than state: it must not itself trigger a render, and it is read
   * during the memo that produces the next value.
   */
  const previous = useRef<readonly NoteView[]>([]);
  const notes = useMemo(() => {
    const next = toNoteViews(
      entries,
      authors,
      interactions,
      mountedAt.current,
      previous.current,
    );
    previous.current = next;
    return next;
  }, [entries, authors, interactions]);

  if (!session) {
    return (
      <FeedView
        notes={[]}
        emptyTitle="Sign in to see your bookmarks"
        emptyDescription="A bookmark list is stored on relays under your public key, so there is nothing to fetch until this client knows which key that is."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Never silent about the gap between what is saved and what is shown. */}
      {unresolved > 0 ? (
        <p className="setu-feed-column border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
          {unresolved} bookmarked {unresolved === 1 ? "note has" : "notes have"}{" "}
          not been found on the relays this client reads.
        </p>
      ) : null}

      <FeedView
        notes={notes}
        actions={actions}
        statuses={statuses}
        // Skeleton while a list is genuinely expected: either we have not seen
        // one yet and have not waited long enough to give up, or we have ids
        // whose notes are still being fetched.
        loading={
          (!loaded && !waited) || (ids.length > 0 && entries.length === 0)
        }
        onOpenThread={onOpenThread}
        onOpenProfile={onOpenProfile}
        onOpenHashtag={onOpenHashtag}
        emptyTitle={
          loaded
            ? "No bookmarks yet"
            : waited
              ? "No bookmark list found"
              : "Loading your bookmark list"
        }
        emptyDescription={
          loaded
            ? "Save a note with the bookmark button and it will appear here."
            : waited
              ? "The relays this client reads returned no bookmark list for this account. Saving a note will create one."
              : "Fetching your list from the relays."
        }
      />
    </div>
  );
}

/**
 * A filter that matches nothing, for the signed-out and empty-list cases.
 *
 * An empty `ids` array rather than an omitted one: `{}` is the broadest filter
 * there is, so "nothing to look up" must be spelled out or it becomes "give me
 * everything".
 */
const MATCHES_NOTHING: Filter = { ids: [], kinds: [], limit: 1 };
