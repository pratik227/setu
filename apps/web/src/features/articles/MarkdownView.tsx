import { cn } from "@setu/ui";
import { Fragment, useMemo } from "react";
import { type InlineHandlers, InlineNodes } from "./MarkdownInline";
import {
  inlineText,
  type MarkdownBlock,
  type MarkdownList,
  parseMarkdown,
} from "./markdown";
import { wrapClass } from "./markdownWrap";

/**
 * Rendered Markdown.
 *
 * The file is `MarkdownView.tsx` rather than `Markdown.tsx` because the parser
 * beside it is `markdown.ts`, and on a case-insensitive filesystem those two are
 * the same module path: `import … from "./Markdown"` resolves to the parser, and
 * the component comes back `undefined` at runtime with no build error. A
 * case-only distinction between two files is a bug waiting for a macOS or
 * Windows checkout.
 *
 * The parse happens once per body in a memo; everything below is a pure switch
 * over the resulting tree. No HTML string is ever constructed and
 * `dangerouslySetInnerHTML` appears nowhere in this feature, which is what makes
 * markup injection structurally impossible rather than merely filtered.
 *
 * Typography is set here rather than by a prose plugin so every size stays a
 * named token. Body copy is `text-lg` — one step above a feed's `text-base`,
 * because an article is read continuously rather than scanned — with headings
 * stepping down through the same scale.
 *
 * A note for anyone tempted to add a custom size token for this: `cn` runs
 * tailwind-merge, which recognizes `text-{t-shirt-size}` as a font size and
 * treats every other `text-*` as a *color*. A token like `text-reading` is
 * therefore silently dropped the moment it shares a `cn` call with
 * `text-foreground`, with no error anywhere. `text-lg` already is 1.125rem.
 */

export interface MarkdownProps extends InlineHandlers {
  source: string;
  className?: string;
}

export function Markdown({
  source,
  className,
  onOpenHashtag,
  onOpenProfile,
}: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const handlers = useMemo<InlineHandlers>(
    () => ({
      ...(onOpenHashtag ? { onOpenHashtag } : {}),
      ...(onOpenProfile ? { onOpenProfile } : {}),
    }),
    [onOpenHashtag, onOpenProfile],
  );

  return (
    <div className={cn("text-lg leading-relaxed text-foreground", className)}>
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed blocks never reorder
        <Fragment key={`${block.type}-${i}`}>
          <Block block={block} handlers={handlers} />
        </Fragment>
      ))}
    </div>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-8 mb-3 text-2xl font-bold tracking-tight",
  2: "mt-7 mb-3 text-xl font-bold tracking-tight",
  3: "mt-6 mb-2 text-lg font-semibold",
  4: "mt-5 mb-2 text-base font-semibold",
  5: "mt-4 mb-1.5 text-sm font-semibold",
  6: "mt-4 mb-1.5 text-sm font-semibold text-muted-foreground",
};

function Heading({
  block,
  handlers,
}: {
  block: MarkdownBlock & { type: "heading" };
  handlers: InlineHandlers;
}) {
  const className = cn(
    HEADING_CLASS[block.level] ?? HEADING_CLASS[6],
    "first:mt-0",
    wrapClass(inlineText(block.children)),
  );
  const children = <InlineNodes nodes={block.children} handlers={handlers} />;
  switch (block.level) {
    case 1:
      return <h1 className={className}>{children}</h1>;
    case 2:
      return <h2 className={className}>{children}</h2>;
    case 3:
      return <h3 className={className}>{children}</h3>;
    case 4:
      return <h4 className={className}>{children}</h4>;
    case 5:
      return <h5 className={className}>{children}</h5>;
    default:
      return <h6 className={className}>{children}</h6>;
  }
}

function List({
  list,
  handlers,
  nested = false,
}: {
  list: MarkdownList;
  handlers: InlineHandlers;
  nested?: boolean;
}) {
  const items = list.items.map((item, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: parsed items never reorder
    <li key={`item-${i}`} className={wrapClass(inlineText(item.children))}>
      <InlineNodes nodes={item.children} handlers={handlers} />
      {item.sublist ? (
        <List list={item.sublist} handlers={handlers} nested />
      ) : null}
    </li>
  ));

  const className = cn(
    "ml-6 space-y-1",
    nested ? "mt-1" : "my-4",
    list.ordered ? "list-decimal" : "list-disc",
  );

  return list.ordered ? (
    <ol className={className} start={list.start}>
      {items}
    </ol>
  ) : (
    <ul className={className}>{items}</ul>
  );
}

function CodeBlock({
  block,
}: {
  block: MarkdownBlock & { type: "codeBlock" };
}) {
  return (
    <figure className="my-4 overflow-hidden rounded-lg border border-border/60 bg-muted/50">
      {block.language ? (
        // The label is shown, never used to pick a highlighter or build a class
        // name — it is author-supplied text like any other.
        <figcaption className="border-b border-border/60 px-3 py-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {block.language}
        </figcaption>
      ) : null}
      {/* The block scrolls itself. Letting a long line widen the article is how
          one code sample gives the whole page a horizontal scrollbar. */}
      <pre className="setu-scroll overflow-x-auto p-3">
        <code className="font-mono text-sm leading-relaxed">{block.value}</code>
      </pre>
    </figure>
  );
}

function Block({
  block,
  handlers,
}: {
  block: MarkdownBlock;
  handlers: InlineHandlers;
}) {
  switch (block.type) {
    case "heading":
      return <Heading block={block} handlers={handlers} />;

    case "paragraph": {
      const [only] = block.children;
      // A paragraph that is nothing but an image is a figure, not a line of
      // prose with something inline in it.
      if (block.children.length === 1 && only?.type === "image") {
        return (
          <figure className="my-5">
            <InlineNodes nodes={block.children} handlers={handlers} />
            {only.alt ? (
              <figcaption className="mt-1.5 text-center text-xs text-muted-foreground">
                {only.alt}
              </figcaption>
            ) : null}
          </figure>
        );
      }
      return (
        <p className={cn("my-4", wrapClass(inlineText(block.children)))}>
          <InlineNodes nodes={block.children} handlers={handlers} />
        </p>
      );
    }

    case "codeBlock":
      return <CodeBlock block={block} />;

    case "quote":
      return (
        <blockquote className="my-4 border-l-2 border-primary/50 pl-4 text-muted-foreground italic">
          {block.blocks.map((inner, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parsed blocks never reorder
            <Fragment key={`${inner.type}-${i}`}>
              <Block block={inner} handlers={handlers} />
            </Fragment>
          ))}
        </blockquote>
      );

    case "list":
      return <List list={block.list} handlers={handlers} />;

    case "rule":
      return <hr className="my-8 border-border/60" />;

    default: {
      const never: never = block;
      return <>{String(never)}</>;
    }
  }
}
