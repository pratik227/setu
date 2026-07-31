import { Kind } from "@setu/protocol";
import { useEffect, useMemo } from "react";
import { useAllowRelayAuth, useEngine } from "../../engine/EngineProvider";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { useSharedSubscription } from "../../engine/sharedSubscription";
import { useStoreEvents } from "../discover/useStoreEvents";
import { useSession } from "../identity/SessionProvider";
import { inboxReadRelays, ownInboxRelays } from "./inboxRelays";

/**
 * The account's own NIP-17 inbox, as a set of relays to read from.
 *
 * `useDmRelayLists` asks about the people we are talking *to*, for routing sends.
 * This asks about us, for routing the read — a different question with a different
 * consequence, which is why it is a different hook. See `inboxRelays.ts` for why
 * reading the configured set alone leaves an account reachable and blind.
 *
 * Two things happen here beyond the fetch:
 *
 *  - **The relays are nominated for NIP-42.** An inbox relay is the kind that sets
 *    `auth_required` — that is most of its value, since it is what stops it handing
 *    gift wraps to anyone who asks. Core answers challenges only from relays the
 *    account chose (`engine.ts`), and a fetched list is not something core can see,
 *    so the allowance is widened here, where the list is known to be the account's
 *    own. This covers publishing too: our own copy of every sent message goes to
 *    these same relays, and an unauthenticated publish to them is refused.
 *  - **The list is fetched from the configured relays**, not from itself. A kind-10050
 *    is an ordinary public replaceable event published alongside the account's other
 *    lists, so `useSharedSubscription`'s default fan-out is the right one here — it
 *    is only the *wraps* that live somewhere else.
 */

/** A filter that matches nothing, so hook order is constant when signed out. */
const MATCHES_NOTHING = { ids: [], kinds: [], limit: 1 };

export function useInboxRelays(): readonly string[] {
  const engine = useEngine();
  const { session } = useSession();
  const allowRelayAuth = useAllowRelayAuth();
  const viewer = session?.pubkey;

  const filter = useMemo(
    () =>
      viewer
        ? {
            kinds: [Kind.DirectMessageRelays],
            authors: [viewer],
            limit: REPLACEABLE_LIST_LIMIT,
          }
        : undefined,
    [viewer],
  );

  useSharedSubscription(filter);
  const rows = useStoreEvents(filter ?? MATCHES_NOTHING);

  /*
   * Collapsed to a string on purpose.
   *
   * `useStoreEvents` hands back a fresh array on every store tick, so a relay list
   * derived from it changes identity constantly. The inbox subscription is keyed on
   * this value; a new identity per tick would close and reopen the gift-wrap REQ
   * before any relay had a chance to answer it, which reads as an inbox that never
   * loads. Everything downstream is derived from the key rather than the array for
   * the same reason.
   */
  const ownKey = useMemo(() => {
    const own = ownInboxRelays(
      rows.map((row) => row.event),
      viewer,
    );
    return own ? own.join(" ") : "";
  }, [rows, viewer]);

  useEffect(() => {
    if (ownKey === "") return;
    allowRelayAuth(ownKey.split(" "));
  }, [ownKey, allowRelayAuth]);

  return useMemo(
    () =>
      inboxReadRelays(engine.relays, ownKey === "" ? [] : ownKey.split(" ")),
    [engine.relays, ownKey],
  );
}
