import type { PublishResult } from "@setu/core";
import type { EventTemplate, NostrEvent } from "@setu/protocol";
import { useCallback, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSession } from "../identity/SessionProvider";
import { useDeviceSettings } from "../sync/localSettings";
import {
  type MiningProgress,
  miningPlan,
  type PowAttemptOutcome,
  type PowSummary,
  summarisePow,
  templateFromMined,
  unsignedForMining,
} from "./pow";
import { usePow } from "./usePow";

export type PublishState =
  | { readonly status: "idle" }
  /**
   * Preparing and signing. `mining` is present only while a worker is hashing.
   *
   * Proof of work is reported inside `signing` rather than as a status of its own
   * on purpose: every screen that drives a button off this state treats `signing`
   * and `publishing` as busy and nothing else, so a new status would leave those
   * buttons live while a worker burns a CPU core — and the second click would
   * start a second mine of the same note.
   */
  | { readonly status: "signing"; readonly mining?: MiningProgress }
  | { readonly status: "publishing"; readonly event: NostrEvent }
  /** At least one relay accepted. `results` carries every relay's verdict. */
  | {
      readonly status: "sent";
      readonly event: NostrEvent;
      readonly results: readonly PublishResult[];
      /** Absent when proof of work is switched off. */
      readonly pow?: PowSummary;
    }
  | { readonly status: "failed"; readonly error: string };

/** What a completed publish yields: the signed event and every relay's verdict. */
export interface PublishOutcome {
  readonly event: NostrEvent;
  readonly results: readonly PublishResult[];
  /** True when at least one relay accepted. */
  readonly accepted: boolean;
  /** What became of the requested proof of work. Absent when it was off. */
  readonly pow?: PowSummary;
}

export interface Publisher {
  readonly state: PublishState;
  /**
   * Sign and publish. Throws only if signing fails or is declined.
   *
   * `alsoTo` adds destinations *on top of* the author's own write relays, for the
   * cases where an event is only useful if it reaches somewhere specific — a NIP-88
   * poll response has to arrive where the poll's author is counting, and NIP-65 write
   * relays are about who follows the *voter*, which is a different question. Never a
   * replacement for the write set: dropping that would publish an event the author's
   * own followers cannot see.
   */
  publish(
    template: EventTemplate,
    alsoTo?: readonly string[],
  ): Promise<PublishOutcome>;
  /** Stop mining and publish without the work. No-op when nothing is mining. */
  skipMining(): void;
  reset(): void;
}

/**
 * Sign-and-publish, with the relay verdicts kept.
 *
 * Three behaviours worth stating, because all three are easy to get wrong:
 *
 *  1. **Relays are chosen from the author's own NIP-65 write list**, not from
 *     whatever sockets happen to be open. Publishing to the reading set is how a
 *     note becomes invisible to the author's own followers, who are listening to
 *     the write set.
 *  2. **Per-relay results are surfaced, never collapsed to a boolean.** A relay
 *     that rejects a note gives a reason, and "sent" while three of four relays
 *     rejected is the kind of lie that makes a client untrustworthy. Partial
 *     success is a real state and is reported as one.
 *  3. **Proof of work is mined before signing, and never faked afterwards.** The
 *     `nonce` tag changes the id the signature covers, so mining after signing
 *     would produce an event with an invalid signature — the order is not a
 *     preference. Running out of time is an expected outcome rather than an error:
 *     the note is published without the work, because most relays accept it and
 *     losing a note the user wrote is worse than losing its zeros, but the outcome
 *     travels back with the result so the surface can say which happened. What is
 *     never acceptable is reporting work that is not in the id.
 */
export function usePublish(): Publisher {
  const engine = useEngine();
  const { session } = useSession();
  const { powDifficulty } = useDeviceSettings();
  // Destructured because `publish` closes over `mine`, and `mine` is stable while
  // the runner object is not: depending on the object would give `publish` a new
  // identity on every progress tick, and callers keep it in their own dependency
  // arrays. One of those is an effect away from a render loop.
  const { mine, progress, skip } = usePow();
  const [state, setState] = useState<PublishState>({ status: "idle" });

  const publish = useCallback(
    async (template: EventTemplate, alsoTo: readonly string[] = []) => {
      if (!session?.canSign) {
        const error = "this session cannot sign";
        setState({ status: "failed", error });
        throw new Error(error);
      }

      setState({ status: "signing" });

      const plan = miningPlan(powDifficulty);
      let toSign = template;
      // The requested difficulty is kept separate from the plan: an unreachable one
      // still has to be *reported* as the difficulty that was asked for, otherwise
      // "published without proof of work" reads as if nothing had been configured.
      let outcome: PowAttemptOutcome | undefined;
      if (plan.kind === "unreachable") {
        outcome = "unreachable";
      } else if (plan.kind === "mine") {
        // `created_at` is pinned here, before mining, because a signer given a
        // template without one fills in its own — a different timestamp is a
        // different id, and the nonce would be worthless.
        const unsigned = unsignedForMining(
          template,
          session.pubkey,
          Math.floor(Date.now() / 1000),
        );
        const attempt = await mine(unsigned, plan);
        outcome = attempt.outcome;
        if (attempt.outcome === "mined") {
          toSign = templateFromMined(template, attempt.event);
        }
      }

      let event: NostrEvent;
      try {
        event = await session.signer.signEvent(toSign);
      } catch (cause) {
        // A declined extension prompt lands here and is not an error worth
        // shouting about — it is the user saying no.
        const error =
          cause instanceof Error ? cause.message : "signing was declined";
        setState({ status: "failed", error });
        throw cause;
      }

      // Graded against the id that was actually signed, not against what the miner
      // reported: the signer sits in between and may have changed the event.
      const summary =
        outcome === undefined
          ? undefined
          : summarisePow({
              requested: plan.kind === "off" ? 0 : plan.targetBits,
              outcome,
              signedId: event.id,
            });

      setState({ status: "publishing", event });

      const writeRelays = await engine.outbox
        .writeRelays(session.pubkey)
        .catch(() => engine.relays);
      const own = writeRelays.length > 0 ? writeRelays : engine.relays;
      // Union, deduplicated: an `alsoTo` relay that is already in the write set must
      // not be published to twice, or the per-relay results would double-count and a
      // "sent to 5 of 4 relays" line would appear.
      const targets = [...new Set([...own, ...alsoTo])];

      // `publish` writes to the local store before any relay answers, so the
      // note appears in the feed through the normal store path immediately.
      const results = await engine.subscriptions.publish(event, targets);

      const accepted = results.some((r) => r.ok);
      if (accepted) {
        setState({ status: "sent", event, results, pow: summary });
      } else {
        const reason =
          results.find((r) => r.message)?.message ??
          "no relay accepted the note";
        setState({ status: "failed", error: reason });
      }
      return { event, results, accepted, pow: summary };
    },
    [engine, session, powDifficulty, mine],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  // Mining progress is folded into the state the callers already watch, so a screen
  // that only knows about `signing` keeps working and one that wants the detail can
  // read it without a second hook.
  const observed: PublishState =
    state.status === "signing" && progress
      ? { status: "signing", mining: progress }
      : state;

  return { state: observed, publish, skipMining: skip, reset };
}
