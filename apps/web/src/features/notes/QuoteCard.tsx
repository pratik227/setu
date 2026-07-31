import { encodeNevent, encodeNote, truncateNpub } from "@setu/protocol";
import { Avatar, AvatarFallback, AvatarImage, cn } from "@setu/ui";
import { HelpCircle, Quote } from "lucide-react";
import { useMemo } from "react";
import { NoteMedia } from "./NoteMedia";
import {
  type BodyHandlers,
  type QuoteReference,
  useRenderedBody,
} from "./noteBody";
import { noteMediaViews } from "./noteMediaViews";
import {
  nestedFrame,
  QuoteFrameContext,
  quoteRenderMode,
  useQuoteFrame,
} from "./quoteDepth";
import { useQuotedNote } from "./quotedNotes";
import { absoluteTime, relativeTime } from "./relativeTime";

/**
 * A quoted note, rendered as the note it is.
 *
 * Three states, and none of them is an error:
 *
 *  - **found** — author, content and timestamp in a bordered card, visibly
 *    subordinate to the note quoting it (smaller type, muted surface, inset).
 *  - **loading** — a card-shaped placeholder. Shaped, not a bare spinner, because
 *    the card is about to occupy that space and a placeholder of the wrong size
 *    moves the rows below it when the real one lands.
 *  - **missing** — the reference, stated plainly. A quoted event that no relay we
 *    read holds is the ordinary case for a quote of a note from elsewhere on the
 *    network; an empty card would imply the note is empty, and a spinner that
 *    never resolves would claim something is still happening.
 *
 * The content is a stranger's text and goes through exactly the same tokenizer and
 * URL allowlist as any other note body — nothing here parses or trusts anything
 * new. Nesting is bounded by `quoteDepth.ts`, which is what keeps "A quotes B
 * quotes A" from recursing until the tab dies.
 */
export interface QuoteCardProps extends BodyHandlers {
  reference: QuoteReference;
}

/**
 * Nested quotes recurse through this, not through an import of the body renderer.
 *
 * Module-level so it is reference-stable: it is a dependency of the tokenizing
 * memo, and a fresh closure per render would re-tokenize every quoted note on
 * every render of the row above it.
 */
function renderNestedQuote(
  reference: QuoteReference,
  handlers: BodyHandlers,
): React.ReactNode {
  return <QuoteCard reference={reference} {...handlers} />;
}

/** `nevent1…`/`note1…`, truncated — the most a reader can be told about an id. */
function referenceLabel(reference: QuoteReference): string {
  const encoded =
    encodeNevent({
      id: reference.id,
      ...(reference.author ? { author: reference.author } : {}),
      ...(reference.relays ? { relays: reference.relays } : {}),
    }) ?? encodeNote(reference.id);
  return encoded ? truncateNpub(encoded, 10) : `${reference.id.slice(0, 12)}…`;
}

const CARD_CLASS =
  "mt-2 overflow-hidden rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm";

/**
 * Height the quoted body is allowed before it is cut off.
 *
 * A quoted note can be longer than the note quoting it, and an embed that dwarfs
 * its host stops reading as a quote. Cutting it keeps the card subordinate.
 */
const BODY_CLAMP = "max-h-40 overflow-hidden";

