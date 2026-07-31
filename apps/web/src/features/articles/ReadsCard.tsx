import { Avatar, AvatarFallback, AvatarImage, cn } from "@setu/ui";
import { BadgeCheck, ImageOff } from "lucide-react";
import { useState } from "react";
import { relativeTime } from "../notes/relativeTime";
import type { AuthorView } from "../notes/types";
import type { ArticleRow } from "./articleViews";
import { sanitizeImageUrl } from "./markdownUrl";

/**
 * One article in the Reads feed.
 *
 * Distinct from `ArticleList`'s row, which lists the reader's *own* writing and
 * so leads with draft/published status. Here the author is the reason to click:
 * a discovery feed of long-form posts is browsed by who wrote it, so the byline
 * comes first and the status badge — always "published" out here — is dropped.
 *
 * The shape is a card rather than a note row on purpose. Long-form is not a
 * kind-1 with more characters: rendering it through the note row truncated the
 * body to a few lines of raw Markdown and discarded the title, summary and cover
 * the author took the trouble to write. Title, summary and cover are the whole
 * offer, so they are what the row shows.
 */

/** Cover thumbnail, or nothing. A broken cover must not leave a torn icon. */
function Cover({ url }: { url: string }) {
  const safe = sanitizeImageUrl(url);
  const [broken, setBroken] = useState(false);
  if (safe === undefined) return null;
  if (broken) {
    return (
      <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 sm:h-24 sm:w-36">
        <ImageOff className="size-4 text-muted-foreground" />
      </div>
    );
  }
  return (
    <img
      src={safe}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="h-20 w-28 shrink-0 rounded-lg border border-border/60 object-cover sm:h-24 sm:w-36"
    />
  );
}

export interface ReadsCardProps {
  row: ArticleRow;
  author: AuthorView;
  onOpen(row: ArticleRow): void;
  onOpenProfile?(pubkey: string): void;
}

export function ReadsCard({
  row,
  author,
  onOpen,
  onOpenProfile,
}: ReadsCardProps) {
  return (
    <article className="cv-auto-row group/read border-b border-border/50 transition-colors duration-(--motion-duration-instant) hover:bg-muted/30">
      <div className="flex items-start gap-4 px-4 py-4">
        <div className="min-w-0 flex-1">
          {/* The byline sits outside the card's own button: it navigates
              somewhere else, and a link inside a button is not operable. */}
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenProfile?.(author.pubkey)}
              disabled={!onOpenProfile}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md text-left",
                "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
                onOpenProfile && "cursor-pointer",
              )}
            >
              <Avatar className="size-6">
                {author.avatarUrl ? (
                  <AvatarImage src={author.avatarUrl} alt="" />
                ) : null}
                <AvatarFallback>
                  {author.resolved
                    ? author.displayName.slice(0, 2).toUpperCase()
                    : null}
                </AvatarFallback>
              </Avatar>
              <span
                className={cn(
                  "truncate text-sm font-medium",
                  // An unresolved author gets a placeholder width, not an npub
                  // that will be replaced a second later.
                  !author.resolved && "text-transparent",
                  !author.resolved && "rounded bg-muted",
                )}
              >
                {author.resolved ? author.displayName : "        "}
              </span>
              {author.verified ? (
                <BadgeCheck
                  aria-label="Verified NIP-05 identifier"
                  className="size-3.5 shrink-0 text-verified"
                />
              ) : null}
            </button>
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            <time
              dateTime={new Date(row.timestamp * 1000).toISOString()}
              className="shrink-0 text-xs text-muted-foreground"
            >
              {relativeTime(row.timestamp)}
            </time>
          </div>

          <button
            type="button"
            onClick={() => onOpen(row)}
            className="w-full cursor-pointer text-left focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
          >
            <h3
              className={cn(
                "setu-clamp-2 text-base leading-snug font-semibold",
                row.untitled && "text-muted-foreground italic",
              )}
            >
              {row.title}
            </h3>
            {row.excerpt ? (
              <p className="setu-clamp-2 mt-1 text-sm text-muted-foreground">
                {row.excerpt}
              </p>
            ) : null}
            {row.readingMinutes > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {row.readingMinutes} min read
              </p>
            ) : null}
          </button>
        </div>

        {row.image ? <Cover url={row.image} /> : null}
      </div>
    </article>
  );
}
