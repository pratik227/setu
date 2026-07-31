/**
 * NIP-30 custom emoji — `:shortcode:` in content, resolved against `emoji` tags.
 *
 * The shape is `["emoji", "<shortcode>", "<image url>"]`, and a `:shortcode:` in
 * the content of that same event (or in a kind-7's content, which is how a custom
 * emoji reaction works) renders as the image.
 *
 * Two decisions here are what keep the renderer honest:
 *
 * 1. **Splitting takes the set of known shortcodes as input.** The alternative —
 *    find every `:word:` and then look each one up — makes "unresolvable" a case
 *    the renderer has to remember to handle, and the failure mode when it forgets
 *    is a broken-image icon in the middle of a sentence. Splitting against a known
 *    set means an unresolvable shortcode was never a token at all: it stays inside
 *    a text segment and renders as the literal characters the author typed, which
 *    is what a reader on a client with no custom-emoji support sees anyway.
 * 2. **The URL is returned exactly as published.** It is a stranger's string
 *    heading for an `src` attribute, and this module does not decide whether it may
 *    be rendered — that is the caller's image allowlist, the same split `nip92.ts`
 *    makes. Validating it here would put two allowlists in the codebase and let
 *    them disagree.
 */

import { getTagged, type HasTags } from "./tags";

/**
 * Shortcodes are alphanumerics and underscores, per NIP-30.
 *
 * Anchored and total: a tag whose shortcode contains a colon, a space or a dash
 * could never be matched in content by any scanner that treats `:` as the
 * delimiter, so accepting it would put an entry in the map that can only ever be
 * dead weight — and a shortcode containing `:` would make the delimiters
 * ambiguous for every *other* code in the same note.
 */
const SHORTCODE = /^[a-zA-Z0-9_]+$/;

/** How many custom emoji one event may declare. */
const MAX_EMOJI = 64;

/**
 * `shortcode -> image URL` for one event, first declaration winning.
 *
 * First-wins matches `parseImetaTag`: a duplicated shortcode is malformed, and
 * letting the later row overwrite would make which image renders depend on tag
 * order — so the same note could show different emoji on two clients.
 */
export function emojiTagMap(event: HasTags): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const tag of getTagged(event, "emoji")) {
    if (out.size >= MAX_EMOJI) break;
    const code = tag[1];
    const url = tag[2];
    if (code === undefined || url === undefined || url === "") continue;
    if (!SHORTCODE.test(code) || out.has(code)) continue;
    out.set(code, url);
  }
  return out;
}

/** One piece of text, or one resolved custom emoji. */
export type EmojiSegment =
  | { readonly type: "text"; readonly value: string }
  | {
      readonly type: "emoji";
      /** The literal `:shortcode:` as written, for the image's alt text. */
      readonly value: string;
      readonly shortcode: string;
    };

/**
 * Sticky, so it is anchored at the scanner's cursor rather than searched for.
 *
 * The same discipline as the content tokenizer: a global search would let a match
 * start anywhere, including inside a URL path the caller has already claimed.
 */
const AT_SHORTCODE = /:([a-zA-Z0-9_]+):/y;

/**
 * Split text into literal runs and custom-emoji tokens.
 *
 * Only shortcodes in `known` become tokens. Everything else — including a
 * `:word:` that looks exactly like a shortcode but has no `emoji` tag — is left in
 * the text, so the concatenation of every segment's `value` equals `text` exactly.
 * That invariant is the one worth holding onto: it means this function can never
 * lose or duplicate a character of what the author wrote, whatever the tags say.
 *
 * Returns an empty array for empty input, and a single text segment when nothing
 * matched, so a caller can cheaply detect "nothing to do" by length.
 */
export function emojiSegments(
  text: string,
  known: ReadonlySet<string>,
): readonly EmojiSegment[] {
  if (text === "" || known.size === 0) {
    return text === "" ? [] : [{ type: "text", value: text }];
  }

  const out: EmojiSegment[] = [];
  let pending = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] !== ":") {
      pending += text[i];
      i += 1;
      continue;
    }
    AT_SHORTCODE.lastIndex = i;
    const match = AT_SHORTCODE.exec(text);
    const code = match?.[1];
    if (match === null || code === undefined || !known.has(code)) {
      // Not a shortcode we can resolve: the colon is ordinary punctuation and
      // stays in the text run, which is what makes an unknown code render
      // literally instead of as a broken image.
      pending += ":";
      i += 1;
      continue;
    }
    if (pending !== "") {
      out.push({ type: "text", value: pending });
      pending = "";
    }
    out.push({ type: "emoji", value: match[0], shortcode: code });
    i += match[0].length;
  }

  if (pending !== "") out.push({ type: "text", value: pending });
  return out;
}

/**
 * True when `content` is nothing but one custom emoji.
 *
 * The test a reaction row needs: a kind-7 whose whole content is `:shortcode:` is
 * a custom emoji reaction and should render as the image alone. Trimmed, because
 * a trailing newline from a composer does not change what the reaction is.
 */
export function isSoleShortcode(
  content: string,
  known: ReadonlySet<string>,
): string | undefined {
  const segments = emojiSegments(content.trim(), known);
  const only = segments.length === 1 ? segments[0] : undefined;
  return only?.type === "emoji" ? only.shortcode : undefined;
}
