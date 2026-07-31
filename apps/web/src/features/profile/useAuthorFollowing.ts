import type { StoredEvent } from "@setu/core";
import { Kind } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSharedSubscription } from "../../engine/sharedSubscription";

/**
 * How many accounts an author follows.
 *
 * The one social count a Nostr client can state **exactly**, and it is worth being
 * clear about why, because the number next to it cannot be. Following is a list the
 * author publishes about themselves: one replaceable kind-3, whose `p` tags *are* the
 * answer. Fetch that event and you have the figure, not an estimate of it.
 *
 * Followers are the reverse edge, and nobody publishes it — the answer is spread
 * across every kind-3 on the network, so counting them means having read all of them.
 * That is why `useAuthorCounts` asks relays for followers via NIP-45 and reports a
 * lower bound, while this hook returns a number and means it.
 *
 * ## Why `loaded` is separate from the count
 *
 * "We have not fetched their list" and "they follow nobody" both produce 0, and they
 * need opposite treatment on screen — the same distinction `useFollows` draws for the
 * signed-in account. A profile that prints "0 following" while the event is still in
 * flight is stating something false about a person.
 */

export interface AuthorFollowing {
  /** Distinct pubkeys in the author's newest kind-3. */
  readonly count: number;
  /** False until a kind-3 for this author has actually arrived. */
  readonly loaded: boolean;
}

const EMPTY: AuthorFollowing = { count: 0, loaded: false };

/** Distinct `p` tags in the newest kind-3 held. Exported for its tests. */
export function projectFollowingCount(
  rows: readonly StoredEvent[],
): AuthorFollowing {
  // The store resolves replaceable last-write-wins, so row 0 is the newest list.
  const newest = rows[0]?.event;
  if (!newest) return EMPTY;
  const seen = new Set<string>();
  for (const tag of newest.tags) {
    if (tag[0] !== "p") continue;
    const pubkey = tag[1];
    // Deduplicated: a hand-edited or merged list can name the same key twice, and
    // "follows 412" should not become 413 because of a duplicate row.
    if (pubkey) seen.add(pubkey);
  }
  return { count: seen.size, loaded: true };
}

export function useAuthorFollowing(
  pubkey: string | undefined,
): AuthorFollowing {
  const engine = useEngine();
  const [following, setFollowing] = useState<AuthorFollowing>(EMPTY);

  const filter = useMemo(
    () =>
      pubkey
        ? { kinds: [Kind.Contacts], authors: [pubkey], limit: 1 }
        : undefined,
    [pubkey],
  );

  // Shared, so opening the same profile twice does not open a second REQ. `limit: 1`
  // rather than `REPLACEABLE_LIST_LIMIT`: unlike our *own* list, we never write this
  // one, so a stale copy costs a slightly wrong number rather than an overwrite that
  // un-follows people. The destructive-write reason for over-fetching does not apply.
  useSharedSubscription(filter);

  useEffect(() => {
    if (!filter) {
      setFollowing(EMPTY);
      return;
    }
    setFollowing(EMPTY);
    return engine.store.observe(filter, (rows) => {
      setFollowing(projectFollowingCount(rows));
    });
  }, [engine, filter]);

  return following;
}
