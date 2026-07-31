import { Badge, cn } from "@setu/ui";
import { BookOpen, ImageOff } from "lucide-react";
import { useState } from "react";
import { absoluteTime, relativeTime } from "../notes/relativeTime";
import type { ArticleRow } from "./articleViews";
import { sanitizeImageUrl } from "./markdownUrl";

/**
 * Rows for the drafts / published lists.
 *
 * The rule the row is built around: **it is never blank.** A title falls back to
 * "Untitled" in a dimmed style rather than to an empty line, and the excerpt
 * falls back to the body's opening prose. An article with neither still renders
 * its status and its date, so there is always something to see and something to
 * click.
 */

/** Thumbnail, or nothing. A broken cover must not leave a torn-image icon. */
function Thumbnail({ url }: { url: string }) {
  const safe = sanitizeImageUrl(url);
  const [broken, setBroken] = useState(false);
  if (safe === undefined) return null;
  if (broken) {
    return (
      <div className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40">
        <ImageOff className="size-3.5 text-muted-foreground" />
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
      className="size-12 shrink-0 rounded-md border border-border/60 object-cover"
    />
  );
}

export interface ArticleListProps {
  rows: readonly ArticleRow[];
  selectedId?: string;
  onEdit(row: ArticleRow): void;
  onRead?(row: ArticleRow): void;
}

export function ArticleList({
  rows,
  selectedId,
  onEdit,
  onRead,
}: ArticleListProps) {
  return (
    <ul>
      {rows.map((row) => (
        <li
          key={row.id}
          className={cn(
            "cv-auto-row group/row border-b border-border/50",
            row.id === selectedId && "bg-muted/50",
          )}
        >
          <div className="flex items-start gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => onEdit(row)}
              className="min-w-0 flex-1 cursor-pointer text-left"
            >
              <div className="mb-1 flex items-center gap-2">
                <Badge variant={row.draft ? "outline" : "secondary"}>
                  {row.draft ? "Draft" : "Published"}
                </Badge>
                <time
                  dateTime={new Date(row.timestamp * 1000).toISOString()}
                  title={absoluteTime(row.timestamp)}
                  className="text-2xs text-muted-foreground"
                >
                  {relativeTime(row.timestamp)}
                </time>
                {row.readingMinutes > 0 ? (
                  <span className="text-2xs text-muted-foreground">
                    · {row.readingMinutes} min
                  </span>
                ) : null}
              </div>

              <p
                className={cn(
                  "truncate text-sm font-semibold",
                  // Dimmed so "Untitled" reads as the absence of a title rather
                  // than as a title someone chose.
                  row.untitled && "text-muted-foreground italic",
                )}
              >
                {row.title}
              </p>

              {row.excerpt ? (
                <p className="setu-clamp-2 mt-0.5 text-xs text-muted-foreground">
                  {row.excerpt}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-muted-foreground/70 italic">
                  No content yet
                </p>
              )}
            </button>

            {row.image ? <Thumbnail url={row.image} /> : null}
          </div>

          {onRead && !row.draft ? (
            <div className="px-4 pb-2">
              <button
                type="button"
                onClick={() => onRead(row)}
                className="flex items-center gap-1.5 text-2xs text-muted-foreground hover:text-foreground"
              >
                <BookOpen className="size-3" />
                Read
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
