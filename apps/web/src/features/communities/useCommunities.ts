import {
  COMMUNITY_KIND,
  type Community,
  type NostrEvent,
  newestCommunities,
} from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSharedSubscription } from "../../engine/sharedSubscription";

/**
 * Communities the configured relays carry (NIP-72 kind 34550).
 *
 * Unranked, newest first, for the same reason follow packs are: there is no
 * authority on which communities are good, and ordering by anything else would be
 * a recommendation Setu has no basis for. Recency is a fact about the events.
 *
 * A community definition is small and replaceable, so holding sixty of them costs
 * almost nothing — the expensive part of a community is its *posts*, and those are
 * only fetched when one is opened (`useCommunityFeed`).
 */

const COMMUNITY_LIMIT = 60;

export interface CommunitiesState {
  readonly communities: readonly Community[];
  /** False until the first store read has happened at all. */
  readonly loaded: boolean;
}

export function useCommunities(): CommunitiesState {
  const engine = useEngine();
  const [events, setEvents] = useState<readonly NostrEvent[] | undefined>();

  const filter = useMemo(
    () => ({ kinds: [COMMUNITY_KIND], limit: COMMUNITY_LIMIT }),
    [],
  );

  useSharedSubscription(filter);

  useEffect(() => {
    return engine.store.observe(filter, (rows) => {
      setEvents(rows.map((row) => row.event));
    });
  }, [engine, filter]);

  const communities = useMemo(() => {
    if (events === undefined) return [];
    return [...newestCommunities(events)].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }, [events]);

  return { communities, loaded: events !== undefined };
}

/** One community by address, from the same shared subscription. */
export function useCommunity(
  address: string | undefined,
): Community | undefined {
  const { communities } = useCommunities();
  return useMemo(
    () => communities.find((community) => community.address === address),
    [communities, address],
  );
}
