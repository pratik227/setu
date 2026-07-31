/**
 * NIP-92 `imeta` — the author's own description of the media a note links to.
 *
 * Worth decoding for one field above all others: `dim`. Without a declared size a
 * renderer reserves no space for an image, so every row below it moves the moment
 * the image decodes — a timeline being read jumps under the reader's eyes, once
 * per image, in whatever order the network happens to deliver them.
 *
 * Everything in an `imeta` tag is author-supplied and unverified: the URL, the
 * MIME type and the dimensions are all a stranger's string. So this module is
 * deliberately narrow. It decodes the tag and rejects values that cannot be used;
 * it does *not* decide whether a URL may be rendered (that is the caller's scheme
 * allowlist) and it does not clamp a ratio for layout (that is the renderer's,
 * because "usable number" and "usable box" are different questions).
 */

import { getTagged, type HasTags } from "./tags";

/** Intrinsic pixel size of a media file, as the author declared it. */
export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

/** One decoded `imeta` row. Only `url` is guaranteed. */
export interface ImetaEntry {
  readonly url: string;
  /** The `m` field, e.g. `image/webp`. */
  readonly mimeType?: string;
  readonly dim?: MediaDimensions;
  readonly alt?: string;
  readonly blurhash?: string;
  /**
   * The `image` field — a still frame for a video variant.
   *
   * NIP-71 puts a video's poster frame here rather than in a tag of its own, and it
   * is the only thing that lets a video tile show something before the reader
   * presses play. Untrusted like every other field: it is a URL heading for an
   * `src`, so the caller's image allowlist decides whether it may be rendered.
   */
  readonly image?: string;
}

/**
 * `<width>x<height>`, five digits per axis.
 *
 * Anchored and digits-only on purpose: it is the whole validation. `-1x2`,
 * `1.5x2`, `abcxdef`, `1x`, `1x2x3` and `100000x1` all fail to match, which is
 * the answer the renderer wants — reserve nothing rather than reserve something
 * absurd. Five digits is far above any real image and keeps the parsed numbers
 * inside a range that cannot surprise a layout calculation.
 */
const DIM = /^(\d{1,5})x(\d{1,5})$/;

/**
 * Pixel size from a NIP-92 `dim` value, or `undefined` when it is unusable.
 *
 * Total and strict — a malformed tag must degrade to "no declared size", never to
 * a broken box. A zero axis is the one case the syntax accepts and geometry does
 * not: `0x0` parses cleanly and yields an aspect ratio of `0` or `Infinity`, so
 * it is rejected here rather than being carried into a `style` attribute.
 */
export function parseDim(raw: string): MediaDimensions | undefined {
  const match = DIM.exec(raw.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) return undefined;
  return { width, height };
}

/**
 * Decode one `imeta` tag row.
 *
 * Each element after the tag name is a single space-delimited key/value pair, so
 * the split is on the *first* space only — an `alt` describing an image contains
 * spaces and splitting on all of them would truncate it to one word.
 *
 * Returns `undefined` for a row that names no URL: there is nothing such a row
 * could describe, and inventing an entry for it would put a media tile with no
 * source in the gallery.
 */
export function parseImetaTag(tag: readonly string[]): ImetaEntry | undefined {
  const fields = new Map<string, string>();
  for (let i = 1; i < tag.length; i += 1) {
    const part = tag[i];
    if (part === undefined) continue;
    const space = part.indexOf(" ");
    if (space <= 0) continue;
    const key = part.slice(0, space);
    // First occurrence wins. A duplicated key in one row is malformed, and
    // letting a later one overwrite would make the value depend on tag order.
    if (fields.has(key)) continue;
    fields.set(key, part.slice(space + 1).trim());
  }

  const url = fields.get("url");
  if (url === undefined || url === "") return undefined;

  const rawDim = fields.get("dim");
  const dim = rawDim === undefined ? undefined : parseDim(rawDim);
  const mimeType = fields.get("m");
  const alt = fields.get("alt");
  const blurhash = fields.get("blurhash");
  const image = fields.get("image");

  return {
    url,
    ...(mimeType ? { mimeType } : {}),
    ...(dim ? { dim } : {}),
    ...(alt ? { alt } : {}),
    ...(blurhash ? { blurhash } : {}),
    ...(image ? { image } : {}),
  };
}

/** Every usable `imeta` row on an event, in tag order. */
export function parseImeta(event: HasTags): readonly ImetaEntry[] {
  const out: ImetaEntry[] = [];
  for (const tag of getTagged(event, "imeta")) {
    const entry = parseImetaTag(tag);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}
