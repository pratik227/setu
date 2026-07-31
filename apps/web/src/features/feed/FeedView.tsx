import { Button, cn, EmptyState, ScrollArea, Skeleton } from "@setu/ui";
import { ArrowUp, Inbox } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { NoteRowActions } from "../notes/NoteActionRow";
import { NoteCard } from "../notes/NoteCard";
import { useRenderedContent } from "../notes/NoteContent";
import type { NoteView } from "../notes/types";
import { useProvenance } from "../notes/useProvenance";

/**
 * One feed row. Exists as its own component so `useRenderedContent` can be a
 * hook — tokenization is per-note, and a hook cannot run inside a `.map`.
 */
/**
 * One feed row, memoised.
 *
 * Worth it because the store re-emits its whole matching set on every change: an
 * author resolving, one reaction arriving, a new note landing. Without this, each
 * of those re-rendered every row on screen — and each row re-parses its content
 * into tokens, which is the expensive part.
 *
 * This only works because `toNoteViews` reuses the previous view object when a row
 * is unchanged. Memoising against freshly built objects would compare unequal
 * every time and skip nothing.
 */
const NoteRow = memo(function NoteRow({
  note,
  provenanceRelays,
  actions,
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
}: {
  note: NoteView;
  provenanceRelays?: readonly string[];
  actions?: NoteRowActions;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
  /** Fired when the reader leaves the top, so newer rows can be staged. */
  /** Fired on return to the top, so staged rows can flow in again. */
}) {
  // TEMP-INSTRUMENT
  (globalThis as any).__noteRenders = ((globalThis as any).__noteRenders ?? 0) + 1;
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
    />
  );
});

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
  loading = false,
  pendingCount = 0,
  onFlushPending,
  onLoadMore,
  hasMore = false,
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
  const provenance = useProvenance(
    useMemo(() => notes.map((note) => note.id), [notes]),
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

  const rows = (
    <FeedRows
      provenance={provenance}
      notes={notes}
      loading={loading}
      emptyTitle={emptyTitle}
      {...(emptyDescription !== undefined ? { emptyDescription } : {})}
      {...(actions ? { actions } : {})}
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
          {rows}
        </div>
      ) : (
        <ScrollArea ref={scrollRef} className="setu-feed-column">
          {banner}
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
