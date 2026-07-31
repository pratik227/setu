/**
 * Note-content tokenizer.
 *
 * One left-to-right scanner, one pass, one ordered token list. Not a chain of
 * regex replacements over the whole string. Stacked global regexes fail the same
 * way every time: one pattern rewrites text another pattern already claimed — a
 * hashtag inside a URL, a URL inside a code fence.
 *
 * The scanner holds a single invariant that makes those bugs unrepresentable:
 *
 *   tokenizeContent(s).map(t => t.value).join("") === s
 *
 * Every character of the input lands in exactly one token, in order. Fenced
 * code blocks are consumed whole, so their interior is never re-scanned, and
 * every non-text token must begin at a word boundary, so nothing can match in
 * the middle of a URL or an identifier.
 */

import { decodeAny, type Nip19Ref } from "./nip19";

/** A single ordered piece of note content. */
export type ContentToken =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "url"; readonly value: string; readonly url: string }
  | { readonly type: "image"; readonly value: string; readonly url: string }
  | { readonly type: "video"; readonly value: string; readonly url: string }
  | { readonly type: "hashtag"; readonly value: string; readonly tag: string }
  | {
      readonly type: "mention";
      readonly value: string;
      readonly entity: Nip19Ref;
    }
  | {
      readonly type: "lnInvoice";
      readonly value: string;
      readonly invoice: string;
    }
  | { readonly type: "lnurl"; readonly value: string; readonly lnurl: string }
  | { readonly type: "cashu"; readonly value: string; readonly token: string }
  | {
      readonly type: "code";
      readonly value: string;
      readonly code: string;
      readonly lang?: string;
    }
  | { readonly type: "newline"; readonly value: string };

/** Token discriminator, handy for switch exhaustiveness in renderers. */
export type ContentTokenType = ContentToken["type"];

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "bmp",
  "svg",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

/**
 * A token may only start here if the previous character cannot be part of a
 * word or a URL path. This is what stops `#tag` matching inside
 * `example.com/#tag` and `npub1…` matching inside `notanpub1…`.
 */
const WORD_CHAR = /[\p{L}\p{N}_/]/u;

// All patterns are sticky: they are anchored at the scanner's cursor, never
// searched for. `lastIndex` is assigned immediately before every use.
const URL_RE = /https?:\/\/[^\s<>"'`\p{Cc}]+/uy;
const NOSTR_URI_RE =
  /nostr:(?:npub|nsec|note|nprofile|nevent|naddr)1[a-z0-9]+/y;
const BARE_BECH32_RE = /(?:npub|note|nprofile|nevent|naddr)1[a-z0-9]+/y;
const HASHTAG_RE = /#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/uy;
const LEGACY_MENTION_RE = /#\[(\d+)\]/y;
const LN_INVOICE_RE = /ln(?:bcrt|bc|tbs|tb|sb)[0-9a-z]{25,}/iy;
const LNURL_RE = /lnurl1[a-z0-9]{10,}/iy;
const CASHU_RE = /cashu[AB][A-Za-z0-9_=-]{20,}/y;

const TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "'",
  '"',
  "*",
  "_",
  "~",
  "^",
  "…",
  "»",
]);

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function stickyMatch(
  re: RegExp,
  s: string,
  at: number,
): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(s);
}

function atWordBoundary(s: string, at: number): boolean {
  if (at === 0) return true;
  const prev = s[at - 1];
  return prev === undefined || !WORD_CHAR.test(prev);
}

function occurrences(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count++;
  }
  return count;
}

/**
 * Trim trailing characters that punctuate the sentence rather than belong to
 * the URL. Unbalanced closing brackets are dropped; balanced ones are kept, so
 * wiki-style links with parentheses survive.
 */
function trimUrlTail(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1] as string;
    if (TRAILING_PUNCTUATION.has(ch)) {
      end--;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener !== undefined) {
      const head = raw.slice(0, end);
      if (occurrences(head, opener) < occurrences(head, ch)) {
        end--;
        continue;
      }
    }
    break;
  }
  return raw.slice(0, end);
}

/** Classify a URL as image, video, or plain link by its path extension. */
export function classifyUrl(url: string): "url" | "image" | "video" {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return "url";
  const ext = path.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "url";
}

interface Match {
  readonly token: ContentToken;
  readonly next: number;
}

function readFence(s: string, at: number): Match {
  const close = s.indexOf("```", at + 3);
  const bodyEnd = close === -1 ? s.length : close;
  const end = close === -1 ? s.length : close + 3;
  const body = s.slice(at + 3, bodyEnd);
  const value = s.slice(at, end);

  const nl = body.indexOf("\n");
  if (nl >= 0) {
    const first = body.slice(0, nl).trim();
    // The opening fence's own line terminator is never part of the code.
    if (first.length === 0) {
      return {
        token: { type: "code", value, code: body.slice(nl + 1) },
        next: end,
      };
    }
    // A short, whitespace-free first line is an info string (the language);
    // anything else is the first line of the code itself.
    if (first.length <= 24 && !/\s/.test(first)) {
      return {
        token: {
          type: "code",
          value,
          code: body.slice(nl + 1),
          lang: first.toLowerCase(),
        },
        next: end,
      };
    }
  }
  return { token: { type: "code", value, code: body }, next: end };
}

function readUrl(s: string, at: number): Match | undefined {
  const m = stickyMatch(URL_RE, s, at);
  if (!m) return undefined;
  const url = trimUrlTail(m[0]);
  if (url.length === 0) return undefined;
  const kind = classifyUrl(url);
  return { token: { type: kind, value: url, url }, next: at + url.length };
}

