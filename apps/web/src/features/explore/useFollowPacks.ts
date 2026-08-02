import {
  type FollowPack,
  Kind,
  type NostrEvent,
  newestFollowPacks,
} from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSharedSubscription } from "../../engine/sharedSubscription";

/**
 * Follow packs the configured relays are carrying.
 *
 * Deliberately unranked and unfiltered beyond "is a valid pack". There is no
 * authority on which packs are good — that would need an indexer and a notion of
 * reputation Setu does not have — so what a reader gets is "packs your relays
 * happen to hold", newest first, and the surface says so. Sorting by recency is
 * the one ordering that claims nothing: it is a fact about the events, not a
 * judgement about their contents.
 *
 * Empty packs are dropped *here* rather than at the parser, which keeps them
 * parseable for a caller that needs to distinguish "cleared" from "not a pack" —
 * but a browse list has no use for a pack that would follow nobody.
 */

/** Packs to hold. Bounded like every other filter — see `queryLimits`. */
const PACK_LIMIT = 60;

export interface FollowPacksState {
  readonly packs: readonly FollowPack[];
  /** False until the first store read has happened at all. */
  readonly loaded: boolean;
}

export function useFollowPacks(): FollowPacksState {
  const engine = useEngine();
  const [events, setEvents] = useState<readonly NostrEvent[] | undefined>();

  const filter = useMemo(
    () => ({ kinds: [Kind.FollowPack], limit: PACK_LIMIT }),
    [],
  );

  useSharedSubscription(filter);

  useEffect(() => {
    return engine.store.observe(filter, (rows) => {
      setEvents(rows.map((row) => row.event));
    });
  }, [engine, filter]);

  const packs = useMemo(() => {
    if (events === undefined) return [];
    return newestFollowPacks(events)
      .filter((pack) => pack.pubkeys.length > 0)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [events]);

  return { packs, loaded: events !== undefined };
}
