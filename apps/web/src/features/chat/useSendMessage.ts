import {
  buildChatMessage,
  deliveryTargets,
  giftWrap,
  type Hex32,
  Kind,
  parseDmRelayList,
} from "@setu/protocol";
import { useCallback, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSession } from "../identity/SessionProvider";

/**
 * Sending a private message.
 *
 * The delivery rule is the part with teeth. NIP-17 says a recipient publishes a
 * kind-10050 naming the relays where they want private mail, and that list is
 * *not* their NIP-65 read list. Two consequences this hook enforces:
 *
 *  - **No fallback to the public relay set.** If someone has published no kind-10050
 *    we cannot deliver to them, and we say so. Guessing means depositing an
 *    encrypted envelope addressed to them on relays of *our* choosing, where it
 *    will sit undelivered and still tell an observer that someone messaged that
 *    pubkey.
 *  - **Our own copy goes to our own DM relays.** A gift wrap is encrypted to exactly
 *    one key, so the sender's copy is a separate wrap that has to be delivered
 *    somewhere the sender will actually read.
 *
 * Each wrap is published only to the relays of the person it is addressed to.
 * Broadcasting every wrap to every relay would undo the addressing that keeps a
 * conversation's participants apart on the wire.
 */

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

  /** A participant's DM relays, or an empty list if they published none. */
  const dmRelaysFor = useCallback(
    async (pubkey: Hex32): Promise<readonly string[]> => {
      const rows = await engine.store.query({
        kinds: [Kind.DirectMessageRelays],
        authors: [pubkey],
        limit: 4,
      });
      return parseDmRelayList(rows[0]?.event);
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
        // Where each recipient wants their mail, resolved before anything is
        // built, so a missing list fails before we encrypt rather than after.
        const routes = new Map<Hex32, readonly string[]>();
        const unreachable: Hex32[] = [];
        for (const recipient of recipients) {
          const relays = await dmRelaysFor(recipient);
          if (relays.length === 0) unreachable.push(recipient);
          else routes.set(recipient, relays);
        }
        if (unreachable.length > 0) {
          setState({
            status: "error",
            message:
              unreachable.includes(author) && unreachable.length === 1
                ? "You have not chosen where to receive private messages, so your own copy cannot be delivered. Set your message relays in Settings."
                : `${unreachable.length === 1 ? "That person has" : `${unreachable.length} people have`} not published where to receive private messages, so Setu cannot deliver to them.`,
          });
          return false;
        }

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
    [engine, session, dmRelaysFor],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, send, reset };
}
