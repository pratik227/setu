import type { Hex32, NostrEvent } from "@setu/protocol";
import { Kind, parseDmRelayList } from "@setu/protocol";

/**
 * Where a private message may be delivered, and when it may be called
 * undeliverable.
 *
 * NIP-17 delivery is a lookup: each participant publishes a kind-10050 naming the
 * relays they want private mail on, and a wrap goes only there. That makes the
 * *absence* of a kind-10050 load-bearing, and it is why this module exists rather
 * than the caller reading `parseDmRelayList` and checking for an empty array.
 *
 * Two absences look identical in a store and mean opposite things:
 *
 *  - **They published no inbox.** Nothing can be delivered to them, ever, and the
 *    honest answer is to say so. Falling back to our own relay set is not an
 *    option — see `nip17.ts` — because an envelope addressed to them on a relay of
 *    *our* choosing sits unread and still tells an observer who was messaged.
 *  - **We have not read their inbox yet.** Reporting this as "they have no inbox"
 *    is the failure this module is built to prevent: it blames the recipient for a
 *    relay that was slow, and it makes the send button a control that cannot
 *    succeed. Same reasoning as `absenceConfirmed` in `followList.ts` and
 *    `relayListEdit.ts`, with a milder consequence — a refused send rather than a
 *    destroyed list — but the same rule.
 *
 * So a caller passes what it found *and* whether it finished asking, and gets back
 * either a complete set of routes or a split of who is unreachable and why.
 */

/**
 * Newest kind-10050 per author, parsed to relay urls.
 *
 * An author present with an **empty** array published a list that names nowhere:
 * that is a confirmed absence, not a pending one, so it is kept distinct from an
 * author who is missing from the map entirely.
 */
export function newestDmRelayLists(
  events: readonly NostrEvent[],
): ReadonlyMap<Hex32, readonly string[]> {
  const newest = new Map<Hex32, NostrEvent>();
  for (const event of events) {
    if (event.kind !== Kind.DirectMessageRelays) continue;
    const held = newest.get(event.pubkey);
    // Newest wins, decided here rather than taken from arrival order: these
    // events come back from several relays in whatever order the sockets
    // answered, and routing by a stale copy delivers to an inbox the recipient
    // has since abandoned — which fails silently, because the relay accepts it.
    if (!held || event.created_at > held.created_at) {
      newest.set(event.pubkey, event);
    }
  }
  const out = new Map<Hex32, readonly string[]>();
  for (const [pubkey, event] of newest) {
    out.set(pubkey, parseDmRelayList(event));
  }
  return out;
}

export type DmDeliveryPlan =
  | {
      readonly ok: true;
      /** Every target, mapped to the relays their wrap must go to. */
      readonly routes: ReadonlyMap<Hex32, readonly string[]>;
    }
  | {
      readonly ok: false;
      /** Published no inbox, or one that names no relay. Cannot be reached. */
      readonly noInbox: readonly Hex32[];
      /** No inbox found, and we cannot yet call that an answer. */
      readonly unconfirmed: readonly Hex32[];
    };

export interface DmDeliveryInput {
  /** Everyone a wrap must reach — recipients *and* the author's own copy. */
  readonly targets: readonly Hex32[];
  /** What was found, from {@link newestDmRelayLists}. */
  readonly lists: ReadonlyMap<Hex32, readonly string[]>;
  /**
   * True only when the query for these lists actually completed against every
   * configured relay. Required before a missing list may be read as "this person
   * has no inbox"; without it a slow relay becomes a permanent accusation.
   */
  readonly absenceConfirmed: boolean;
}

/**
 * Route every target, or explain who cannot be routed.
 *
 * All-or-nothing on purpose. A group message delivered to three of four people is
 * a conversation whose participants disagree about what was said, and nothing on
 * the wire would ever reveal the gap.
 */
export function planDmDelivery({
  targets,
  lists,
  absenceConfirmed,
}: DmDeliveryInput): DmDeliveryPlan {
  const routes = new Map<Hex32, readonly string[]>();
  const noInbox: Hex32[] = [];
  const unconfirmed: Hex32[] = [];

  for (const target of new Set(targets)) {
    const relays = lists.get(target);
    if (relays !== undefined && relays.length > 0) {
      routes.set(target, relays);
    } else if (relays !== undefined || absenceConfirmed) {
      noInbox.push(target);
    } else {
      unconfirmed.push(target);
    }
  }

  if (noInbox.length > 0 || unconfirmed.length > 0) {
    return { ok: false, noInbox, unconfirmed };
  }
  return { ok: true, routes };
}

/**
 * Why a message was not sent, in the reader's terms.
 *
 * The two reasons are never merged. "They have not published an inbox" is a fact
 * about them; "we could not finish checking" is a fact about us, and telling the
 * second as the first would have the reader chasing a friend who did nothing
 * wrong.
 */
export function undeliverableMessage({
  author,
  noInbox,
  unconfirmed,
}: {
  readonly author: Hex32;
  readonly noInbox: readonly Hex32[];
  readonly unconfirmed: readonly Hex32[];
}): string {
  const parts: string[] = [];

  if (unconfirmed.length > 0) {
    const onlySelf = unconfirmed.length === 1 && unconfirmed[0] === author;
    parts.push(
      onlySelf
        ? "Setu could not confirm where your own copy of this message should go, because not every relay answered. Nothing was sent — try again in a moment."
        : `Setu could not confirm where ${
            unconfirmed.length === 1
              ? "that person receives"
              : `${unconfirmed.length} people receive`
          } private messages, because not every relay answered. It will not report an inbox as missing when the answer may simply not have arrived. Nothing was sent — try again in a moment.`,
    );
  }

  if (noInbox.length > 0) {
    const others = noInbox.filter((pubkey) => pubkey !== author).length;
    if (others === 1) {
      parts.push(
        "That person has not published where to receive private messages, so Setu cannot deliver to them — and it will not guess, because a wrap left on a relay of our choosing never reaches them and still records that they were messaged.",
      );
    } else if (others > 1) {
      parts.push(
        `${others} people have not published where to receive private messages, so Setu cannot deliver to them, and it will not guess on their behalf.`,
      );
    }
    if (noInbox.includes(author)) {
      parts.push(
        others === 0
          ? "You have not chosen where to receive private messages, so your own copy cannot be delivered. Set your message relays in Settings."
          : "You have not published yours either, so your own copy has nowhere to go — set your message relays in Settings.",
      );
    }
  }

  // Never empty: the caller only reaches this with a failed plan, and a blank
  // error line reads as "sent".
  return parts.length > 0
    ? parts.join(" ")
    : "Setu could not work out where to deliver this message, so nothing was sent.";
}