export function QuoteCard({
  reference,
  onOpenHashtag,
  onOpenMention,
}: QuoteCardProps) {
  const frame = useQuoteFrame();
  const mode = quoteRenderMode(reference.id, frame);

  // Hooks cannot be conditional, so the guard is expressed as "want nothing":
  // passing the empty id registers no interest and opens no subscription, which
  // is what keeps a declined reference free.
  const quoted = useQuotedNote(mode === "card" ? reference.id : "");
  const event = quoted.event;

  const nested = useMemo(
    () => nestedFrame(reference.id, frame),
    [reference.id, frame],
  );
  const { body } = useRenderedBody({
    content: event?.content ?? "",
    ...(event ? { tags: event.tags } : {}),
    ...(onOpenHashtag ? { onOpenHashtag } : {}),
    ...(onOpenMention ? { onOpenMention } : {}),
    renderQuote: renderNestedQuote,
  });
  const media = useMemo(
    () => (event ? noteMediaViews(event) : undefined),
    [event],
  );

  if (mode === "reference") {
    return <QuoteReferenceRow reference={reference} />;
  }

  if (quoted.status === "loading") {
    return <QuotePlaceholder />;
  }

  if (event === undefined || quoted.author === undefined) {
    return <MissingQuote reference={reference} />;
  }

  const author = quoted.author;

  return (
    <div className={CARD_CLASS}>
      <div className="flex min-w-0 items-center gap-1.5">
        <Avatar className="size-5">
          {author.avatarUrl ? (
            <AvatarImage src={author.avatarUrl} alt={author.displayName} />
          ) : null}
          <AvatarFallback className="text-2xs">
            {author.displayName.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {/* An unresolved author is a placeholder, not a name: the same rule the
            feed row follows, so the card does not swap a truncated key for a real
            name a second later. */}
        {author.resolved ? (
          <>
            <span className="truncate font-semibold">{author.displayName}</span>
            <span className="setu-mono truncate text-xs text-muted-foreground">
              {author.handle}
            </span>
          </>
        ) : (
          <>
            <span className="sr-only">Loading author</span>
            <span
              aria-hidden
              className="motion-shimmer h-3 w-24 shrink-0 rounded bg-foreground/[0.07]"
            />
          </>
        )}
        <span className="text-xs text-muted-foreground/60">·</span>
        <time
          dateTime={new Date(event.created_at * 1000).toISOString()}
          title={absoluteTime(event.created_at)}
          className="shrink-0 text-xs text-muted-foreground"
        >
          {relativeTime(event.created_at)}
        </time>
      </div>

      {/* The nested frame is what the references *inside* this card read, so the
          depth cap and the cycle guard apply one level further down. */}
      <QuoteFrameContext value={nested}>
        <div
          className={cn(
            "mt-1 leading-snug break-words whitespace-pre-wrap",
            BODY_CLAMP,
          )}
        >
          {body}
        </div>
      </QuoteFrameContext>

      {media ? <NoteMedia media={media} /> : null}
    </div>
  );
}

/**
 * A reference we decline to expand — past the depth cap, or a note already on the
 * render path. Shown rather than dropped: the author did quote something, and
 * saying so is the whole of what we can honestly say here.
 */
function QuoteReferenceRow({ reference }: { reference: QuoteReference }) {
  return (
    <span
      title="Quoted note, not expanded here"
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-xs"
    >
      <Quote className="size-3 shrink-0 text-muted-foreground" />
      <span className="font-mono text-muted-foreground">
        {referenceLabel(reference)}
      </span>
    </span>
  );
}

/** Card-shaped, so the rows below do not move when the real card arrives. */
function QuotePlaceholder() {
  return (
    <div className={CARD_CLASS} aria-busy="true">
      <span className="sr-only">Loading quoted note</span>
      <div aria-hidden className="flex items-center gap-1.5">
        <span className="motion-shimmer size-5 shrink-0 rounded-full bg-foreground/[0.07]" />
        <span className="motion-shimmer h-3 w-24 rounded bg-foreground/[0.07]" />
      </div>
      <div aria-hidden className="mt-2 space-y-1.5">
        <span className="motion-shimmer block h-3 w-full rounded bg-foreground/[0.07]" />
        <span className="motion-shimmer block h-3 w-3/5 rounded bg-foreground/[0.07]" />
      </div>
    </div>
  );
}

/**
 * The reference, when no relay we asked returned the event.
 *
 * Dashed rather than solid, and worded as a fact about our relays rather than
 * about the note: the note may well exist, on relays this account does not read.
 */
function MissingQuote({ reference }: { reference: QuoteReference }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2.5">
      <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs font-medium">Quoted note unavailable</p>
        <p className="text-2xs text-muted-foreground">
          No relay we asked returned{" "}
          <span className="font-mono break-all">
            {referenceLabel(reference)}
          </span>
          .
        </p>
      </div>
    </div>
  );
}
