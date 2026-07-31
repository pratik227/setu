import { Kind, type NostrEvent } from "@setu/protocol";
import { useCallback, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { usePublish } from "../compose/usePublish";
import { editFollowList, isPlausibleFollowWrite } from "./followList";
import { useSession } from "./SessionProvider";

export type FollowActionState =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly target: string }
  | { readonly status: "done"; readonly target: string }
  | { readonly status: "error"; readonly message: string };

export interface FollowAction {
  readonly state: FollowActionState;
  /** Follow or unfollow. Resolves true only when a relay accepted the write. */
  toggle(target: string, currentlyFollowing: boolean): Promise<boolean>;
  reset(): void;
}

/** How long to wait for relays to answer with the newest list. */
const FETCH_TIMEOUT_MS = 6000;

/**
 * Follow and unfollow, safely.
 *
 * The dangerous part of a follow button is not the write, it is the read that
 * precedes it. A kind-3 replaces the previous one wholesale, so publishing a
 * list assembled from a stale or partial fetch deletes everyone missing from our
 * copy. So every toggle:
 *
 *  1. **re-fetches** the newest kind-3 from the relays rather than trusting the
 *     copy already in the store;
 *  2. **requires every configured relay to be connected** before it will accept
 *     "you have no list" as true. A partial answer and a genuinely empty account
 *     look identical, and guessing wrong replaces a real list with one entry;
 *  3. **merges** into the fetched event, preserving `content`, non-`p` tags,
 *     petnames and relay hints (see `followList.ts`);
 *  4. **re-checks plausibility** — a write that moves the follow count by more
 *     than one is treated as a bug and blocked before it reaches a relay.
 *
 * The cost is that an unreachable relay blocks a *first* follow, and that is the
 * correct trade: refusing is recoverable, publishing a truncated list is not.
 */
export function useFollowAction(): FollowAction {
  const engine = useEngine();
  const { session } = useSession();
  const { publish } = usePublish();
  const [state, setState] = useState<FollowActionState>({ status: "idle" });

  const toggle = useCallback(
    async (target: string, currentlyFollowing: boolean) => {
      if (!session?.canSign) {
        setState({
          status: "error",
          message: "This session cannot sign, so it cannot change follows.",
        });
        return false;
      }
      if (target === session.pubkey) {
        setState({ status: "error", message: "You cannot follow yourself." });
        return false;
      }

      setState({ status: "working", target });

      const filter = {
        kinds: [Kind.Contacts],
        authors: [session.pubkey],
        limit: REPLACEABLE_LIST_LIMIT,
      };
      let fetched: readonly NostrEvent[] = [];
      try {
        fetched = await Promise.race([
          engine.subscriptions.fetch({
            filters: engine.relays.map((relay) => ({ relay, filter })),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out")), FETCH_TIMEOUT_MS),
          ),
        ]);
      } catch {
        setState({
          status: "error",
          message:
            "Could not reach the relays to read your current follow list. Nothing was changed.",
        });
        return false;
      }

      // Newest wins. The store enforces this for replaceable kinds too, but the
      // decision is explicit here because it is load-bearing.
      const current = [...fetched]
        .filter((event) => event.kind === Kind.Contacts)
        .sort((a, b) => b.created_at - a.created_at)[0];

      const health = engine.pool.health();
      const connected = health.filter((r) => r.status === "connected").length;
      const absenceConfirmed =
        engine.relays.length > 0 && connected === engine.relays.length;

      const edit = editFollowList({
        current,
        absenceConfirmed,
        target,
        action: currentlyFollowing ? "unfollow" : "follow",
      });

      if (!edit.ok) {
        if (edit.reason === "no-change") {
          // Our view of the list was out of date; the network already agrees.
          setState({ status: "done", target });
          return true;
        }
        const unreachable = health
          .filter((r) => r.status !== "connected")
          .map((r) => r.url);
        setState({
          status: "error",
          message:
            "No follow list was found, and not every relay answered, so Setu " +
            "cannot tell whether you have one. Publishing now could erase it. " +
            (unreachable.length > 0
              ? `Unreachable: ${unreachable.join(", ")}.`
              : ""),
        });
        return false;
      }

      if (!isPlausibleFollowWrite(current, edit.template)) {
        setState({
          status: "error",
          message:
            "That edit would change far more than one follow, so it was blocked. " +
            "This is a bug, not something you did.",
        });
        return false;
      }

      try {
        const outcome = await publish(edit.template);
        if (!outcome.accepted) {
          setState({
            status: "error",
            message:
              outcome.results.find((r) => r.message)?.message ??
              "No relay accepted the updated follow list.",
          });
          return false;
        }
        setState({ status: "done", target });
        return true;
      } catch (cause) {
        setState({
          status: "error",
          message:
            cause instanceof Error ? cause.message : "Signing was declined.",
        });
        return false;
      }
    },
    [engine, publish, session],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, toggle, reset };
}
