/**
 * A Markdown subset, parsed to a tree.
 *
 * NIP-23 says an article's content is Markdown, which leaves a client holding
 * arbitrary text from a stranger and a decision about how to display it. The
 * decision here is structural rather than defensive:
 *
 * **Parsing produces a tree of data, never a string of HTML.** There is no
 * `dangerouslySetInnerHTML` anywhere downstream and no HTML is ever assembled,
 * so there is no string for an injected `<script>` or `<img onerror=…>` to be
 * spliced into. The renderer walks this tree and creates React elements, which
 * escape their text children by construction. That makes markup injection
 * *unrepresentable* instead of merely filtered — the usual approach is to render
 * HTML and then sanitize it, which is a blocklist race against every parser
 * quirk in every browser.
 *
 * The two remaining holes a tree cannot close on its own are URLs and resource
 * loads, because those are attributes rather than markup. Both are handled by
 * allowlist in `markdownUrl.ts`; a rejected destination becomes inert text.
 *
 * Raw HTML in the source is **not** interpreted. An article containing
 * `<b>hi</b>` shows those characters literally. That is a deliberate departure
 * from CommonMark: supporting inline HTML would mean re-opening exactly the hole
 * the tree closes.
 *
 * Where this subset deviates from CommonMark, on purpose:
 *
 *  - A heading requires a space after the hashes (`# Title`, not `#Title`), so a
 *    line that is only a hashtag stays a hashtag rather than becoming an `<h1>`.
 *  - `_` will not open emphasis inside a word, so `snake_case_name` survives.
 *  - Lists nest one level. Deeper indentation folds into that level rather than
 *    building an arbitrarily deep tree from arbitrary input.
 *  - Link reference definitions, setext headings, tables and footnotes are not
 *    supported. They are absent rather than half-working.
 *
 * The feature is split four ways so no one file owns all of it: `markdownTypes`
 * holds the AST, `markdownInlineParse` the inline scanner, `markdownWrap` the
 * wrapping decision, and this file the block parser and the public entry point.
 */

import { inlineText, parseInline } from "./markdownInlineParse";
import type { MarkdownBlock, MarkdownList } from "./markdownTypes";

export { inlineText } from "./markdownInlineParse";
export type {
  MarkdownBlock,
  MarkdownInline,
  MarkdownList,
  MarkdownListItem,
} from "./markdownTypes";

/**
 * Longest source we will parse. An article is prose; a ten-megabyte body is
 * either a mistake or an attempt to make one reader's tab the cost of one
 * relay's bandwidth. Beyond this the tail is dropped rather than parsed.
 */
export const MAX_MARKDOWN_LENGTH = 400_000;

/** Deepest blockquote nesting. Past this, `>` lines are literal text. */
const MAX_QUOTE_DEPTH = 4;

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
/** Closing sequence of an ATX heading: `## Title ##`. */
const HEADING_TAIL = /[ \t]+#+$/;

/** Indentation, in columns, treating a tab as two columns. */
function indentWidth(raw: string): number {
  let width = 0;
  for (const ch of raw) width += ch === "\t" ? 2 : 1;
  return width;
}

/** True when a line opens a block and therefore ends any open paragraph. */
function startsBlock(line: string): boolean {
  if (line.trim() === "") return true;
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

/** Parse Markdown into blocks. Malformed or empty input yields `[]`. */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  if (typeof source !== "string" || source === "") return [];
  const normalized = source
    .slice(0, MAX_MARKDOWN_LENGTH)
    .replace(/\r\n?/g, "\n");
  return parseBlocks(normalized.split("\n"), 0);
}

function parseBlocks(
  lines: readonly string[],
  depth: number,
): readonly MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const consumed = readFence(lines, i, fence[1] as string, fence[2] ?? "");
      blocks.push(consumed.block);
      i = consumed.next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = (heading[2] ?? "").replace(HEADING_TAIL, "");
      blocks.push({ type: "heading", level, children: parseInline(text) });
      i++;
      continue;
    }

    // Before lists: `- - -` matches a bullet whose content is `- -`.
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line) && depth < MAX_QUOTE_DEPTH) {
      const consumed = readQuote(lines, i, depth);
      blocks.push(consumed.block);
      i = consumed.next;
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const consumed = readList(lines, i);
      blocks.push({ type: "list", list: consumed.list });
      i = consumed.next;
      continue;
    }

    // Paragraph: everything up to a blank line or the next block opener.
    const start = i;
    i++;
    while (i < lines.length && !startsBlock(lines[i] as string)) i++;
    // Leading indent is dropped, trailing spaces are not: two of them at the end
    // of a line are the only way Markdown spells an explicit line break.
    const text = lines
      .slice(start, i)
      .map((l) => l.replace(/^[ \t]+/, ""))
      .join("\n")
      .replace(/[ \t]+$/, "");
    const children = parseInline(text);
    if (children.length > 0) blocks.push({ type: "paragraph", children });
  }

  return blocks;
}

/**
 * A fenced code block. An unclosed fence runs to the end of the document rather
 * than being discarded — the author's code is the content either way, and
 * dropping it would make one missing backtick delete the rest of an article.
 */
