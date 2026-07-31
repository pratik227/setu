import { getTagValue, type NostrEvent } from "@setu/protocol";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  cn,
} from "@setu/ui";
import { BadgeCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { absoluteTime } from "../notes/relativeTime";
import { fallbackAuthor, useAuthors } from "../profiles/useAuthors";
import { articleTimestamp, articleTitle, UNTITLED } from "./articleViews";
import { ARTICLE_DRAFT_KIND, readingMinutes } from "./buildArticle";
import { Markdown } from "./MarkdownView";
import { sanitizeImageUrl } from "./markdownUrl";

/**
 * An article, read.
 *
 * The props are deliberately narrow — an event and three callbacks — because
 * this view is opened from two places: the author's own Published list and the
 * Reads feed. Anything wider (a route, a feed handle, the editor's state) would
 * tie the reading view to whichever screen was written first.
 *
 * Layout follows the house convention: prose is capped by `setu-reading-column`
 * regardless of how wide the shell is, and the header scrolls with the article
 * rather than pinning, because an article is read top to bottom and a sticky
 * header would spend a fifth of a laptop screen on a title the reader has
 * already read.
 */

export interface ArticleReaderProps {
  event: NostrEvent;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
  onClose?(): void;
}

/** Cover image, with the broken state shown rather than a torn-icon gap. */
function CoverImage({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="mb-6 flex h-32 items-center justify-center rounded-xl border border-dashed border-border bg-muted/30">
        <p className="text-xs text-muted-foreground">
          The cover image could not be loaded.
        </p>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="mb-6 max-h-80 w-full rounded-xl border border-border/60 object-cover"
    />
  );
}

export function ArticleReader({
  event,
  onOpenProfile,
  onOpenHashtag,
  onClose,
}: ArticleReaderProps) {
  // One-element interest set. `useAuthors` batches and caches across the app, so
  // asking for one author here costs nothing extra, and it brings the NIP-05
  // verification pass with it rather than reimplementing the badge rule.
  const pubkeys = useMemo(() => [event.pubkey], [event.pubkey]);
  const authors = useAuthors(pubkeys);
  const author = authors.get(event.pubkey) ?? fallbackAuthor(event.pubkey);

  const title = articleTitle(event) ?? UNTITLED;
  const summary = getTagValue(event, "summary")?.trim();
  const cover = getTagValue(event, "image")?.trim();
  // The cover is a URL from an event, held to the same allowlist as an image in
  // the body: a `data:` cover is no safer for being in a tag.
  const coverSrc = cover ? sanitizeImageUrl(cover) : undefined;
  const timestamp = articleTimestamp(event);
  const minutes = readingMinutes(event.content);
  const isDraft = event.kind === ARTICLE_DRAFT_KIND;

  const hashtags = useMemo(() => {
    const seen = new Set<string>();
    for (const tag of event.tags) {
      if (tag[0] === "t" && tag[1]) seen.add(tag[1].toLowerCase());
    }
    return [...seen];
  }, [event.tags]);

  return (
    <article className="setu-scroll min-h-0 flex-1">
      <div className="setu-reading-column px-4 py-8 sm:px-6">
        {onClose ? (
          <div className="mb-4 flex justify-end">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close article"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        ) : null}

        {coverSrc ? <CoverImage src={coverSrc} /> : null}

        {isDraft ? (
          <Badge variant="outline" className="mb-3">
            Draft
          </Badge>
        ) : null}

        <h1
          className={cn(
            "text-2xl font-bold tracking-tight break-words sm:text-3xl",
            articleTitle(event) === undefined && "text-muted-foreground",
          )}
        >
          {title}
        </h1>

        {summary ? (
          <p className="mt-3 text-base text-muted-foreground italic">
            {summary}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 pb-5">
          <button
            type="button"
            onClick={() => onOpenProfile?.(event.pubkey)}
            aria-label={
              author.resolved
                ? `Open ${author.displayName}'s profile`
                : "Open the author's profile"
            }
            className="shrink-0 rounded-full focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
          >
            <Avatar className="size-8">
              {author.avatarUrl ? (
                <AvatarImage src={author.avatarUrl} alt="" />
              ) : null}
              <AvatarFallback>
                {author.resolved
                  ? author.displayName.slice(0, 1).toUpperCase()
                  : null}
              </AvatarFallback>
            </Avatar>
          </button>

          {/* An unresolved author gets a placeholder, never the npub. Printing
              the npub and swapping in the real name a second later reads as the
              client having named the wrong person. */}
          {author.resolved ? (
            <button
              type="button"
              onClick={() => onOpenProfile?.(event.pubkey)}
              className="text-sm font-semibold hover:underline"
            >
              {author.displayName}
            </button>
          ) : (
            // Purely a shape held for the name. The avatar button beside it
            // already labels the author for assistive tech, so announcing this
            // too would say the same thing twice.
            <span
              aria-hidden
              className="inline-block h-4 w-28 rounded bg-muted"
            />
          )}

          {author.verified ? (
            <BadgeCheck
              className="size-3.5 shrink-0 text-verified"
              aria-label="NIP-05 verified"
            />
          ) : null}

          <span className="text-xs text-muted-foreground/60">·</span>
          <time
            dateTime={new Date(timestamp * 1000).toISOString()}
            title={absoluteTime(timestamp)}
            className="text-xs text-muted-foreground"
          >
            {new Date(timestamp * 1000).toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </time>

          {minutes > 0 ? (
            <>
              <span className="text-xs text-muted-foreground/60">·</span>
              <span className="text-xs text-muted-foreground">
                {minutes} min read
              </span>
            </>
          ) : null}
        </div>

        <Markdown
          source={event.content}
          className="mt-2"
          {...(onOpenHashtag ? { onOpenHashtag } : {})}
          {...(onOpenProfile ? { onOpenProfile } : {})}
        />

        {hashtags.length > 0 ? (
          <div className="mt-8 flex flex-wrap gap-1.5 border-t border-border/60 pt-6">
            {hashtags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => onOpenHashtag?.(tag)}
                className={cn(
                  "rounded-md border border-border px-2.5 py-1 text-xs",
                  "text-muted-foreground transition-colors",
                  "hover:border-primary/40 hover:text-foreground",
                )}
              >
                #{tag}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
