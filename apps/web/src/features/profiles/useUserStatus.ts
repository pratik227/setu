import {
  currentUserStatus,
  Kind,
  type NostrEvent,
  type UserStatus,
} from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSharedSubscription } from "../../engine/sharedSubscription";

/**
 * The status line an account has set about itself (NIP-38).
 *
 * Two `d` tags are worth asking for — `general` and `music` — and both come back in
 * one subscription, because they are the same kind for the same author and splitting
 * them would spend two subscription slots to answer one question.
 *
 * ## Why the clock is state rather than read inline
 *
 * A status can carry a NIP-40 deadline, and the whole point of the deadline is that
 * the line stops being shown when it passes. Reading `Date.now()` during render would
 * mean the status disappears on whatever unrelated re-render happens to come after
 * expiry — or never, on a profile nobody is interacting with. So a timer is set for
 * the moment the *displayed* status expires, and only for that moment: no polling, and
 * no timer at all for the common case of a status with no deadline.
 *
 * The store also refuses expired events at ingest and hides them from reads, so this
 * only has to cover the narrow case the store cannot — an event that was live when it
 * arrived and expired while the tab stayed open.
 */

/** How many kind-30315s to hold per author. Two `d` tags, plus room for churn. */
const STATUS_LIMIT = 4;

export function useUserStatus(
  pubkey: string | undefined,
): UserStatus | undefined {
  const engine = useEngine();
  const [events, setEvents] = useState<readonly NostrEvent[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const filter = useMemo(
    () =>
      pubkey
        ? {
            kinds: [Kind.UserStatus],
            authors: [pubkey],
            limit: STATUS_LIMIT,
          }
        : undefined,
    [pubkey],
  );

  useSharedSubscription(filter);

  useEffect(() => {
    if (!filter) {
      setEvents([]);
      return;
    }
    setEvents([]);
    return engine.store.observe(filter, (rows) => {
      setEvents(rows.map((row) => row.event));
    });
  }, [engine, filter]);

  const status = useMemo(() => currentUserStatus(events, now), [events, now]);

  // One timer, armed only when the status on screen has a deadline. `+1` so the tick
  // lands strictly after expiry rather than on the boundary, where `expiresAt <= now`
  // would still be false by a rounding hair.
  useEffect(() => {
    const expiresAt = status?.expiresAt;
    // Undefined covers both "no deadline" and "already expired": `currentUserStatus`
    // drops an expired status, so by the time `now` passes the deadline there is no
    // status here to schedule against, and the effect cannot re-arm itself forever.
    if (expiresAt === undefined) return;
    const delayMs = (expiresAt - now + 1) * 1000;
    const timer = setTimeout(
      () => setNow(Math.floor(Date.now() / 1000)),
      delayMs,
    );
    return () => clearTimeout(timer);
  }, [status?.expiresAt, now]);

  return status;
}
