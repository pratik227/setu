import type { Filter, NostrEvent } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { idLookupLimit } from "../../engine/queryLimits";
import { useSharedSubscription } from "../../engine/sharedSubscription";
import { useInterestIds } from "../../engine/useInterestIds";
import { useStoreEvents } from "../discover/useStoreEvents";
import { useSession } from "../identity/SessionProvider";
import { NOTE_TARGET_KINDS } from "../notes/noteKinds";
import {
  groupNotifications,
  NOTIFICATION_KINDS,
  type NotificationItem,
  referencedEventIds,
} from "./groupNotifications";

/**
 * How many addressed events are held live.
 *
 * Bounded because `#p` is an open door: anyone can tag anyone, so a filter scoped
 * to the viewer is not the same as a filter scoped to a *small* set. This is the
 * ceiling on rows, not on truth — older notifications are still in the store.
 */
const OBSERVE_LIMIT = 300;

/**
 * How many referenced targets we try to resolve.
 *
 * Targets exist to answer two questions — is this a reply to *my* note, and what
 * did that note say — and both only matter for rows a reader can reach.
 */
const TARGET_LIMIT = 120;

/**
 * Republish policy for the target id set.
 *
 * The set grows as notifications arrive, and replacing the subscription on every
 * change cancelled the REQ before any relay answered — measured at three
 * re-subscribes per relay for one unchanged screen. `threshold` makes a handful of
 * newly referenced notes wait for the next round trip; `maxStaleMs` guarantees they
 * still get one.
 */
const TARGET_POLICY = {
  max: TARGET_LIMIT,
  threshold: 8,
  cooldownMs: 10_000,
  maxStaleMs: 30_000,
} as const;

/**
 * A filter that matches nothing, cheaply.
 *
 * `useStoreEvents` takes a filter, not an optional one, and hooks cannot be
 * called conditionally — so the not-signed-in and no-targets-yet paths need
 * *something* to observe. An id filter is the one shape the query planner can
 * satisfy with a primary-key lookup, so this costs one miss rather than the full
 * scan that `{}` or `{ ids: [] }` would plan as.
 */
const MATCHES_NOTHING: Filter = { ids: ["0".repeat(64)], limit: 1 };

export interface Notifications {
  /** Grouped rows, newest first. Empty when nobody is signed in. */
  readonly items: readonly NotificationItem[];
  /**
   * The addressed events the rows were built from, newest first.
   *
   * Exposed so the Mentions timeline can render real notes from the same
   * subscription instead of opening a second one for the same filter.
   */
  readonly events: readonly NostrEvent[];
  /** True while we hold nothing yet and a first answer is still plausible. */
  readonly loading: boolean;
  readonly signedIn: boolean;
  /** Viewer pubkey the rows are scoped to, for read-state keying. */
  readonly viewerPubkey?: string;
}

const NO_ITEMS: readonly NotificationItem[] = [];
const NO_EVENTS: readonly NostrEvent[] = [];
const NO_TARGETS: readonly string[] = [];

/**
 * Everything addressed to the signed-in account, grouped into notification rows.
 *
 * One subscription (`{"#p": [me], kinds: [1, 6, 7, 9735, 1111]}`) across the
 * configured relays, read back through the store — the store is the event bus, so
 * the network write and the UI read are deliberately separate halves of this hook
 * rather than a callback chain. A second, id-scoped subscription resolves the
 * notes those events point at, which is what lets a row say "replied to *your*
 * note" from something we verified rather than something we assumed.
 *
 * Both subscriptions are shared by ref-count (see `engine/sharedSubscription.ts`): the
 * sidebar badge and this screen ask for the same filter, and relays cap
 * concurrent subscriptions.
 */
export function useNotifications(): Notifications {
  const engine = useEngine();
  const { session } = useSession();
  const viewer = session?.pubkey;

  const filter = useMemo(
    () =>
      viewer
        ? {
            kinds: [...NOTIFICATION_KINDS],
            "#p": [viewer],
            limit: OBSERVE_LIMIT,
          }
        : undefined,
    [viewer],
  );

  useSharedSubscription(filter);
  const stored = useStoreEvents(filter ?? MATCHES_NOTHING);

  const events = useMemo(() => {
    if (!viewer) return NO_EVENTS;
    return stored.map(({ event }) => event);
  }, [stored, viewer]);

  // --- targets ---------------------------------------------------------------

  const wantedTargets = useMemo(() => {
    if (!viewer) return NO_TARGETS;
    const ids: string[] = [];
    for (const event of events) {
      for (const id of referencedEventIds(event)) {
        if (!ids.includes(id)) ids.push(id);
        if (ids.length >= TARGET_LIMIT) break;
      }
      if (ids.length >= TARGET_LIMIT) break;
    }
    return ids;
  }, [events, viewer]);

  // A grow-only union, republished on a policy rather than on every change: the id
  // set changes with every arriving notification, and a subscription keyed directly
  // on it is cancelled before any relay answers.
  const targetIds = useInterestIds(wantedTargets, TARGET_POLICY, viewer ?? "");

  const targetFilter = useMemo(
    () =>
      targetIds.length > 0
        ? {
            // Named kinds and an exact bound: ids are unique, so n ids can match
            // at most n events, and a filter with no `kinds` is the broadest
            // question we could have asked rather than the narrowest.
            kinds: [...NOTE_TARGET_KINDS],
            ids: [...targetIds],
            limit: idLookupLimit(targetIds.length),
          }
        : undefined,
    [targetIds],
  );

  useSharedSubscription(targetFilter);
  const targetEvents = useStoreEvents(targetFilter ?? MATCHES_NOTHING);

  const known = useMemo(() => {
    const map = new Map<string, NostrEvent>();
    for (const { event } of targetEvents) map.set(event.id, event);
    return map;
  }, [targetEvents]);

  // --- grouping --------------------------------------------------------------

  const items = useMemo(() => {
    if (!viewer) return NO_ITEMS;
    return groupNotifications({ viewerPubkey: viewer, events, known });
  }, [viewer, events, known]);

  // `loading` is a claim about the *network*, not about emptiness: an account
  // with genuinely no notifications must reach a settled empty state rather than
  // spinning forever, so it is bounded by a first answer from the store.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!viewer) return;
    setSettled(false);
    const id = setTimeout(() => setSettled(true), 2500);
    return () => clearTimeout(id);
  }, [viewer, engine]);

  return {
    items,
    events,
    loading: Boolean(viewer) && events.length === 0 && !settled,
    signedIn: Boolean(viewer),
    ...(viewer ? { viewerPubkey: viewer } : {}),
  };
}
