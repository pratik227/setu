import type { StoredEvent } from "@setu/core";
import {
  buildChatMessage,
  deliveryTargets,
  giftWrap,
  type Hex32,
  Kind,
  type NostrEvent,
} from "@setu/protocol";
import { useCallback, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { useSession } from "../identity/SessionProvider";
import {
  type DmDeliveryPlan,
  newestDmRelayLists,
  planDmDelivery,
  undeliverableMessage,
} from "./dmDelivery";
import { configuredRelaysConnected } from "./inboxRelays";

/**
 * Sending a private message.
 *
 * The delivery rule is the part with teeth. NIP-17 says a recipient publishes a
 * kind-10050 naming the relays where they want private mail, and that list is
 * *not* their NIP-65 read list. Three consequences this hook enforces:
 *
 *  - **No fallback to the public relay set.** If someone has published no kind-10050
 *    we cannot deliver to them, and we say so. Guessing means depositing an
 *    encrypted envelope addressed to them on relays of *our* choosing, where it
 *    will sit undelivered and still tell an observer that someone messaged that
 *    pubkey.
 *  - **The inbox lists are read from the network, not just the store.** This hook
 *    used to answer the question from a local `store.query` alone. Nothing filled
 *    that store for anyone but the signed-in account, so every recipient looked
 *    inboxless and no message could ever be sent. A store read that races a fetch
 *    nobody started is not a lookup.
 *  - **Our own copy goes to our own DM relays.** A gift wrap is encrypted to exactly
 *    one key, so the sender's copy is a separate wrap that has to be delivered
 *    somewhere the sender will actually read.
 *
 * Each wrap is published only to the relays of the person it is addressed to.
 * Broadcasting every wrap to every relay would undo the addressing that keeps a
 * conversation's participants apart on the wire.
 */

/**
 * How long to wait for relays to answer with the recipients' inbox lists.
 *
 * A timeout is not an answer: it leaves `absenceConfirmed` false, so the send is
 * refused as "could not confirm" rather than as "they have no inbox". See
 * `dmDelivery.ts`.
 */
const RESOLVE_TIMEOUT_MS = 6000;

export type SendState =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "sent"; readonly delivered: number }
  | { readonly status: "error"; readonly message: string };

export interface SendMessageApi {
  readonly state: SendState;
  /** Resolves true when at least one relay accepted a wrap for every recipient. */
  send(input: {
    content: string;
    to: readonly Hex32[];
    replyTo?: Hex32;
    subject?: string;
  }): Promise<boolean>;
  reset(): void;
}

export function useSendMessage(): SendMessageApi {
  const engine = useEngine();
  const { session } = useSession();
  const [state, setState] = useState<SendState>({ status: "idle" });

  /**
   * Where each target wants their mail, asked of the relays and then decided.
   *
   * The fetch is not an optimisation, it is the answer: the chat list's
   * subscription (`useDmRelayLists`) may already have it, but a conversation
   * opened from a profile has no such history, and a first message must not fail
   * because we never asked.
   */
  const resolveRoutes = useCallback(
    async (targets: readonly Hex32[]): Promise<DmDeliveryPlan> => {
      const filter = {
        kinds: [Kind.DirectMessageRelays],
        authors: [...targets],
        limit: REPLACEABLE_LIST_LIMIT * targets.length,
      };

      let fetched: readonly NostrEvent[] = [];
      let completed = true;
      try {
        fetched = await Promise.race([
          engine.subscriptions.fetch({
            filters: engine.relays.map((relay) => ({ relay, filter })),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("timed out")),
              RESOLVE_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch {
        // A slow relay must never become an accusation. `completed` stays false,
        // which keeps `absenceConfirmed` false, which makes this a "could not
        // check" refusal rather than "they published no inbox".
        completed = false;
      }

      // Read the store too, and unconditionally: the race above discards the
      // fetch's own local half on timeout, and a list the chat list's
      // subscription already delivered is a perfectly good answer that would
      // otherwise be thrown away with it.
      const stored: readonly StoredEvent[] = await engine.store
        .query(filter)
        .catch(() => []);

      // A relay that never connected has not answered. Same rule as the bookmark
      // list's absence check: a partial result and a real absence are identical
      // from the replies alone. Checked per configured relay, not by counting
      // connections — the pool also holds sockets to the inbox relays the chat
      // screen reads wraps from, which this REQ never went to, so a count would
      // exceed the configured set and no absence would ever be confirmed.
      const answered = configuredRelaysConnected(
        engine.pool.health(),
        engine.relays,
      );

      return planDmDelivery({
        targets,
        lists: newestDmRelayLists([
          ...fetched,
          ...stored.map((row) => row.event),
        ]),
        absenceConfirmed: completed && answered,
      });
    },
    [engine],
  );

  const send = useCallback(
    async ({
      content,
      to,
      replyTo,
      subject,
    }: {
      content: string;
      to: readonly Hex32[];
      replyTo?: Hex32;
      subject?: string;
    }): Promise<boolean> => {
      if (!session?.canSign || !session.signer.nip44Encrypt) {
        setState({
          status: "error",
          message: "Sending a private message needs a signer that can encrypt.",
        });
        return false;
      }
      const author = session.pubkey as Hex32;
      const recipients = deliveryTargets(author, to);

      setState({ status: "sending" });
      try {
        // Resolved before anything is built, so an undeliverable message fails
        // before we encrypt rather than after — and resolved against the network,
        // so "no inbox" is a finding rather than the default.
        const plan = await resolveRoutes(recipients);
        if (!plan.ok) {
          setState({
            status: "error",
            message: undeliverableMessage({
              author,
              noInbox: plan.noInbox,
              unconfirmed: plan.unconfirmed,
            }),
          });
          return false;
        }
        const routes = plan.routes;

        const template = buildChatMessage({
          content,
          to,
          author,
          ...(replyTo ? { replyTo } : {}),
          ...(subject ? { subject } : {}),
        });
        const wraps = await giftWrap({
          template,
          recipients,
          signer: session.signer,
          now: Math.floor(Date.now() / 1000),
        });

        // Each wrap goes only to its own addressee's relays. Broadcasting them all
        // everywhere would undo the addressing that keeps participants apart.
        let delivered = 0;
        for (const envelope of wraps) {
          const recipient = envelope.tags.find((t) => t[0] === "p")?.[1] as
            | Hex32
            | undefined;
          const relays = recipient ? routes.get(recipient) : undefined;
          if (!relays) continue;
          const results = await engine.subscriptions.publish(envelope, relays);
          if (results.some((r) => r.ok)) delivered += 1;
        }

        if (delivered === 0) {
          setState({
            status: "error",
            message: "No relay accepted the message. Nothing was delivered.",
          });
          return false;
        }
        setState({ status: "sent", delivered });
        return true;
      } catch (error) {
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "The message could not be sent.",
        });
        return false;
      }
    },
    [engine, session, resolveRoutes],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, send, reset };
}
