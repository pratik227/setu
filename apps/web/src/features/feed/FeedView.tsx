import { Button, cn, EmptyState, ScrollArea, Skeleton } from "@setu/ui";
import { ArrowUp, Inbox } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { NoteRowActions, NoteRowStatus } from "../notes/NoteActionRow";
import { NoteCard } from "../notes/NoteCard";
import { useRenderedContent } from "../notes/NoteContent";
import type { NoteView } from "../notes/types";
import { type ProvenanceMap, useProvenance } from "../notes/useProvenance";

/**
 * One feed row, memoised — and this time the memo skips something.
 *
 * It is its own component because `useRenderedContent` is a hook: tokenization is
 * per-note and cannot run inside a `.map`. Re-parsing that content is also the
 * expensive part of a row, which is what makes a comparison per row worth paying.
 *
 * Four things have to hold before the memo skips anything, and an earlier attempt
 * shipped with only the first, measured no improvement, and was reverted:
 *
 *  1. `toNoteViews` reuses the previous view object for an unchanged row, so `note`
 *     stays reference-equal across a tick that changed some other row.
 *  2. `useNoteRowActions` hands back capabilities separately from transient state,
 *     so `actions` holds one identity for the life of the surface. It used to carry
 *     `pendingFor`/`noticeFor`/`errorFor`, which closed over live state and gave
 *     the whole object a new identity on every render — measured at 1558 `actions`
 *     prop changes across 1558 renders.
 *  3. A row's `status` is `undefined` unless that row itself has something in
 *     flight, because the map behind it is sparse — so it is the same `undefined`
 *     every render and React's default shallow comparison is enough. No custom
 *     comparator: one would have to compare `status` field by field, which is a
 *     correctness burden forever in exchange for nothing measurable.
 *  4. `useStableProvenance` below, for the last prop that was still churning.
 *
 * Measured on a live timeline, 25s windows, dev build — so StrictMode doubles every
 * count, equally on both sides. Without the memo: 7372 row renders against a
 * ceiling of 94 feed re-renders x 79 rows = 7426, which is every row every time.
 * With it: 112 renders against a 4756 ceiling. Clicking one row's share button
 * costs 1 row render rather than the 82 it used to.
 */
const NoteRow = memo(function NoteRow({
  note,
  provenanceRelays,
  actions,
  status,
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
}: {
  note: NoteView;
  provenanceRelays?: readonly string[];
  actions?: NoteRowActions;
  /**
   * This row's own in-flight/notice/error state.
   *
   * Always passed, `undefined` included, so the prop set has a constant shape —
   * a key appearing and disappearing is a props change to the shallow comparison
   * even when nothing about the row differs.
   */
  status: NoteRowStatus | undefined;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}) {
  const { body, media } = useRenderedContent({
    content: note.content,
    onOpenHashtag,
  });

  // Media parsed out of the content stands in for imeta tags until the store
  // supplies them; explicit media on the view model always wins.
  const withMedia = note.media ? note : { ...note, media };

  return (
    <NoteCard
      note={withMedia}
      {...(provenanceRelays ? { provenanceRelays } : {})}
      body={body}
      onOpenThread={onOpenThread}
      onOpenProfile={onOpenProfile}
      {...(actions ? { actions } : {})}
      {...(status ? { status } : {})}
    />
  );
});

/**
 * The same provenance map, with each row's relay list held at its old identity
 * when the relays have not changed.
 *
 * `useProvenance` re-reads the store on every write touching the rows on screen,
 * and hands back a fresh array per row each time — measured at 292 provenance prop
 * changes over a live window, 237 of them identical in content. Each one was a
 * memoised row re-rendering, and re-tokenizing its content, because an array of
 * the same two relay URLs had been rebuilt.
 */
function useStableProvenance(provenance: ProvenanceMap): ProvenanceMap {
  const held = useRef<ProvenanceMap>(new Map());
  return useMemo(() => {
    const next = new Map<string, readonly string[]>();
    for (const [noteId, relays] of provenance) {
      const earlier = held.current.get(noteId);
      next.set(
        noteId,
        earlier !== undefined && sameRelays(earlier, relays) ? earlier : relays,
      );
    }
    held.current = next;
    return next;
  }, [provenance]);
}