/** Mentions never carry a secret key, even if one is pasted into a note. */
function mentionEntity(raw: string): Nip19Ref | undefined {
  const ref = decodeAny(raw);
  if (!ref || ref.type === "nsec") return undefined;
  return ref;
}

function readNostrUri(s: string, at: number): Match | undefined {
  const m = stickyMatch(NOSTR_URI_RE, s, at);
  if (!m) return undefined;
  const entity = mentionEntity(m[0]);
  if (!entity) return undefined;
  return {
    token: { type: "mention", value: m[0], entity },
    next: at + m[0].length,
  };
}

function readBareBech32(s: string, at: number): Match | undefined {
  const m = stickyMatch(BARE_BECH32_RE, s, at);
  if (!m) return undefined;
  const entity = mentionEntity(m[0]);
  if (!entity) return undefined;
  return {
    token: { type: "mention", value: m[0], entity },
    next: at + m[0].length,
  };
}

/**
 * Deprecated NIP-08 positional mention (`#[2]`), resolved against the event's
 * tags. Still common in pre-2023 history; without this those notes render as
 * literal `#[2]`.
 */
function readLegacyMention(
  s: string,
  at: number,
  tags: readonly (readonly string[])[] | undefined,
): Match | undefined {
  const m = stickyMatch(LEGACY_MENTION_RE, s, at);
  if (!m || !tags) return undefined;
  const index = Number(m[1]);
  const tag = tags[index];
  if (!tag) return undefined;
  const value = tag[1];
  if (value === undefined || value.length !== 64) return undefined;
  let entity: Nip19Ref | undefined;
  if (tag[0] === "p") entity = { type: "npub", pubkey: value };
  else if (tag[0] === "e") entity = { type: "note", id: value };
  if (!entity) return undefined;
  return {
    token: { type: "mention", value: m[0], entity },
    next: at + m[0].length,
  };
}

function readHashtag(s: string, at: number): Match | undefined {
  const m = stickyMatch(HASHTAG_RE, s, at);
  if (!m) return undefined;
  const tag = m[1];
  if (tag === undefined) return undefined;
  return {
    token: { type: "hashtag", value: m[0], tag },
    next: at + m[0].length,
  };
}

function readSimple(
  s: string,
  at: number,
  re: RegExp,
  make: (raw: string) => ContentToken,
): Match | undefined {
  const m = stickyMatch(re, s, at);
  if (!m) return undefined;
  return { token: make(m[0]), next: at + m[0].length };
}

function matchAt(
  s: string,
  at: number,
  tags: readonly (readonly string[])[] | undefined,
): Match | undefined {
  switch (s[at]) {
    case "#":
      return readLegacyMention(s, at, tags) ?? readHashtag(s, at);
    case "h":
      return readUrl(s, at);
    case "n":
      return readNostrUri(s, at) ?? readBareBech32(s, at);
    case "l":
    case "L":
      return (
        readSimple(s, at, LN_INVOICE_RE, (raw) => ({
          type: "lnInvoice",
          value: raw,
          invoice: raw,
        })) ??
        readSimple(s, at, LNURL_RE, (raw) => ({
          type: "lnurl",
          value: raw,
          lnurl: raw,
        }))
      );
    case "c":
      return readSimple(s, at, CASHU_RE, (raw) => ({
        type: "cashu",
        value: raw,
        token: raw,
      }));
    default:
      return undefined;
  }
}

/**
 * Tokenize note content into an ordered list of renderable tokens.
 *
 * `tags` is optional and only used to resolve deprecated `#[n]` positional
 * mentions; everything else is derived from the content itself.
 *
 * Guarantees:
 *  - the concatenation of every token's `value` equals `content` exactly;
 *  - consecutive plain text is coalesced into one `text` token;
 *  - fenced code blocks are opaque — nothing inside them is tokenized;
 *  - every non-text token starts at a word boundary.
 */
export function tokenizeContent(
  content: string,
  tags?: readonly (readonly string[])[],
): ContentToken[] {
  const tokens: ContentToken[] = [];
  let text = "";
  let i = 0;
  const n = content.length;

  const push = (token: ContentToken): void => {
    if (text.length > 0) {
      tokens.push({ type: "text", value: text });
      text = "";
    }
    tokens.push(token);
  };

  while (i < n) {
    const ch = content[i] as string;

    if (ch === "`" && content.startsWith("```", i)) {
      const fence = readFence(content, i);
      push(fence.token);
      i = fence.next;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      const value = ch === "\r" && content[i + 1] === "\n" ? "\r\n" : ch;
      push({ type: "newline", value });
      i += value.length;
      continue;
    }

    if (atWordBoundary(content, i)) {
      const match = matchAt(content, i, tags);
      if (match) {
        push(match.token);
        i = match.next;
        continue;
      }
    }

    text += ch;
    i++;
  }

  if (text.length > 0) tokens.push({ type: "text", value: text });
  return tokens;
}

/** Every image URL in the content, in order — the gallery input. */
export function imageUrls(tokens: readonly ContentToken[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token.type === "image") out.push(token.url);
  }
  return out;
}

/** Every pubkey/event referenced by a mention token, in order. */
export function mentionedRefs(tokens: readonly ContentToken[]): Nip19Ref[] {
  const out: Nip19Ref[] = [];
  for (const token of tokens) {
    if (token.type === "mention") out.push(token.entity);
  }
  return out;
}
