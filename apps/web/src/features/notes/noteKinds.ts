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
 * NIP-22 comments, highlights (a curated Explore feed) and long-form articles
 * (the Reads timeline). Anything outside it cannot be opened as a thread today, so
 * excluding it costs nothing; if a new surface renders a new kind, it belongs here
 * rather than in a filter of its own.
 */

import { Kind } from "@setu/protocol";

export const NOTE_TARGET_KINDS: readonly number[] = [
  Kind.ShortTextNote,
  Kind.Repost,
  Kind.GenericRepost,
  Kind.Comment,
  Kind.Highlight,
  Kind.LongFormArticle,
];