function sameRelays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((relay, i) => relay === b[i]);
}

function NoteSkeleton() {
  return (
    <div className="flex gap-3 border-b border-border/50 px-4 py-3">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
      </div>
    </div>
  );
}

export interface FeedViewProps {
  notes: readonly NoteView[];
  /**
   * Reply/react/repost/zap/bookmark/share wiring for every row.
   *
   * One object rather than a handler per action, so adding one later is a change
   * to the hook that produces it and to the row that consumes it — not to every
   * layer in between. Absent means the rows render counts without controls.
   */
  actions?: NoteRowActions;
  /**
   * Per-row in-flight/notice/error state, keyed by note id and sparse — a row
   * absent from it has nothing to report.
   *
   * Separate from `actions` so that object can stay reference-stable: a shared
   * object that also answered "which row is spinning" changed identity whenever
   * any row acted, and that alone re-rendered every row on screen.
   */
  statuses?: ReadonlyMap<string, NoteRowStatus>;
  loading?: boolean;
  /**
   * Count of newer notes held back while the reader is scrolled away from the
   * top. Prepending them immediately would move the row out from under the
   * pointer mid-read.
   */
  pendingCount?: number;
  onFlushPending?(): void;
  onLoadMore?(): void;
  hasMore?: boolean;
  /**
   * What the reader's mute list removed from this page, already worded.
   *
   * Rendered, not computed here: a feed that silently drops rows is
   * indistinguishable from a feed that failed to load them, and the reader has no
   * way to tell which one they are looking at. Absent means nothing was removed —
   * never "nothing worth mentioning".
   */
  mutedNotice?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
  /** Fired when the reader leaves the top, so newer rows can be staged. */
  /** Fired on return to the top, so staged rows can flow in again. */
  /**
   * Render the rows without their own scroll container, for a screen that owns
   * one already.
   *
   * A profile is the case that forces this: with the header fixed above its own
   * scroller, the feed's viewport is whatever the header leaves — which on a
   * profile with a banner and a bio is a few hundred pixels of timeline under a
   * wall of chrome. Letting the page scroll as one document instead means the
   * header can scroll away and the tabs can stick, which is what makes the
   * timeline usable. The parent must pass `scrollRoot` so paging still observes
   * the right scroller.
   */
  embedded?: boolean;
  /** The scroll container to observe when `embedded`. */
  scrollRoot?: HTMLElement | null;
}