function readFence(
  lines: readonly string[],
  at: number,
  fence: string,
  info: string,
): { block: MarkdownBlock; next: number } {
  const marker = fence[0] as string;
  const body: string[] = [];
  let i = at + 1;
  while (i < lines.length) {
    const line = lines[i] as string;
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (
      closing &&
      (closing[1] as string)[0] === marker &&
      (closing[1] as string).length >= fence.length
    ) {
      i++;
      break;
    }
    body.push(line);
    i++;
  }
  // The info string is a label only. It is never used to select a highlighter
  // or to build a class name from user input.
  const language = info.trim().slice(0, 24);
  return {
    block: {
      type: "codeBlock",
      ...(language ? { language } : {}),
      value: body.join("\n"),
    },
    next: i,
  };
}

function readQuote(
  lines: readonly string[],
  at: number,
  depth: number,
): { block: MarkdownBlock; next: number } {
  const inner: string[] = [];
  let i = at;
  while (i < lines.length) {
    const line = lines[i] as string;
    const quoted = QUOTE.exec(line);
    if (quoted) {
      inner.push(quoted[1] ?? "");
      i++;
      continue;
    }
    // Lazy continuation: a plain line directly under a quote belongs to it.
    if (line.trim() !== "" && !startsBlock(line)) {
      inner.push(line);
      i++;
      continue;
    }
    break;
  }
  return {
    block: { type: "quote", blocks: parseBlocks(inner, depth + 1) },
    next: i,
  };
}

interface MutableItem {
  raw: string;
  sublist?: { ordered: boolean; start: number; items: string[] };
}

/**
 * A list, with one level of nesting.
 *
 * Indentation of two columns or more attaches the item to the current item's
 * sublist. Deeper indentation folds into that same level rather than recursing:
 * the input is arbitrary, and an arbitrarily deep tree from arbitrary input is a
 * rendering cost with no reading benefit.
 */
function readList(
  lines: readonly string[],
  at: number,
): { list: MarkdownList; next: number } {
  const first =
    BULLET.exec(lines[at] as string) ?? ORDERED.exec(lines[at] as string);
  const ordered =
    ORDERED.test(lines[at] as string) && !BULLET.test(lines[at] as string);
  const start = ordered ? Number.parseInt(first?.[2] ?? "1", 10) : 1;
  const items: MutableItem[] = [];
  let i = at;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (line.trim() === "") {
      // One blank line inside a list is a loose list; two end it. So does a
      // switch of marker kind: `- a` then `1. b` is two lists, and merging them
      // would renumber the second one under the first one's bullets.
      const next = lines[i + 1];
      const continues =
        next !== undefined &&
        (BULLET.test(next) ? !ordered : ORDERED.test(next) && ordered);
      if (continues) {
        i++;
        continue;
      }
      break;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : ORDERED.exec(line);
    const match = bullet ?? numbered;
    if (match) {
      // A marker of the other kind at the top level starts a new list.
      const indent = indentWidth(match[1] ?? "");
      if (indent < 2 && (numbered !== null) !== ordered) break;
      const text = match[3] ?? "";
      const current = items[items.length - 1];
      if (indent >= 2 && current) {
        const sub = current.sublist ?? {
          ordered: numbered !== null,
          start: numbered ? Number.parseInt(match[2] ?? "1", 10) : 1,
          items: [],
        };
        sub.items.push(text);
        current.sublist = sub;
      } else {
        items.push({ raw: text });
      }
      i++;
      continue;
    }

    if (startsBlock(line)) break;

    // Lazy continuation of the current item.
    const current = items[items.length - 1];
    if (!current) break;
    const sub = current.sublist;
    if (sub && sub.items.length > 0) {
      sub.items[sub.items.length - 1] = `${
        sub.items[sub.items.length - 1] as string
      }\n${line.trim()}`;
    } else {
      current.raw = `${current.raw}\n${line.trim()}`;
    }
    i++;
  }

  return {
    list: {
      ordered,
      start: Number.isFinite(start) ? start : 1,
      items: items.map((item) => ({
        children: parseInline(item.raw),
        ...(item.sublist
          ? {
              sublist: {
                ordered: item.sublist.ordered,
                start: item.sublist.start,
                items: item.sublist.items.map((raw) => ({
                  children: parseInline(raw),
                })),
              },
            }
          : {}),
      })),
    },
    next: i,
  };
}

/**
 * Plain-text rendering of a Markdown body, for excerpts and previews.
 *
 * Goes through the parser rather than stripping syntax with regexes, so what an
 * excerpt shows is derived from the same tree the reader sees. A regex-stripped
 * excerpt drifts from the rendered body the first time either changes.
 */
export function markdownToPlainText(source: string, limit = 400): string {
  const parts: string[] = [];
  const walk = (blocks: readonly MarkdownBlock[]): void => {
    for (const block of blocks) {
      if (parts.join(" ").length > limit) return;
      switch (block.type) {
        case "heading":
        case "paragraph":
          parts.push(inlineText(block.children));
          break;
        case "codeBlock":
          break;
        case "quote":
          walk(block.blocks);
          break;
        case "list":
          for (const item of block.list.items) {
            parts.push(inlineText(item.children));
          }
          break;
        case "rule":
          break;
        default: {
          const never: never = block;
          void never;
          break;
        }
      }
    }
  };
  walk(parseMarkdown(source));
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, limit);
}
