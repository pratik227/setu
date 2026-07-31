/**
 * The inline scanner.
 *
 * One left-to-right pass with an explicit cursor, not a chain of regex
 * replacements over the whole string. Stacked global regexes fail the same way
 * every time: one pattern rewrites text another pattern already claimed — an
 * asterisk inside a code span, a bracket inside a URL. A single cursor makes the
 * precedence explicit and gives code spans a way to be genuinely opaque, which is
 * what keeps `[link](x)` inside backticks from becoming a link.
 *
 * Every destination passes through `markdownUrl` before a node is built, so an
 * unsafe URL has no representation in the output at all.
 */

import type { MarkdownInline } from "./markdownTypes";
import {
  ALLOWED_LINK_SCHEMES,
  sanitizeImageUrl,
  sanitizeUrl,
} from "./markdownUrl";

/** Characters a backslash may escape. Anything else keeps its backslash. */
const ESCAPABLE = new Set([
  "\\",
  "`",
  "*",
  "_",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "#",
  "+",
  "-",
  ".",
  "!",
  ">",
  "~",
  "|",
]);

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** Push text onto the list, merging with a trailing text node. */
function pushText(out: MarkdownInline[], value: string): void {
  if (value === "") return;
  const last = out[out.length - 1];
  if (last && last.type === "text") {
    out[out.length - 1] = { type: "text", value: last.value + value };
    return;
  }
  out.push({ type: "text", value });
}

/** Run length of the same character starting at `at`. */
function runLength(s: string, at: number): number {
  const ch = s[at];
  let n = 0;
  while (s[at + n] === ch) n++;
  return n;
}

/**
 * Index of the matching closing delimiter run, or -1.
 *
 * Escaped delimiters and the interiors of code spans are skipped, so
 * `*a `*` b*` closes at the final `*` rather than the one inside the span.
 */
function findCloser(
  s: string,
  from: number,
  delim: string,
  intrawordSafe: boolean,
): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      const ticks = runLength(s, i);
      const close = s.indexOf("`".repeat(ticks), i + ticks);
      i = close === -1 ? s.length : close + ticks - 1;
      continue;
    }
    if (!s.startsWith(delim, i)) continue;
    // A closer may not be preceded by whitespace — `a * b` is not emphasis.
    if (/\s/.test(s[i - 1] ?? " ")) continue;
    // `_` may not close inside a word, so `a_b_c` stays literal.
    if (intrawordSafe && isWordChar(s[i + delim.length])) continue;
    return i;
  }
  return -1;
}

/**
 * Index of the matching `]`/`)`, accounting for nesting and escapes, or -1.
 */
function findBalanced(
  s: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a link destination from its optional title: `url "title"` or `<url>`.
 * The title is dropped — a `title` attribute on a stranger's link is a tooltip
 * we cannot vouch for and it is not part of the reading experience.
 */
function linkDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  const space = trimmed.search(/[ \t]/);
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

/** Flatten inline nodes back to their text, for image alt and excerpts. */
export function inlineText(nodes: readonly MarkdownInline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "code":
        out += node.value;
        break;
      case "break":
        out += " ";
        break;
      case "image":
        out += node.alt;
        break;
      default:
        out += inlineText(node.children);
        break;
    }
  }
  return out;
}

interface InlineContext {
  /** Inside a link: nested links and images are flattened to text. */
  readonly inLink: boolean;
}

