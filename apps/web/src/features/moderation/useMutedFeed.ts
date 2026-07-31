import type { FeedEntry } from "@setu/core";
import { useMemo, useRef } from "react";
import { useSession } from "../identity/SessionProvider";
import { filterMutedEntries, type MutedFeed } from "./muteEntries";
import { useMuteRules } from "./useMuteList";

/**
 * A page of feed rows with the reader's mutes applied, and the counts to say so.
 *
 * Sits above `filterMutedEntries` only to hold the per-row identity cache across
 * renders and to throw it away when the rules change. Both halves matter: without
 * the cache a rewritten repost row is a new object on every tick, which un-memoises
 * that row; without the reset a row would keep the verdict it got under the previous
 * mute list, so un-muting someone would not bring their notes back until the feed
 * happened to replace the row.
 */
export function useMutedFeed(entries: readonly FeedEntry[]): MutedFeed {
  const { rules, rulesKey } = useMuteRules();
  const { session } = useSession();
  const viewerPubkey = session?.pubkey;

  const cache = useRef<WeakMap<FeedEntry, FeedEntry | null>>(new WeakMap());
  const heldKey = useRef(rulesKey);
  if (heldKey.current !== rulesKey) {
    heldKey.current = rulesKey;
    cache.current = new WeakMap();
  }

  return useMemo(
    () =>
      filterMutedEntries(entries, {
        rules,
        viewerPubkey,
        cache: cache.current,
      }),
    [entries, rules, viewerPubkey],
  );
}
