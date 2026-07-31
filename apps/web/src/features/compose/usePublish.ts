import type { PublishResult } from "@setu/core";
import type { EventTemplate, NostrEvent } from "@setu/protocol";
import { useCallback, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSession } from "../identity/SessionProvider";

export type PublishState =
  | { readonly status: "idle" }
  | { readonly status: "signing" }
  | { readonly status: "publishing"; readonly event: NostrEvent }
  /** At least one relay accepted. `results` carries every relay's verdict. */
  | {
      readonly status: "sent";
      readonly event: NostrEvent;
      readonly results: readonly PublishResult[];
    }
  | { readonly status: "failed"; readonly error: string };

/** What a completed publish yields: the signed event and every relay's verdict. */
export interface PublishOutcome {
  readonly event: NostrEvent;
  readonly results: readonly PublishResult[];
  /** True when at least one relay accepted. */
  readonly accepted: boolean;
}

export interface Publisher {
  readonly state: PublishState;
  /** Sign and publish. Throws only if signing fails or is declined. */
  publish(template: EventTemplate): Promise<PublishOutcome>;
  reset(): void;
}

/**
 * Sign-and-publish, with the relay verdicts kept.
 *
 * Two behaviours worth stating, because both are easy to get wrong:
 *
 *  1. **Relays are chosen from the author's own NIP-65 write list**, not from
 *     whatever sockets happen to be open. Publishing to the reading set is how a
 *     note becomes invisible to the author's own followers, who are listening to
 *     the write set.
 *  2. **Per-relay results are surfaced, never collapsed to a boolean.** A relay
 *     that rejects a note gives a reason, and "sent" while three of four relays
 *     rejected is the kind of lie that makes a client untrustworthy. Partial
 *     success is a real state and is reported as one.
 */
export function usePublish(): Publisher {
  const engine = useEngine();
  const { session } = useSession();
  const [state, setState] = useState<PublishState>({ status: "idle" });

  const publish = useCallback(
    async (template: EventTemplate) => {
      if (!session?.canSign) {
        const error = "this session cannot sign";
        setState({ status: "failed", error });
        throw new Error(error);
      }

      setState({ status: "signing" });
      let event: NostrEvent;
      try {
        event = await session.signer.signEvent(template);
      } catch (cause) {
        // A declined extension prompt lands here and is not an error worth
        // shouting about — it is the user saying no.
        const error =
          cause instanceof Error ? cause.message : "signing was declined";
        setState({ status: "failed", error });
        throw cause;
      }

      setState({ status: "publishing", event });

      const writeRelays = await engine.outbox
        .writeRelays(session.pubkey)
        .catch(() => engine.relays);
      const targets = writeRelays.length > 0 ? writeRelays : engine.relays;

      // `publish` writes to the local store before any relay answers, so the
      // note appears in the feed through the normal store path immediately.
      const results = await engine.subscriptions.publish(event, targets);

      const accepted = results.some((r) => r.ok);
      if (accepted) {
        setState({ status: "sent", event, results });
      } else {
        const reason =
          results.find((r) => r.message)?.message ??
          "no relay accepted the note";
        setState({ status: "failed", error: reason });
      }
      return { event, results, accepted };
    },
    [engine, session],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, publish, reset };
}
