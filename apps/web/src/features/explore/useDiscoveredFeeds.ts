import type { FeedDefinition } from "@setu/core";
import { getTagValue, getTagValues, Kind } from "@setu/protocol";
import { useMemo } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useStoreEvents } from "../discover/useStoreEvents";
import type { CuratedFeed } from "./curatedFeeds";

/** A feed that came from an event, not from our catalog. */
export interface DiscoveredFeed extends CuratedFeed {
  /** Who published the pack — shown, because a pack is somebody's opinion. */
  readonly curator: string;
  readonly memberCount: number;
}

/** Packs with fewer members than this are almost always drafts or tests. */
const MIN_MEMBERS = 2;
/** Cap on how many packs we render; the tab is a sample, not a directory. */
const MAX_PACKS = 12;

/**
 * Feeds discovered from events we hold.
 *
 * NIP-51 follow packs (kind 39089) are the one thing on the network that is
 * genuinely a shareable feed: a named list of pubkeys, published by someone who
 * stands behind it. Turning one into a `FeedDefinition` is exact — `p` tags
 * become the author set — so nothing has to be inferred.
 *
 * What we deliberately do *not* do is rank them. A pack's popularity is
 * unknowable without a crawler, so they appear in the order the store returns
 * them (newest first) and are labeled as packs we happen to hold.
 */
export function useDiscoveredFeeds(): readonly DiscoveredFeed[] {
  const engine = useEngine();

  const filter = useMemo(() => ({ kinds: [Kind.FollowPack], limit: 40 }), []);
  const events = useStoreEvents(filter, { subscribe: true });

  return useMemo(() => {
    const out: DiscoveredFeed[] = [];
    for (const { event } of events) {
      const members = [...new Set(getTagValues(event, "p"))];
      if (members.length < MIN_MEMBERS) continue;

      const identifier = getTagValue(event, "d") ?? "";
      const name = getTagValue(event, "title") ?? identifier;
      if (!name) continue;

      out.push({
        id: `pack:${event.pubkey}:${identifier}`,
        name,
        description: `Follow pack — ${members.length} people, published by someone you received an event from.`,
        icon: "topic",
        curator: event.pubkey,
        memberCount: members.length,
        definition: {
          kinds: [Kind.ShortTextNote, Kind.Repost],
          authors: members,
          // Author-scoped, so the outbox router will route per author and treat
          // these as the fallback only.
          relays: engine.relays,
        } satisfies FeedDefinition,
      });
      if (out.length >= MAX_PACKS) break;
    }
    return out;
  }, [events, engine.relays]);
}
