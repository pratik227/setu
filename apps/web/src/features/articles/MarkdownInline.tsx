import { type ContentToken, tokenizeContent } from "@setu/protocol";
import { cn } from "@setu/ui";
import { Fragment } from "react";
import type { MarkdownInline } from "./markdownTypes";
import { isExternalHref } from "./markdownUrl";
import { wrapClass } from "./markdownWrap";

/**
 * Inline Markdown, as React elements.
 *
 * Nothing here builds a string of HTML. Every text value arrives as a React
 * child, which React escapes, so `<script>` in an article body is five
 * characters of prose and cannot be anything else. `href` and `src` are the only
 * attributes that carry author-supplied data, and both were allowlisted by the
 * parser before the node existed — a `link` node cannot hold a `javascript:`
 * destination, because the parser never builds one.
 *
 * Plain text runs are handed to the protocol tokenizer so that bare URLs,
 * `nostr:` references and `#hashtags` behave in an article the way they do in a
 * note. Two limits on that, both deliberate:
 *
 *  - Inside a Markdown link the tokenizer is skipped. A URL in a link's *label*
 *    would otherwise produce an `<a>` inside an `<a>`, which is invalid and
 *    swallows the outer link's click.
 *  - Media tokens are rendered as links rather than hoisted into a gallery. A
 *    note's bare image URL becomes a gallery because a note has no other way to
 *    embed one; an article has `![alt](src)` and its author chose not to use it.
 */

const LINK_CLASS = "text-primary underline-offset-2 hover:underline";

export interface InlineHandlers {
  onOpenHashtag?(tag: string): void;
  onOpenProfile?(pubkey: string): void;
}

/** Shorten a URL for display without hiding which host it points at. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const shown = `${parsed.host}${path}`;
    return shown.length > 56 ? `${shown.slice(0, 56)}…` : shown;
  } catch {
    return url;
  }
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const external = isExternalHref(href);
  return (
    <a
      href={href}
      // `noopener` denies the opened tab a handle on ours; `noreferrer` keeps the
      // article's URL out of the destination's logs; `nofollow` declines to lend
      // a stranger's link our ranking. None of these are defaults.
      {...(external
        ? { target: "_blank", rel: "noopener noreferrer nofollow" }
        : { rel: "nofollow" })}
      className={cn(LINK_CLASS, "break-words")}
    >
      {children}
    </a>
  );
}

/** One tokenizer token from a plain-text run. */
function TokenView({
  token,
  handlers,
}: {
  token: ContentToken;
  handlers: InlineHandlers;
}) {
  switch (token.type) {
    case "hashtag":
      return (
        <button
          type="button"
          onClick={() => handlers.onOpenHashtag?.(token.tag)}
          className={cn(LINK_CLASS, "cursor-pointer")}
        >
          {token.value}
        </button>
      );

    case "url":
      return (
        <ExternalLink href={token.url}>{displayUrl(token.url)}</ExternalLink>
      );

    case "image":
    case "video":
      // A bare media URL in an article stays a link: see the note above.
      return (
        <ExternalLink href={token.url}>{displayUrl(token.url)}</ExternalLink>
      );

    case "mention": {
      const ref = token.entity;
      const pubkey =
        ref.type === "npub" || ref.type === "nprofile" ? ref.pubkey : undefined;
      if (pubkey === undefined) return <>{token.value}</>;
      return (
        <button
          type="button"
          onClick={() => handlers.onOpenProfile?.(pubkey)}
          className={cn(LINK_CLASS, "cursor-pointer font-medium")}
        >
          {token.value}
        </button>
      );
    }

    default:
      // Everything else — text, newlines, invoices, code — renders as the exact
      // characters the author wrote. The tokenizer guarantees `value` is the
      // untouched slice, so this branch is lossless.
      return <>{token.value}</>;
  }
}

/** Plain text with bare URLs, hashtags and `nostr:` references made live. */
function LinkedText({
  value,
  handlers,
}: {
  value: string;
  handlers: InlineHandlers;
}) {
  const tokens = tokenizeContent(value);
  return (
    <>
      {tokens.map((token, i) => (
        // Token order is a pure function of an immutable string, so a token can
        // never change position within one render of one value.
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens never reorder
        <Fragment key={`${token.type}-${i}`}>
          <TokenView token={token} handlers={handlers} />
        </Fragment>
      ))}
    </>
  );
}

export function InlineNodes({
  nodes,
  handlers,
  inLink = false,
}: {
  nodes: readonly MarkdownInline[];
  handlers: InlineHandlers;
  inLink?: boolean;
}) {
  return (
    <>
      {nodes.map((node, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed nodes never reorder
        <Fragment key={`${node.type}-${i}`}>
          <InlineNode node={node} handlers={handlers} inLink={inLink} />
        </Fragment>
      ))}
    </>
  );
}

function InlineNode({
  node,
  handlers,
  inLink,
}: {
  node: MarkdownInline;
  handlers: InlineHandlers;
  inLink: boolean;
}) {
  switch (node.type) {
    case "text":
      // Inside a link the tokenizer is skipped, so the text is emitted as-is —
      // linkifying a URL that appears in a link's own label would nest one `<a>`
      // in another and swallow the outer link's click.
      if (inLink) return node.value;
      return <LinkedText value={node.value} handlers={handlers} />;

    case "break":
      return <br />;

    case "code":
      return (
        <code
          className={cn(
            "rounded-sm border border-border/60 bg-muted/60 px-1 py-0.5",
            "font-mono text-sm",
            wrapClass(node.value),
          )}
        >
          {node.value}
        </code>
      );

    case "strong":
      return (
        <strong className="font-semibold">
          <InlineNodes
            nodes={node.children}
            handlers={handlers}
            inLink={inLink}
          />
        </strong>
      );

    case "em":
      return (
        <em className="italic">
          <InlineNodes
            nodes={node.children}
            handlers={handlers}
            inLink={inLink}
          />
        </em>
      );

    case "strike":
      return (
        <s className="text-muted-foreground line-through">
          <InlineNodes
            nodes={node.children}
            handlers={handlers}
            inLink={inLink}
          />
        </s>
      );

    case "link":
      return (
        <ExternalLink href={node.href}>
          <InlineNodes nodes={node.children} handlers={handlers} inLink />
        </ExternalLink>
      );

    case "image":
      return (
        <img
          src={node.src}
          alt={node.alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="my-2 max-h-[32rem] w-auto max-w-full rounded-lg border border-border/60"
        />
      );

    default: {
      // Exhaustiveness guard: a new node type must be handled rather than
      // silently vanishing from a reader's article.
      const never: never = node;
      return <>{String(never)}</>;
    }
  }
}
