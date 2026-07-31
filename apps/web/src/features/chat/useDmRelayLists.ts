import { type Hex32, Kind } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { useSharedSubscription } from "../../engine/sharedSubscription";
import { useStoreEvents } from "../discover/useStoreEvents";
import { newestDmRelayLists } from "./dmDelivery";
import { configuredRelaysConnected } from "./inboxRelays";

/**
 * Everyone's DM inbox list (kind 10050), for the people we are talking to.
 *
 * Nothing else in the app asks the network for someone *else's* kind-10050 — the
 * settings screen only ever fetches the signed-in account's — so before this hook
 * existed the store held no inbox list for any recipient, and the send path, which
 * read that store, concluded that every recipient was unreachable. The subscription
 * is here rather than inside the send path because a lookup that starts when the
 * user presses Send is a lookup they wait for; by then the answer should already be
 * in the store.
 *
 * A kind-10050 is replaceable, so this is one shared REQ for the whole set of
 * participants rather than one per conversation.
 */

/**
 * Participants to ask about in one REQ.
 *
 * The filter is bounded twice over: this cap and the `limit` derived from it. A
 * DM inbox has one current event per author, so `REPLACEABLE_LIST_LIMIT` copies of
 * 100 authors is 400 — inside the 500 `max_limit` the app's default relays
 * advertise, which matters because a relay that dislikes a limit clamps it
 * silently and the shortfall looks like people who published nothing.
 */
const MAX_PARTICIPANTS = 100;

/**
 * How long to wait before a missing kind-10050 may be called absent.
 *
 * Only ever used to *withhold* a claim, never to make one: the value decides when
 * the UI is allowed to say "they published no inbox", and the send path re-checks
 * against a completed fetch before acting on it.
 */
const ABSENT_AFTER_MS = 8000;

/** A filter that matches nothing, so hook order is constant with no participants. */
const MATCHES_NOTHING = { ids: [], kinds: [], limit: 1 };

export interface DmRelayLists {
  /**
   * Relays each participant wants private mail on. A pubkey missing from the map
   * has published nothing we have seen — which is not the same as having no
   * inbox, hence `absenceConfirmed`.
   */
  readonly lists: ReadonlyMap<Hex32, readonly string[]>;
  /**
   * True only when every configured relay is connected *and* we have waited long
   * enough for an answer. Until then a missing list means "not yet", and any
   * surface that says otherwise is accusing a recipient of a slow relay.
   */
  readonly absenceConfirmed: boolean;
}

export function useDmRelayLists(pubkeys: readonly Hex32[]): DmRelayLists {
  const engine = useEngine();

  // Capped in input order — the caller passes participants newest-conversation
  // first — then sorted, so the filter's identity does not change with the order
  // wraps happened to arrive in. Without the sort the shared subscription would
  // see a new key on every inbox tick and cancel its own REQ before any relay
  // answered.
  const authors = useMemo(
    () => [...new Set(pubkeys)].slice(0, MAX_PARTICIPANTS).sort(),
    [pubkeys],
  );

  const filter = useMemo(
    () =>
      authors.length > 0
        ? {
            kinds: [Kind.DirectMessageRelays],
            authors,
            limit: REPLACEABLE_LIST_LIMIT * authors.length,
          }
        : undefined,
    [authors],
  );

  useSharedSubscription(filter);
  const rows = useStoreEvents(filter ?? MATCHES_NOTHING);

  const lists = useMemo(
    () => newestDmRelayLists(rows.map((row) => row.event)),
    [rows],
  );

  // Restarted whenever the participant set grows: a person who joined the set a
  // moment ago has not been asked about for long enough, and carrying the old
  // timer over would declare them inboxless immediately.
  const authorsKey = authors.join(",");
  const [waitedFor, setWaitedFor] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setWaitedFor(authorsKey), ABSENT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [authorsKey]);

  // A relay that never connected has not answered. Same rule as the bookmark
  // list's `absenceConfirmed`, because a partial answer and a genuine absence are
  // indistinguishable from the reply alone. Asked per configured relay rather than
  // by counting them: the pool also holds sockets to the account's own DM inbox,
  // which this REQ was never sent to — see `configuredRelaysConnected`.
  const answered = configuredRelaysConnected(
    engine.pool.health(),
    engine.relays,
  );

  return {
    lists,
    absenceConfirmed: waitedFor === authorsKey && authorsKey !== "" && answered,
  };
}
