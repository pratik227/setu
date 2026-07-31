/**
 * The kinds this app renders as a note, and therefore the kinds an id-scoped
 * query has to name.
 *
 * A filter that omits `kinds` is not a smaller filter, it is a broader one: `{ids:
 * [...]}` asks a relay for events of *any* kind, which some relays gate or answer
 * from a slower path, and it also means an event of a kind we cannot render can
 * still be served, verified and stored. Naming the kinds keeps the query narrow and
 * says out loud what the caller can actually do with the answer.
 *
 * The list is everything a reader can reach: feed notes, both repost forms,
 * NIP-22 comments, highlights (a curated Explore feed), long-form articles (the
 * Reads timeline), NIP-68 pictures, NIP-71 videos and NIP-88 polls. Anything
 * outside it cannot be opened as a thread today, so excluding it costs nothing; if
 * a new surface renders a new kind, it belongs here rather than in a filter of its
 * own.
 */

import { Kind } from "@setu/protocol";

export const NOTE_TARGET_KINDS: readonly number[] = [
  Kind.ShortTextNote,
  Kind.Repost,
  Kind.GenericRepost,
  Kind.Picture,
  Kind.Video,
  Kind.ShortVideo,
  Kind.Poll,
  Kind.Comment,
  Kind.Highlight,
  Kind.LongFormArticle,
];

/**
 * Kinds whose media is the post rather than an attachment to it.
 *
 * The distinction is structural, not cosmetic. A kind-1 with an image URL in its
 * body reads text-first: the sentence introduces the picture, so the picture
 * belongs under it. A NIP-68 picture post and a NIP-71 video put the media in
 * `imeta` tags and use the content as a *caption*, so rendering it in kind-1 order
 * puts the caption above an image it is describing from behind — and for a video
 * event with an empty content field, it puts an empty paragraph above the player.
 */
const MEDIA_FIRST_KINDS: ReadonlySet<number> = new Set([
  Kind.Picture,
  Kind.Video,
  Kind.ShortVideo,
]);

/** True for a kind that renders its media above its text. */
export function isMediaFirstKind(kind: number): boolean {
  return MEDIA_FIRST_KINDS.has(kind);
}

/**
 * Kinds whose specification gives a `title` tag a defined meaning.
 *
 * An allowlist rather than "render a `title` tag if there is one". `title` is not
 * reserved, and a kind-1 note that carries one — a client's own metadata, a
 * republished article stub, anything — would get a heading it never asked for,
 * rendered above its body in bold as if the author had written it.
 */
const TITLED_KINDS: ReadonlySet<number> = new Set([
  Kind.Picture,
  Kind.Video,
  Kind.ShortVideo,
  Kind.LongFormArticle,
]);

/** True when a `title` tag on this kind means what a heading means. */
export function isTitledKind(kind: number): boolean {
  return TITLED_KINDS.has(kind);
}
