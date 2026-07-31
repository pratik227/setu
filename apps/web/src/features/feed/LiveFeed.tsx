import type { FeedDefinition, FeedEntry } from "@setu/core";
import { useEffect, useMemo, useRef } from "react";
import { useSession } from "../identity/SessionProvider";
import { muteFilterNotice } from "../moderation/muteEntries";
import { useMutedFeed } from "../moderation/useMutedFeed";
import type { NoteView } from "../notes/types";
import { useInteractions } from "../notes/useInteractions";
import { useNoteRowActions } from "../notes/useNoteRowActions";
import { useAuthors } from "../profiles/useAuthors";
import { FeedView } from "./FeedView";
import { noteEventsIn, noteIdsIn, pubkeysIn, toNoteViews } from "./toNoteViews";
import { useLiveFeed } from "./useLiveFeed";

/** How many rows from the top get author metadata and interaction counts. */
const METADATA_WINDOW = 40;

/** Quiet period that marks the initial load as finished. */
const SETTLE_MS = 1500;

/** Hard ceiling on running live, for a feed that never goes quiet. */
const MAX_LIVE_MS = 8000;

export interface LiveFeedProps {
  definition: FeedDefinition;
  /**
   * Row predicate applied after the feed engine produced its rows.
   *
   * Some feeds are not expressible as a NIP-01 filter — "replies only", "notes
   * carrying media" both depend on the event's structure, which relays do not
   * index. Filtering here rather than building a second feed keeps one
   * implementation of staging, `until` pagination and repost coalescing.
   *
   * Two consequences to hold: the predicate must be a **stable reference**, or
   * the metadata window recomputes every render; and a page whose rows are all
   * rejected renders empty while `hasMore` is still true, which is what keeps
   * the scroll sentinel paging until matches appear.
   */
  entryFilter?: (entry: FeedEntry) => boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
  /** Render without an own scroll container; the parent screen owns one. */
  embedded?: boolean;
  /** The parent's scroll container, so paging observes the right scroller. */
  scrollRoot?: HTMLElement | null;
}

/**
 * A feed wired to relays.
 *
 * Assembles three independent live queries — rows, author metadata, interaction
 * counts — and maps them to view models. They are separate on purpose: metadata
 * and counts arrive long after the notes do, and a reader should see the text
 * immediately rather than waiting on avatars.
 */
