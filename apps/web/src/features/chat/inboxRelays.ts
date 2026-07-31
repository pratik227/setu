import { normalizeRelayUrls } from "@setu/core";
import type { Hex32, NostrEvent } from "@setu/protocol";
import { sameRelay } from "@setu/protocol";
import { newestDmRelayLists } from "./dmDelivery";

/**
 * Where a gift wrap addressed to us can actually be found.
 *
 * NIP-17 makes the reader's own kind-10050 the *delivery* address: a sender routes
 * each wrap to the relays that list names and nowhere else (see `dmDelivery.ts`).
 * The consequence for reading is the one this module exists to state — an inbox read
 * from the app's configured relay set alone misses every message delivered exactly
 * as the protocol says it should be. The account is reachable and blind at the same
 * time, and nothing on either side looks broken: the sender's publish was accepted,
 * the recipient's screen is simply empty.
 *
 * So the read set is the **union**, not either half:
 *
 *  - the account's own kind-10050, because that is where correct senders deliver;
 *  - the configured relays, because clients that ignore NIP-17 routing exist, and
 *    because a reader with no kind-10050 yet must still see whatever arrived.
 */

/** Union of the configured relays and the account's own inbox, deduplicated. */
export function inboxReadRelays(
  configured: readonly string[],
  own: readonly string[],
): readonly string[] {
  // Normalised together so `wss://Nos.lol/` in a kind-10050 and `wss://nos.lol` in
  // the configured set collapse to one url — otherwise the same relay is asked
  // twice, burning one of the low-tens subscription slots relays allow.
  return normalizeRelayUrls([...configured, ...own]);
}

/**
 * The account's own newest kind-10050, or `undefined` when none has been seen.
 *
 * The distinction is kept even though the read path unions with the configured set
 * either way, because it is the difference between "you receive private messages
 * nowhere" — worth telling the user — and "we have not finished asking".
 */
export function ownInboxRelays(
  events: readonly NostrEvent[],
  viewer: Hex32 | undefined,
): readonly string[] | undefined {
  if (!viewer) return undefined;
  return newestDmRelayLists(events).get(viewer);
}

/**
 * Whether every configured relay is currently connected.
 *
 * A count of connected relays is not the same question and used to be asked
 * instead — `connected === configured.length` held only while the pool talked to
 * nothing but the configured set. The inbox now opens sockets to the account's own
 * DM relays too, so a raw count can *exceed* the configured length, the equality
 * silently stops holding, and `absenceConfirmed` never becomes true: every send is
 * refused with "not every relay answered" on a perfectly healthy network.
 */
export function configuredRelaysConnected(
  health: readonly { readonly url: string; readonly status: string }[],
  configured: readonly string[],
): boolean {
  if (configured.length === 0) return false;
  return configured.every((relay) =>
    health.some(
      (entry) => entry.status === "connected" && sameRelay(entry.url, relay),
    ),
  );
}
