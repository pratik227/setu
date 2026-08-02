import { type FollowPack, Kind, type NostrEvent } from "@setu/protocol";
import { useCallback, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { usePublish } from "../compose/usePublish";
import { followManyEdit, isPlausibleBulkFollow } from "../identity/followList";
import { useSession } from "../identity/SessionProvider";

/**
 * Applying a follow pack: one kind-3 write, under the same rules as any other.
 *
 * A pack adds many people at once, which makes it the single most destructive
 * write in the app if it goes wrong — a kind-3 is replaceable, so a bad merge does
 * not add a mistake, it *replaces the list*. The discipline is therefore identical
 * to `useFollowAction`'s and is repeated here rather than shared, because the two
 * differ in exactly one respect (the plausibility rule) and hiding that difference
 * behind a shared helper is how the wrong rule ends up applied:
 *
 *  1. **Re-fetch the newest kind-3 from the relays**, never trust the local copy.
 *  2. **Refuse unless every configured relay answered**, when no list was found. A
 *     partial answer and a genuinely absent list are indistinguishable, and
 *     guessing wrong replaces a real list with the pack's members alone.
 *  3. **Merge into the fetched event**, preserving unknown tags and `content`.
 *  4. **Check plausibility before publishing** — here, that the count did not
 *     *fall*. Applying a pack is purely additive.
 *
 * The one thing this does not do is ask twice. The confirmation belongs to the UI,
 * which knows how many people are actually new.
 */

/** How long to wait for relays to answer with the newest list. */
const FETCH_TIMEOUT_MS = 6000;

export type ApplyPackState =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly address: string }
  | {
      readonly status: "done";
      readonly address: string;
      readonly added: number;
    }
  | { readonly status: "error"; readonly message: string };

export interface ApplyPackApi {
  readonly state: ApplyPackState;
  /** Resolves true when a relay accepted the new list. */
  apply(pack: FollowPack): Promise<boolean>;
  reset(): void;
}

export function useApplyFollowPack(): ApplyPackApi {
  const engine = useEngine();
  const { session } = useSession();
  const { publish } = usePublish();
  const [state, setState] = useState<ApplyPackState>({ status: "idle" });

  const apply = useCallback(
    async (pack: FollowPack): Promise<boolean> => {
      if (!session?.canSign) {
        setState({
          status: "error",
          message: "This session cannot sign, so it cannot change follows.",
        });
        return false;
      }

      setState({ status: "working", address: pack.address });

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

      const current = [...fetched]
        .filter((event) => event.kind === Kind.Contacts)
        .sort((a, b) => b.created_at - a.created_at)[0];

      const health = engine.pool.health();
      const connected = health.filter((r) => r.status === "connected").length;
      const absenceConfirmed =
        engine.relays.length > 0 && connected === engine.relays.length;

      // Never follow yourself out of a pack that happens to name you.
      const targets = pack.pubkeys.filter(
        (pubkey) => pubkey !== session.pubkey,
      );

      const edit = followManyEdit({ current, absenceConfirmed, targets });
      if (!edit.ok) {
        if (edit.reason === "no-change") {
          setState({ status: "done", address: pack.address, added: 0 });
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

      if (!isPlausibleBulkFollow(current, edit.template)) {
        setState({
          status: "error",
          message:
            "That edit would have removed people from your follow list, so it " +
            "was blocked. Nothing was published.",
        });
        return false;
      }

      const before = (current?.tags ?? []).filter((t) => t[0] === "p").length;
      const after = (edit.template.tags ?? []).filter(
        (t) => t[0] === "p",
      ).length;

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
        setState({
          status: "done",
          address: pack.address,
          added: after - before,
        });
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
    [engine, session, publish],
  );

  return { state, apply, reset: () => setState({ status: "idle" }) };
}
