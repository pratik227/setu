import type { NostrEvent } from "@setu/protocol";
import { Kind } from "@setu/protocol";
import { EmptyState, ScrollArea, Spinner } from "@setu/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveFeed } from "../feed/useLiveFeed";
import { fallbackAuthor, useAuthors } from "../profiles/useAuthors";
import { ArticleReader } from "./ArticleReader";
import { type ArticleRow, toArticleRows } from "./articleViews";
import { ReadsCard } from "./ReadsCard";

/**
 * Reads: long-form writing from the wider network.
 *
 * Previously this route pointed a plain note feed at kind 30023, which rendered
 * each article as a truncated kind-1: the reader saw a few lines of raw Markdown
 * — `## heading`, `[text](url)` and all — with the title, summary and cover image
 * silently dropped. Long-form needs its own row, and this screen supplies it.
 *
 * Two panes in one column rather than side by side. An article is read at a
 * comfortable measure, and a list rail stealing a third of the width leaves the
 * prose narrower than it should be, so opening one replaces the list and closing
 * returns to it. The feed keeps running underneath either way — closing the
 * reader lands back on the same scroll position with anything new already staged.
 *
 * Only kind 30023 is asked for. Kind 30024 is a *draft*: it is published to a
 * relay in the normal way but it is explicitly not for readers, and a client that
 * shows other people's drafts in a discovery feed is leaking work in progress.
 */

/** Rows resolved for author metadata — the ones a reader can plausibly reach. */
const METADATA_WINDOW = 40;

export interface ReadsScreenProps {
  relays: readonly string[];
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}

export function ReadsScreen({
  relays,
  onOpenProfile,
  onOpenHashtag,
}: ReadsScreenProps) {
  const definition = useMemo(
    () => ({ kinds: [Kind.LongFormArticle], relays }),
    [relays],
  );
  const { snapshot, loadMore } = useLiveFeed(definition);
  const [reading, setReading] = useState<NostrEvent | undefined>(undefined);

  const rows = useMemo(
    () => toArticleRows(snapshot.entries.map((entry) => entry.event)),
    [snapshot.entries],
  );

  const resolvable = useMemo(() => rows.slice(0, METADATA_WINDOW), [rows]);
  const pubkeys = useMemo(
    () => [...new Set(resolvable.map((row) => row.event.pubkey))],
    [resolvable],
  );
  const authors = useAuthors(pubkeys);

  const open = useCallback((row: ArticleRow) => setReading(row.event), []);
  const close = useCallback(() => setReading(undefined), []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasMore = !snapshot.exhausted;

  useEffect(() => {
    // No sentinel while reading: the list is unmounted, so an observer would be
    // watching a node that no longer exists.
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || reading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: scrollRef.current, rootMargin: "600px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, hasMore, reading]);

  if (reading) {
    return (
      <ArticleReader
        event={reading}
        onClose={close}
        {...(onOpenProfile ? { onOpenProfile } : {})}
        {...(onOpenHashtag ? { onOpenHashtag } : {})}
      />
    );
  }

  return (
    <ScrollArea ref={scrollRef}>
      <div className="setu-feed-column">
        {rows.length === 0 ? (
          snapshot.loading ? (
            <div className="flex justify-center py-16">
              <Spinner aria-label="Loading articles" />
            </div>
          ) : (
            <EmptyState
              title="No articles yet"
              description="Reads collects long-form posts published to your relays. Nothing has arrived yet."
            />
          )
        ) : (
          rows.map((row) => (
            <ReadsCard
              key={row.id}
              row={row}
              author={
                authors.get(row.event.pubkey) ??
                fallbackAuthor(row.event.pubkey)
              }
              onOpen={open}
              {...(onOpenProfile ? { onOpenProfile } : {})}
            />
          ))
        )}

        {hasMore ? <div ref={sentinelRef} className="h-px" /> : null}
        {snapshot.loading && rows.length > 0 ? (
          <div className="flex justify-center py-6">
            <Spinner aria-hidden size={20} />
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}