export function parseInline(
  source: string,
  context: InlineContext = { inLink: false },
): readonly MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i] as string;

    if (ch === "\\") {
      const next = source[i + 1];
      if (next === "\n") {
        out.push({ type: "break" });
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.has(next)) {
        pushText(out, next);
        i += 2;
        continue;
      }
      pushText(out, ch);
      i++;
      continue;
    }

    if (ch === "\n") {
      // Two or more trailing spaces mean an explicit break; a lone newline is a
      // soft break, which per CommonMark renders as a space rather than a `<br>`.
      const last = out[out.length - 1];
      if (last?.type === "text" && / {2}$/.test(last.value)) {
        out[out.length - 1] = { type: "text", value: last.value.trimEnd() };
        out.push({ type: "break" });
      } else {
        pushText(out, " ");
      }
      i++;
      continue;
    }

    if (ch === "`") {
      const ticks = runLength(source, i);
      const close = source.indexOf("`".repeat(ticks), i + ticks);
      if (close !== -1) {
        // Code spans are opaque: their interior is never re-scanned, which is
        // what makes a fence containing `#` or `[x](y)` inert.
        out.push({ type: "code", value: source.slice(i + ticks, close) });
        i = close + ticks;
        continue;
      }
      pushText(out, "`".repeat(ticks));
      i += ticks;
      continue;
    }

    if (ch === "!" && source[i + 1] === "[") {
      const altEnd = findBalanced(source, i + 2, "[", "]");
      if (altEnd !== -1 && source[altEnd + 1] === "(") {
        const destEnd = findBalanced(source, altEnd + 2, "(", ")");
        if (destEnd !== -1) {
          const alt = inlineText(parseInline(source.slice(i + 2, altEnd)));
          const src = sanitizeImageUrl(
            linkDestination(source.slice(altEnd + 2, destEnd)),
          );
          if (src === undefined || context.inLink) {
            // A rejected source degrades to its alt text: the words the author
            // wrote survive, the resource load does not happen.
            pushText(out, alt);
          } else {
            out.push({ type: "image", src, alt });
          }
          i = destEnd + 1;
          continue;
        }
      }
    }

    if (ch === "[" && !context.inLink) {
      const labelEnd = findBalanced(source, i + 1, "[", "]");
      if (labelEnd !== -1 && source[labelEnd + 1] === "(") {
        const destEnd = findBalanced(source, labelEnd + 2, "(", ")");
        if (destEnd !== -1) {
          const label = source.slice(i + 1, labelEnd);
          const children = parseInline(label, { inLink: true });
          const href = sanitizeUrl(
            linkDestination(source.slice(labelEnd + 2, destEnd)),
            ALLOWED_LINK_SCHEMES,
          );
          if (href === undefined) {
            // Inert: the label's words are kept, unwrapped, with no `href`
            // anywhere. Nothing here is clickable.
            for (const child of children) {
              if (child.type === "text") pushText(out, child.value);
              else out.push(child);
            }
          } else {
            out.push({ type: "link", href, children });
          }
          i = destEnd + 1;
          continue;
        }
      }
    }

    if (ch === "~" && source.startsWith("~~", i)) {
      const close = findCloser(source, i + 2, "~~", false);
      if (close !== -1) {
        out.push({
          type: "strike",
          children: parseInline(source.slice(i + 2, close), context),
        });
        i = close + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const node = parseEmphasis(source, i, ch, context);
      if (node) {
        out.push(node.node);
        i = node.next;
        continue;
      }
    }

    pushText(out, ch);
    i++;
  }

  return out;
}

/** Emphasis at `at`, or undefined when the delimiter never closes. */
function parseEmphasis(
  source: string,
  at: number,
  marker: "*" | "_",
  context: InlineContext,
): { node: MarkdownInline; next: number } | undefined {
  const intrawordSafe = marker === "_";
  // `_` may not open inside a word: `snake_case` is an identifier, not emphasis.
  if (intrawordSafe && isWordChar(source[at - 1])) return undefined;
  const run = Math.min(runLength(source, at), 3);
  // An opener may not be followed by whitespace — `a * b` is a lone asterisk.
  if (/\s/.test(source[at + run] ?? " ")) return undefined;

  const delim = marker.repeat(run);
  const close = findCloser(source, at + run, delim, intrawordSafe);
  if (close === -1) return undefined;

  const inner = parseInline(source.slice(at + run, close), context);
  const next = close + run;
  if (run === 1) return { node: { type: "em", children: inner }, next };
  if (run === 2) return { node: { type: "strong", children: inner }, next };
  return {
    node: { type: "strong", children: [{ type: "em", children: inner }] },
    next,
  };
}
