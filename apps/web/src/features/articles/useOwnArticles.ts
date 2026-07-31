import { useMemo } from "react";
import { useStoreEvents } from "../discover/useStoreEvents";
import { type ArticleRow, toArticleRows } from "./articleViews";
import { ARTICLE_DRAFT_KIND, ARTICLE_KIND } from "./buildArticle";

/**
 * How many of the author's own articles to hold live.
 *
 * A bound is not optional on a live query, but this one is generous: unlike a
 * kind-1 feed, the ceiling here is how much one person has written, and a writer
 * with two hundred articles should still see all of them.
 */
const LIMIT = 400;

export interface OwnArticles {
  /** Kind 30024, newest first. */
  readonly drafts: readonly ArticleRow[];
  /** Kind 30023, newest first. */
  readonly published: readonly ArticleRow[];
}

const EMPTY: OwnArticles = { drafts: [], published: [] };

/**
 * The signed-in author's own articles, drafts and published together.
 *
 * **One filter covering both kinds, not two.** They are read the same way, from
 * the same author, at the same moment the screen opens; a second observer and a
 * second REQ would spend a relay subscription slot to split a list that is
 * partitioned locally in a single pass. Relays cap concurrent subscriptions, and
 * a screen that opens two where one would do is how a client reaches that cap.
 *
 * Subscription is skipped entirely when there is no pubkey. A REQ with an empty
 * `authors` array asks every relay for everything and then discards it all —
 * expensive, rude, and indistinguishable from a bug at the relay's end.
 */
export function useOwnArticles(pubkey: string | undefined): OwnArticles {
  const events = useStoreEvents(
    {
      kinds: [ARTICLE_KIND, ARTICLE_DRAFT_KIND],
      // An empty author list matches nothing locally, which is the correct
      // answer for "not signed in" and keeps this hook unconditional.
      authors: pubkey ? [pubkey] : [],
      limit: LIMIT,
    },
    { subscribe: pubkey !== undefined },
  );

  return useMemo(() => {
    if (events.length === 0) return EMPTY;
    const rows = toArticleRows(events.map((stored) => stored.event));
    return {
      drafts: rows.filter((row) => row.draft),
      published: rows.filter((row) => !row.draft),
    };
  }, [events]);
}