export function FeedView({
  notes,
  actions,
  statuses,
  loading = false,
  pendingCount = 0,
  onFlushPending,
  onLoadMore,
  hasMore = false,
  mutedNotice,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
  embedded = false,
  scrollRoot,
}: FeedViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Infinite scroll-back. `until`-based paging lives in the feed engine; this
  // only reports that the reader reached the end.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !onLoadMore || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore();
      },
      {
        // When embedded, the scroller belongs to the parent screen; observing
        // our own (non-scrolling) box would make the sentinel permanently
        // visible and page forever.
        root: embedded ? (scrollRoot ?? null) : scrollRef.current,
        rootMargin: "600px",
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, embedded, scrollRoot]);

  // Provenance is a local read over exactly the notes on screen.
  const provenance = useStableProvenance(
    useProvenance(useMemo(() => notes.map((note) => note.id), [notes])),
  );

  // Shown at the top too, not only after scrolling away.
  //
  // The old rule also required the reader to have scrolled away from the top, and
  // paired with a feed that only paused at that moment: sitting at the top,
  // arrivals were injected live. On a busy feed that means the row under the cursor changes
  // between deciding to click it and clicking it, and the reader never gets a
  // stable page to read. Staging unconditionally and letting a counted banner be
  // the only way rows enter is the pattern every large timeline settled on, and it
  // is also cheaper: one insertion of thirty rows rather than thirty reflows.
  const showChip = pendingCount > 0;

  const flush = useCallback(() => {
    onFlushPending?.();
    const scroller = embedded ? scrollRoot : scrollRef.current;
    scroller?.scrollTo({ top: 0, behavior: "smooth" });
  }, [onFlushPending, embedded, scrollRoot]);

  /*
   * In flow and sticky, not floating over the timeline.
   *
   * It used to be absolutely positioned, which was fine while it only appeared
   * after the reader had scrolled down — it hovered over the middle of a note
   * nobody was reading. Now that it is shown at the top as well it would sit
   * directly on the first row's byline. Sticky inside the scroller keeps it
   * reachable at any scroll position without ever covering a row.
   */
  const banner = showChip ? (
    <div className="sticky top-0 z-20 flex justify-center bg-background/80 py-2 backdrop-blur-sm">
      <Button size="sm" onClick={flush} className="motion-enter-chip shadow-md">
        <ArrowUp />
        {pendingCount} new {pendingCount === 1 ? "note" : "notes"}
      </Button>
    </div>
  ) : null;

  // In flow rather than sticky, and above the rows: it is a fact about the page the
  // reader is looking at, not a control, so it scrolls away with the page it
  // describes.
  const filtered =
    mutedNotice === undefined ? null : (
      <p className="border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
        {mutedNotice}
      </p>
    );

  const rows = (
    <FeedRows
      provenance={provenance}
      notes={notes}
      loading={loading}
      emptyTitle={emptyTitle}
      {...(emptyDescription !== undefined ? { emptyDescription } : {})}
      {...(actions ? { actions } : {})}
      {...(statuses ? { statuses } : {})}
      onOpenThread={onOpenThread}
      onOpenProfile={onOpenProfile}
      onOpenHashtag={onOpenHashtag}
      sentinelRef={sentinelRef}
    />
  );

  return (
    <div
      className={cn(
        "relative flex flex-col",
        // Embedded, the parent owns the height; standalone, we fill the pane.
        embedded ? "" : "min-h-0 flex-1",
      )}
    >
      {embedded ? (
        <div className="setu-feed-column">
          {banner}
          {filtered}
          {rows}
        </div>
      ) : (
        <ScrollArea ref={scrollRef} className="setu-feed-column">
          {banner}
          {filtered}
          {rows}
        </ScrollArea>
      )}
    </div>
  );
}

/** Extracted so embedded and standalone modes cannot drift apart. */
function FeedRows({
  notes,
  loading,
  emptyTitle,
  emptyDescription,
  actions,
  statuses,
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
  sentinelRef,
  provenance,
}: Pick<
  FeedViewProps,
  | "notes"
  | "loading"
  | "emptyTitle"
  | "emptyDescription"
  | "actions"
  | "statuses"
  | "onOpenThread"
  | "onOpenProfile"
  | "onOpenHashtag"
> & {
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  provenance: ReadonlyMap<string, readonly string[]>;
}) {
  return (
    <>
      {notes.length === 0 && !loading ? (
        <EmptyState
          icon={<Inbox className="size-6" />}
          title={emptyTitle ?? "Nothing here yet"}
          {...(emptyDescription !== undefined
            ? { description: emptyDescription }
            : {})}
        />
      ) : (
        <>
          {notes.map((note) => (
            <NoteRow
              key={note.rowKey}
              note={note}
              {...(provenance.get(note.id)
                ? { provenanceRelays: provenance.get(note.id) }
                : {})}
              {...(actions ? { actions } : {})}
              status={statuses?.get(note.id)}
              onOpenThread={onOpenThread}
              onOpenProfile={onOpenProfile}
              onOpenHashtag={onOpenHashtag}
            />
          ))}
          {loading ? (
            <>
              <NoteSkeleton />
              <NoteSkeleton />
              <NoteSkeleton />
            </>
          ) : null}
          <div ref={sentinelRef} aria-hidden className="h-px" />
        </>
      )}
    </>
  );
}
