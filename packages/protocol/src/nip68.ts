/**
 * NIP-68 picture-first posts (kind 20).
 *
 * The one structural difference from a kind-1 with an image in it, and the reason
 * a renderer cannot treat the two the same: **the media is not in the content.** A
 * kind-20's `imeta` tags are the post, and its content is a caption *about* the
 * post. A renderer that only looks for URLs in the body — which is what works for
 * kind 1 — shows a caption with nothing above it and drops the picture entirely.
 *
 * So this module answers two questions and nothing else: is this event a picture
 * post, and which `imeta` rows are its pictures. Whether a given URL may be put in
 * an `src` is the caller's allowlist decision, exactly as in `nip92.ts`; sizing and
 * layout are the renderer's.
 */

import { Kind } from "./kinds";
import { type ImetaEntry, parseImeta } from "./nip92";
import { getTagValue } from "./tags";
import type { NostrEvent } from "./types";

/** A decoded kind-20. */
export interface PicturePost {
  /** The `title` tag, when the author wrote one. */
  readonly title?: string;
  /** The event's content: a caption, not the media. */
  readonly description: string;
  /**
   * The pictures, in tag order. Never empty — a kind-20 with no usable `imeta`
   * row is not a picture post, and {@link parsePicture} rejects it rather than
   * returning an empty gallery for the renderer to puzzle over.
   */
  readonly pictures: readonly ImetaEntry[];
}

/**
 * Decode a picture post, or `undefined` when the event is not one.
 *
 * Rejecting a kind-20 that declares no media is deliberate. The alternative is a
 * row that renders a caption under an empty frame, which reads as an image that
 * failed to load — and the honest reading is that whatever produced the event was
 * not making a picture post at all.
 *
 * Rows whose MIME type says `video/…` are kept rather than filtered: NIP-68 is
 * about pictures, but the author's `m` field is what the renderer switches on, and
 * silently dropping a row here would lose media the author attached.
 */
export function parsePicture(event: NostrEvent): PicturePost | undefined {
  if (event.kind !== Kind.Picture) return undefined;
  const pictures = parseImeta(event);
  if (pictures.length === 0) return undefined;
  const title = getTagValue(event, "title");
  return {
    ...(title ? { title } : {}),
    description: event.content,
    pictures,
  };
}
