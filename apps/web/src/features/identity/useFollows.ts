import type { StoredEvent } from "@setu/core";
import { Kind } from "@setu/protocol";
import { useMemo } from "react";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { useSharedStoreQuery } from "../../engine/sharedStoreQuery";
import { useSession } from "./SessionProvider";

export interface FollowList {
  /** Pubkeys the account follows. Empty until the kind-3 event arrives. */
  readonly authors: readonly string[];
  /** False while we have not yet seen a kind-3 for this account. */
  readonly loaded: boolean;
  /** `created_at` of the list we are showing, for safe writes later. */
  readonly updatedAt?: number;
}

const EMPTY: FollowList = { authors: [], loaded: false };

/** Newest kind-3 -> the account's follow list. Pure; the store orders the rows. */
function projectFollowList(events: readonly StoredEvent[]): FollowList {
  // The store enforces replaceable last-write-wins, so the first row is the
  // newest kind-3 we hold.
  const newest = events[0]?.event;
  if (!newest) return EMPTY;
  const authors: string[] = [];
  const seen = new Set<string>();
  for (const tag of newest.tags) {
    if (tag[0] !== "p") continue;
    const pubkey = tag[1];
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    authors.push(pubkey);
  }
  return { authors, loaded: true, updatedAt: newest.created_at };
}

/**
 * The signed-in account's follow list (kind 3).
 *
 * One subscription and one store observer for the whole app, however many surfaces
 * ask. The shell reads this for the profile screen's follow button while the home
 * timeline reads it to build the Following feed, so a per-caller subscription meant
 * two identical kind-3 REQs per relay for a list that cannot differ between them.
 *
 * `loaded` is deliberately separate from `authors.length`, and callers must
 * respect the distinction: "we have not fetched the list yet" and "this account
 * follows nobody" produce the same empty array but require opposite UI. Treating
 * the first as the second is what makes a client show an empty home feed to
 * someone with 500 follows.
 *
 * `updatedAt` is exposed because any future *write* to kind 3 must first
 * re-fetch the newest list and merge into it. A kind-3 write built from a stale
 * snapshot silently unfollows everyone added since — the single most destructive
 * bug a Nostr client can ship.
 */
export function useFollows(): FollowList {
  const { session } = useSession();
  const pubkey = session?.pubkey;

  // Asked of every configured relay: a follow list is the one event where missing
  // the newest copy has destructive consequences, so breadth beats economy.
  const filter = useMemo(
    () =>
      pubkey
        ? {
            kinds: [Kind.Contacts],
            authors: [pubkey],
            limit: REPLACEABLE_LIST_LIMIT,
          }
        : undefined,
    [pubkey],
  );

  return useSharedStoreQuery({
    key: pubkey ? `follows:${pubkey}` : "",
    filter,
    project: projectFollowList,
    initial: EMPTY,
  });
}
