import {
  type ContentToken,
  encodeNpub,
  tokenizeContent,
  truncateNpub,
} from "@setu/protocol";
import { cn } from "@setu/ui";
import { Fragment, useMemo } from "react";
import type { MediaView } from "./types";

/**
 * Renders tokenized note content.
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

function TokenView({
  token,
  onOpenHashtag,
  onOpenMention,
}: {
  token: ContentToken;
  onOpenHashtag?(tag: string): void;
  onOpenMention?(token: ContentToken & { type: "mention" }): void;
}) {
  switch (token.type) {
    case "text":
      return <>{token.value}</>;

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

    case "mention":
      return (
        <button
          type="button"
          onClick={() => onOpenMention?.(token)}
          className={cn(LINK_CLASS, "cursor-pointer font-medium")}
        >
          {mentionLabel(token)}
        </button>
      );

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

export interface NoteContentProps {
  content: string;
  tags?: readonly (readonly string[])[];
  onOpenHashtag?(tag: string): void;
  onOpenMention?(token: ContentToken & { type: "mention" }): void;
}

/** Tokenize once, then render. Returns the body and the hoisted media list. */
export function useRenderedContent({
  content,
  tags,
  onOpenHashtag,
  onOpenMention,
}: NoteContentProps): RenderedContent {
  return useMemo(() => {
    const tokens = tokenizeContent(content, tags);

    const media: MediaView[] = tokens
      .filter(
        (t): t is ContentToken & { type: "image" | "video" } =>
          t.type === "image" || t.type === "video",
      )
      .map((t) => ({ url: t.url, kind: t.type }));

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
              onOpenHashtag={onOpenHashtag}
              onOpenMention={onOpenMention}
            />
          </Fragment>
        ))}
      </>
    );

    return { body, media };
  }, [content, tags, onOpenHashtag, onOpenMention]);
}
