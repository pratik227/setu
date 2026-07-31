/**
 * The media a note displays, with the author's declared dimensions attached.
 *
 * Two sources, and both are needed. A bare image URL in the body is the older and
 * still overwhelmingly commonest convention; a NIP-92 `imeta` tag is the author's
 * explicit declaration and the only place a *size* comes from. Reading only the
 * tags would drop the images in every note written by a client that does not emit
 * them; reading only the body would throw away the one field that stops the
 * timeline jumping.
 *
 * So the body decides the order and the tags decorate it, and an `imeta` URL the
 * body never linked is appended rather than dropped — an author who attached a
 * file and then edited the URL out of the text still meant to attach it.
 */

import {
  classifyUrl,
  type HasTags,
  type ImetaEntry,
  parseImeta,
  tokenizeContent,
} from "@setu/protocol";
import { sanitizeImageUrl } from "../articles/markdownUrl";
import type { MediaView } from "./types";

/**
 * Widest and tallest box we will reserve, as width/height.
 *
 * `dim` is a stranger's string, and both extremes are hostile in their own way.
 * `1x99999` is a syntactically perfect ratio and a box ten thousand screens tall —
 * one note that owns the entire timeline. `99999x1` is the mirror image: a box a
 * fraction of a pixel high, which reads as the image having failed to load. A
 * declared shape outside this range is reserved in the nearest usable one and the
 * image is cropped by `object-cover`, which is what an over-tall image already
 * gets today.
 *
 * The bounds are set by real content: `0.5` is taller than a 9:16 phone photo
 * (0.5625), `3` is wider than a panorama crop.
 */
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 3;

/**
 * CSS `aspect-ratio` value for a media box, or `undefined` to reserve nothing.
 *
 * Undefined is the honest answer when the author declared no size: a guessed
 * ratio is a box of the wrong shape, which jumps exactly as much as no box at all
 * but also crops the image while it does so.
 */
export function reservedAspectRatio(media: MediaView): number | undefined {
  const { width, height } = media;
  if (width === undefined || height === undefined) return undefined;
  if (width < 1 || height < 1) return undefined;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, width / height));
}

/**
 * Image or video, from the MIME type when the author gave one.
 *
 * Falls back to extension sniffing, because a great many media URLs are opaque
 * (`/files/9f3a…`) and the `m` field is the only thing that distinguishes a video
 * from an image there — rendering a video into an `<img>` shows a broken icon.
 */
function kindOf(entry: ImetaEntry): "image" | "video" | undefined {
  if (entry.mimeType?.startsWith("image/")) return "image";
  if (entry.mimeType?.startsWith("video/")) return "video";
  const classified = classifyUrl(entry.url);
  return classified === "url" ? undefined : classified;
}

function withDeclared(
  url: string,
  kind: "image" | "video",
  entry: ImetaEntry | undefined,
): MediaView {
  return {
    url,
    kind,
    ...(entry?.dim ? { width: entry.dim.width, height: entry.dim.height } : {}),
    ...(entry?.alt ? { alt: entry.alt } : {}),
  };
}

/**
 * Media views for one event, or `undefined` when it shows none.
 *
 * `undefined` rather than an empty array so a caller can distinguish "this note
 * has no media" from "media has not been resolved yet" — and so text-only notes
 * carry no extra field at all.
 *
 * Every URL passes the image-source allowlist first. Body URLs arrive from the
 * tokenizer already `http(s)`, but an `imeta` URL is raw author text and lands
 * straight in a `src` attribute, which is exactly the position a `javascript:` or
 * `data:image/svg+xml` payload wants to be in.
 */
export function noteMediaViews(
  event: HasTags & { readonly content: string },
): readonly MediaView[] | undefined {
  const declared = new Map<string, ImetaEntry>();
  for (const entry of parseImeta(event)) {
    const safe = sanitizeImageUrl(entry.url);
    if (safe === undefined) continue;
    // First declaration wins, matching `parseImetaTag`: two rows for one URL is
    // malformed, and picking the later one makes the size depend on tag order.
    if (!declared.has(safe)) declared.set(safe, entry);
  }

  const out: MediaView[] = [];
  const seen = new Set<string>();

  for (const token of tokenizeContent(event.content)) {
    if (token.type !== "image" && token.type !== "video") continue;
    const safe = sanitizeImageUrl(token.url);
    if (safe === undefined || seen.has(safe)) continue;
    seen.add(safe);
    out.push(withDeclared(safe, token.type, declared.get(safe)));
  }

  for (const [url, entry] of declared) {
    if (seen.has(url)) continue;
    const kind = kindOf(entry);
    // An `imeta` row that describes neither an image nor a video is metadata for
    // something this renderer has no tile for; a URL with no extension and no `m`
    // field is most often an ordinary link the author also tagged.
    if (kind === undefined) continue;
    seen.add(url);
    out.push(withDeclared(url, kind, entry));
  }

  return out.length > 0 ? out : undefined;
}
