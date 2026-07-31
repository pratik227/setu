import {
  type ContentToken,
  emojiTagMap,
  encodeNpub,
  type Nip19Ref,
  quotedEventIds,
  tokenizeContent,
  truncateNpub,
} from "@setu/protocol";
import { cn } from "@setu/ui";
import { Fragment, useMemo } from "react";
import { EmojiText } from "./CustomEmoji";
import type { MediaView } from "./types";

/**
 * The token-to-React renderer for note content.
 *
 * Split out from `NoteContent` so quote cards can reuse it without a cycle: a
 * quoted note's body is note content too, and the module that renders a card
 * therefore has to render a body. With both halves in one file that is an import
 * loop; here the arrow only points one way, and the recursion happens through the
 * `renderQuote` callback the caller supplies.
 *
 * Tokenizing happens once in a memo and the renderer is a pure switch over the
 * result, so nothing here re-parses text during a scroll. Media tokens are
 * *lifted out* of the body and returned separately — a bare image URL should
 * become a gallery, not a link, and that decision belongs to the caller.
 */

export interface RenderedContent {
  readonly body: React.ReactNode;
  readonly media: readonly MediaView[];
}

/** An event a note points at, as much of it as the reference carried. */
export interface QuoteReference {
  readonly id: string;
  /** Relay hints from an `nevent`. Advisory; see `quotedNotes.ts`. */
  readonly relays?: readonly string[];
  readonly author?: string;
}

/** Handlers a nested body needs, so a quoted note's links still work. */
export interface BodyHandlers {
  onOpenHashtag?(tag: string): void;
  onOpenMention?(token: ContentToken & { type: "mention" }): void;
}

const LINK_CLASS =
  "text-primary underline-offset-2 hover:underline break-words";

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const shown = `${parsed.host}${path}`;
    return shown.length > 48 ? `${shown.slice(0, 48)}…` : shown;
  } catch {
    return url;
  }
}

/**
 * Short label for a nostr entity mention.
 *
 * A truncated npub is a placeholder, not the goal: once the profile batcher has
 * the author's kind-0 this should resolve to their display name. Showing the
 * bech32 form rather than raw hex at least keeps it recognizable meanwhile.
 */
function mentionLabel(token: ContentToken & { type: "mention" }): string {
  const ref = token.entity;
  const pubkey =
    ref.type === "npub" || ref.type === "nprofile" ? ref.pubkey : undefined;
  if (pubkey) {
    const npub = encodeNpub(pubkey);
    return `@${npub ? truncateNpub(npub, 8) : pubkey.slice(0, 8)}`;
  }
  return "note";
}

/**
 * The event a mention points at, when it points at one.
 *
 * `note` and `nevent` are the two NIP-19 forms that name an event; an `naddr` is
 * deliberately excluded, because it names an *address* whose current occupant can
 * change, and resolving one is a different query than an id lookup.
 */
export function quoteReference(entity: Nip19Ref): QuoteReference | undefined {
  if (entity.type === "note") return { id: entity.id };
  if (entity.type !== "nevent") return undefined;
  return {
    id: entity.id,
    ...(entity.relays ? { relays: entity.relays } : {}),
    ...(entity.author ? { author: entity.author } : {}),
  };
}