export function LiveFeed({
  definition,
  entryFilter,
  emptyTitle,
  emptyDescription,
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
  embedded,
  scrollRoot,
}: LiveFeedProps) {
  const { snapshot, flush, loadMore, pause } = useLiveFeed(definition);
  const { session } = useSession();

  // Rows newer than the moment this feed mounted are the ones worth animating.
  const mountedAt = useRef(Math.floor(Date.now() / 1000));

  /*
   * Stage arrivals behind the banner — but only once the initial load has
   * settled.
   *
   * The mechanism: `pause()` watermarks at the newest row it currently holds, and
   * anything newer than that watermark queues up instead of being inserted.
   * `flush()` merges the queue and re-watermarks without leaving staged mode,
   * which is exactly the "show N new posts" button.
   *
   * The timing is the part that was wrong, and visibly so. Arming on the first
   * snapshot that had *any* rows meant arming when three rows had arrived — so the
   * remaining thirty-odd events of the *same initial page* were newer than the
   * watermark and got counted as new. Every load, on every reload, announced
   * "41 new notes" that were not new; the reader had already asked for them by
   * opening the app.
   *
   * So: run live until arrivals go quiet (`SETTLE_MS` with no change in the row
   * count), then stage. The quiet-period timer is deliberately *trailing* — it
   * re-arms on every change, which is the opposite of the leading schedule used
   * for interest sets, and correct here because the thing being waited for is a
   * burst ending rather than a burst starting.
   *
   * A trailing timer alone would never fire on a feed that never goes quiet — the
   * global timeline arrives continuously — so `MAX_LIVE_MS` from mount is a hard
   * ceiling. Whichever comes first wins, and staging is armed exactly once.
   */
  const staging = useRef(false);
  const mountMs = useRef(Date.now());
  const rowCount = snapshot.entries.length;

  useEffect(() => {
    if (staging.current || rowCount === 0) return;
    const arm = () => {
      if (staging.current) return;
      staging.current = true;
      pause();
    };
    const settle = setTimeout(arm, SETTLE_MS);
    const ceiling = setTimeout(
      arm,
      Math.max(0, MAX_LIVE_MS - (Date.now() - mountMs.current)),
    );
    return () => {
      clearTimeout(settle);
      clearTimeout(ceiling);
    };
  }, [rowCount, pause]);

  const matching = useMemo(
    () =>
      entryFilter ? snapshot.entries.filter(entryFilter) : snapshot.entries,
    [snapshot.entries, entryFilter],
  );

  /*
   * Mutes are applied here, above the metadata window rather than in the row.
   *
   * Everything below this line charges for the rows it is given: the window takes
   * the first forty, and those forty are what the author interest set fetches
   * profiles for, what the interaction tracker asks every relay about, and what the
   * row action hook holds events for. A muted account that reached `FeedView` and
   * was hidden there would still have taken a metadata slot, a profile fetch and a
   * tracked note id from a row the reader can actually see.
   *
   * It is a separate pass from `entryFilter` on purpose, even though both drop rows:
   * the caller's predicate is a description of the feed ("replies only"), so rows it
   * rejects are not missing. Rows the *mute list* removed are missing, and the
   * reader has to be told how many — hence a count of its own rather than one number
   * covering both.
   */
  const muted = useMutedFeed(matching);
  const entries = muted.entries;

  // Resolve metadata and counts for the rows a reader can plausibly reach, not
  // for every row held. A viewport-driven window is the eventual fix; a fixed
  // head is the honest interim, and it keeps the interest sets bounded.
  const resolvable = useMemo(
    () => entries.slice(0, METADATA_WINDOW),
    [entries],
  );
  const pubkeys = useMemo(() => pubkeysIn(resolvable), [resolvable]);
  const noteIds = useMemo(() => noteIdsIn(resolvable), [resolvable]);

  const authors = useAuthors(pubkeys);
  // The viewer's pubkey is what makes `viewerReacted`/`viewerReposted` mean
  // anything: without it every heart renders inactive even for notes this account
  // already reacted to, and the row then offers "react" a second time.
  const interactions = useInteractions(noteIds, session?.pubkey);

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

  // Only the rows in the metadata window get handlers, for the same reason they
  // are the only ones getting counts: everything below is not reachable yet.
  const events = useMemo(() => noteEventsIn(resolvable), [resolvable]);
  const { actions, statuses } = useNoteRowActions(events);

  const mutedNotice = muteFilterNotice(muted);

  /*
   * An empty page whose rows were all muted has to say so.
   *
   * "No notes yet" over a feed that fetched forty notes and hid all forty is the
   * failure this whole notice exists to prevent — it reads as a broken relay set and
   * sends the reader to the settings screen to fix something that is working.
   */
  const emptyBecauseMuted = notes.length === 0 && muted.hiddenRows > 0;

  return (
    <FeedView
      notes={notes}
      actions={actions}
      statuses={statuses}
      loading={snapshot.loading && notes.length === 0}
      pendingCount={snapshot.pendingCount}
      onFlushPending={flush}
      onLoadMore={loadMore}
      hasMore={!snapshot.exhausted}
      {...(mutedNotice !== undefined ? { mutedNotice } : {})}
      emptyTitle={
        emptyBecauseMuted
          ? "Everything here is muted"
          : (emptyTitle ?? "No notes yet")
      }
      emptyDescription={
        emptyBecauseMuted
          ? `${muted.hiddenRows} ${
              muted.hiddenRows === 1 ? "note was" : "notes were"
            } hidden by your mute list. Nothing is wrong with your relays.`
          : (emptyDescription ??
            "Still reaching the relays. If this stays empty, check the relay list in settings.")
      }
      onOpenThread={onOpenThread}
      onOpenProfile={onOpenProfile}
      onOpenHashtag={onOpenHashtag}
      {...(embedded ? { embedded } : {})}
      {...(scrollRoot !== undefined ? { scrollRoot } : {})}
    />
  );
}