function TokenView({
  token,
  emoji,
  onOpenHashtag,
  onOpenMention,
  renderQuote,
}: BodyHandlers & {
  token: ContentToken;
  /** NIP-30 `shortcode -> URL`, empty for the overwhelming majority of notes. */
  emoji: ReadonlyMap<string, string>;
  renderQuote?(
    reference: QuoteReference,
    handlers: BodyHandlers,
  ): React.ReactNode;
}) {
  switch (token.type) {
    case "text":
      // Only `text` gets shortcode substitution. A `:shortcode:` inside a fenced
      // code block or a URL path is characters the author meant literally, and the
      // tokenizer has already separated those out — which is why the substitution
      // happens here rather than over the whole string before tokenizing.
      return <EmojiText text={token.value} emoji={emoji} />;

    case "newline":
      return <>{token.value}</>;

    case "url":
      return (
        <a
          href={token.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={LINK_CLASS}
        >
          {displayUrl(token.url)}
        </a>
      );

    case "hashtag":
      return (
        <button
          type="button"
          onClick={() => onOpenHashtag?.(token.tag)}
          className={cn(LINK_CLASS, "cursor-pointer")}
        >
          {token.value}
        </button>
      );

    case "mention": {
      // An event reference renders as the note it points at, not as the word
      // "note": a chip tells the reader a note was quoted and then withholds
      // which one, so the quote has to be opened elsewhere to be read at all.
      const quote = renderQuote ? quoteReference(token.entity) : undefined;
      if (quote && renderQuote) {
        return <>{renderQuote(quote, { onOpenHashtag, onOpenMention })}</>;
      }
      return (
        <button
          type="button"
          onClick={() => onOpenMention?.(token)}
          className={cn(LINK_CLASS, "cursor-pointer font-medium")}
        >
          {mentionLabel(token)}
        </button>
      );
    }

    case "code":
      return (
        <pre className="my-2 overflow-x-auto rounded-lg border border-border/60 bg-muted/60 p-3">
          <code className="font-mono text-xs">{token.code}</code>
        </pre>
      );

    // Lightning and Cashu payloads are long opaque strings. Rendering them raw
    // destroys the note's layout, so they collapse to a labeled chip.
    case "lnInvoice":
      return <PayloadChip label="Lightning invoice" value={token.invoice} />;
    case "lnurl":
      return <PayloadChip label="LNURL" value={token.lnurl} />;
    case "cashu":
      return <PayloadChip label="Cashu token" value={token.token} />;

    // Media is hoisted into the gallery; nothing is left inline.
    case "image":
    case "video":
      return null;

    default: {
      // Exhaustiveness guard: a new token type must be handled explicitly
      // rather than silently rendering as nothing.
      const never: never = token;
      return <>{String(never)}</>;
    }
  }
}

function PayloadChip({ label, value }: { label: string; value: string }) {
  return (
    <span
      title={value}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-xs"
    >
      <span className="font-medium">{label}</span>
      <span className="font-mono text-muted-foreground">
        {value.slice(0, 10)}…
      </span>
    </span>
  );
}

export interface NoteBodyOptions extends BodyHandlers {
  content: string;
  tags?: readonly (readonly string[])[];
  /**
   * Renders an embedded quote for an event reference.
   *
   * A callback rather than a component import, so this module never has to know
   * that quote cards exist — which is what keeps the recursion acyclic. Must be
   * reference-stable: it is a dependency of the tokenizing memo, and a fresh
   * closure per render would re-tokenize every note on every render.
   */
  renderQuote?(
    reference: QuoteReference,
    handlers: BodyHandlers,
  ): React.ReactNode;
}

/** Shared empty map, so a note with no `emoji` tags allocates nothing. */
const NO_EMOJI: ReadonlyMap<string, string> = new Map();

/**
 * Tag-only quotes one note may expand.
 *
 * A cap, because the tag list is author-controlled and unbounded: a note carrying
 * two hundred `q` tags would mount two hundred quote cards, each of which registers
 * an id with the quote tracker and fetches an event. That is one row turning into a
 * page-long wall and a filter the tracker's own cap then has to evict from.
 *
 * Two is what an honest quote repost needs — the shape NIP-18 describes has exactly
 * one — and the surplus is not dropped silently: `quotedEventIds` order is tag
 * order, so the first ones are the ones the author wrote first.
 */
const MAX_TAG_QUOTES = 2;

/**
 * Event ids the content already renders as an embedded quote.
 *
 * The set `q` tags are checked against. NIP-18 says a quote repost carries both an
 * inline `nostr:nevent…` reference *and* a `q` tag naming the same event, so
 * rendering both would show the quoted note twice in one row.
 */
function inlineQuotedIds(tokens: readonly ContentToken[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const token of tokens) {
    if (token.type !== "mention") continue;
    const reference = quoteReference(token.entity);
    if (reference) ids.add(reference.id);
  }
  return ids;
}

/** Tokenize once, then render. Returns the body and the hoisted media list. */
export function useRenderedBody({
  content,
  tags,
  onOpenHashtag,
  onOpenMention,
  renderQuote,
}: NoteBodyOptions): RenderedContent {
  return useMemo(() => {
    const tokens = tokenizeContent(content, tags);
    const emoji = tags ? emojiTagMap({ tags }) : NO_EMOJI;

    const media: MediaView[] = tokens
      .filter(
        (t): t is ContentToken & { type: "image" | "video" } =>
          t.type === "image" || t.type === "video",
      )
      .map((t) => ({ url: t.url, kind: t.type }));

    /*
     * Quote reposts whose reference exists only as a `q` tag.
     *
     * Not a rare shape: plenty of clients write the tag and leave the content as
     * the author's own commentary, with no `nostr:` URI in it at all. Rendering
     * only inline references makes every one of those quotes invisible — the row
     * shows a remark about a note the reader is never shown, which reads as a
     * non-sequitur rather than as a missing embed.
     */
    const inline = inlineQuotedIds(tokens);
    const tagged =
      tags && renderQuote
        ? quotedEventIds({ tags })
            .filter((id) => !inline.has(id))
            .slice(0, MAX_TAG_QUOTES)
        : [];

    const body = (
      <>
        {tokens.map((token, i) => (
          // The token list is a pure function of immutable note content: a
          // note's text never changes in place, so a token cannot shift
          // position, and there is no stable id to use instead.
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens never reorder
          <Fragment key={`${token.type}-${i}`}>
            <TokenView
              token={token}
              emoji={emoji}
              onOpenHashtag={onOpenHashtag}
              onOpenMention={onOpenMention}
              {...(renderQuote ? { renderQuote } : {})}
            />
          </Fragment>
        ))}
        {tagged.map((id) => (
          <Fragment key={`q-${id}`}>
            {renderQuote?.({ id }, { onOpenHashtag, onOpenMention })}
          </Fragment>
        ))}
      </>
    );

    return { body, media };
  }, [content, tags, onOpenHashtag, onOpenMention, renderQuote]);
}
