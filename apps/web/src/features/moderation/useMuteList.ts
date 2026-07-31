/**
 * The viewer's mute list (NIP-51 kind 10000), read and written safely.
 *
 * Split in two on purpose. `useMuteRules` is the read half and holds no state of its
 * own, so the surfaces that consult mutes on every row — the feed's row filter, the
 * note row's overflow menu — can call it without acquiring a write path they never
 * use. `useMuteAction` is the write half, and its in-flight state belongs to the one
 * dialog that started the edit rather than to the list.
 *
 * The write half is the dangerous one, and it is the same hazard as the follow and
 * bookmark lists: kind 10000 is *replaceable*, so publishing one built from a stale
 * or partial fetch un-mutes everyone missing from our copy. So every edit:
 *
 *  1. **re-fetches** the newest kind-10000 from the relays rather than trusting the
 *     copy already in the store;
 *  2. **requires every configured relay to be connected** before it will accept
 *     "you have no list" as true — a partial answer and a genuinely empty account
 *     look identical, and guessing wrong replaces a real list with one entry;
 *  3. **merges** into the fetched event, preserving unknown tags and the encrypted
 *     private half in `content` (see `muteList.ts`);
 *  4. **re-checks plausibility** before publishing, and blocks a write that would
 *     lose more than the one entry being changed.
 *
 * The cost is that an unreachable relay blocks a *first* mute. That is the correct
 * trade: refusing is recoverable and says so, publishing a truncated list is neither.
 */

import type { StoredEvent } from "@setu/core";
import {
  type MuteRules,
  muteRulesFrom,
  muteRulesKey,
  NO_MUTES,
} from "@setu/core";
import { Kind, type NostrEvent } from "@setu/protocol";
import { useCallback, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { useSharedStoreQuery } from "../../engine/sharedStoreQuery";
import { usePublish } from "../compose/usePublish";
import { useSession } from "../identity/SessionProvider";
import {
  editMuteList,
  hasPrivateMuteEntries,
  isPlausibleMuteWrite,
  type MuteTarget,
  publicMuteEntries,
} from "./muteList";

/** How long to wait for relays to answer with the newest list. */
const FETCH_TIMEOUT_MS = 6000;

export interface MuteSnapshot {
  /** Parsed rules, for the matcher in `@setu/core`. */
  readonly rules: MuteRules;
  /** Value identity of `rules`, for memoising anything derived from them. */
  readonly rulesKey: string;
  /** The public entries, in list order, for a surface that lists them. */
  readonly entries: readonly MuteTarget[];
  /**
   * False while we have not yet seen a kind-10000 for this account.
   *
   * Distinct from "the list is empty", and the distinction matters in the same way
   * it does for follows: a surface that says "you have muted nobody" before the
   * list has arrived is guessing.
   */
  readonly loaded: boolean;
  /** True when the list carries a NIP-44 private half this client cannot read. */
  readonly hasPrivateEntries: boolean;
}

const EMPTY: MuteSnapshot = {
  rules: NO_MUTES,
  rulesKey: muteRulesKey(NO_MUTES),
  entries: [],
  loaded: false,
  hasPrivateEntries: false,
};

/**
 * One-slot memo over the newest list event.
 *
 * The projection runs on every store tick that touches the matching set, and a
 * fresh object each time would give `rules` a new identity several times a second.
 * The feed's mute pass is memoised on that identity, and a filter that changes
 * identity every render recomputes the feed's bounded metadata window every render —
 * the exact churn `useNoteRowActions` measured as the difference between 112 and
 * 7372 row renders. Keyed on the event id, which for a replaceable kind changes
 * exactly when the list does.
 *
 * Module scope rather than a ref because `useSharedStoreQuery` captures the
 * projection once per key and calls it outside React; one signed-in account at a
 * time means one slot is enough.
 */
let projectionMemo:
  | { readonly id: string; readonly snapshot: MuteSnapshot }
  | undefined;

function projectMutes(events: readonly StoredEvent[]): MuteSnapshot {
  // The store enforces replaceable last-write-wins, so row 0 is the newest.
  const newest = events[0]?.event;
  if (!newest) return EMPTY;
  if (projectionMemo?.id === newest.id) return projectionMemo.snapshot;
  const rules = muteRulesFrom(newest.tags);
  const snapshot: MuteSnapshot = {
    rules,
    rulesKey: muteRulesKey(rules),
    entries: publicMuteEntries(newest),
    loaded: true,
    hasPrivateEntries: hasPrivateMuteEntries(newest),
  };
  projectionMemo = { id: newest.id, snapshot };
  return snapshot;
}

/** The signed-in account's mute list. One subscription for the whole app. */
export function useMuteRules(): MuteSnapshot {
  const { session } = useSession();
  const pubkey = session?.pubkey;

  // Asked of every configured relay: like a follow list, missing the newest copy
  // has destructive consequences on the next write, so breadth beats economy.
  const filter = useMemo(
    () =>
      pubkey
        ? {
            kinds: [Kind.MuteList],
            authors: [pubkey],
            limit: REPLACEABLE_LIST_LIMIT,
          }
        : undefined,
    [pubkey],
  );

  return useSharedStoreQuery({
    key: pubkey ? `mutes:${pubkey}` : "",
    filter,
    project: projectMutes,
    initial: EMPTY,
  });
}

export type MuteActionState =
  | { readonly status: "idle" }
  | { readonly status: "working" }
  | { readonly status: "done" }
  | { readonly status: "error"; readonly message: string };

export interface MuteAction {
  readonly state: MuteActionState;
  /** Mute or un-mute one entry. Resolves true only when a relay accepted. */
  apply(target: MuteTarget, action: "mute" | "unmute"): Promise<boolean>;
  reset(): void;
}

export function useMuteAction(): MuteAction {
  const engine = useEngine();
  const { session } = useSession();
  const { publish } = usePublish();
  const [state, setState] = useState<MuteActionState>({ status: "idle" });

  const apply = useCallback(
    async (target: MuteTarget, action: "mute" | "unmute") => {
      if (!session?.canSign) {
        setState({
          status: "error",
          message:
            "This is a read-only session, so it cannot change your mute list.",
        });
        return false;
      }
      if (target.kind === "pubkey" && target.value === session.pubkey) {
        setState({
          status: "error",
          message: "You cannot mute yourself.",
        });
        return false;
      }

      setState({ status: "working" });

      const filter = {
        kinds: [Kind.MuteList],
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
            "Could not reach the relays to read your current mute list. Nothing was changed.",
        });
        return false;
      }

      // Newest wins. The store enforces this for replaceable kinds too, but the
      // decision is explicit here because it is load-bearing.
      const current = [...fetched]
        .filter((event) => event.kind === Kind.MuteList)
        .sort((a, b) => b.created_at - a.created_at)[0];

      const health = engine.pool.health();
      const connected = health.filter((r) => r.status === "connected").length;
      const absenceConfirmed =
        engine.relays.length > 0 && connected === engine.relays.length;

      const edit = editMuteList({
        current,
        absenceConfirmed,
        target,
        action,
      });

      if (!edit.ok) {
        if (edit.reason === "no-change") {
          // Our view of the list was out of date; the network already agrees.
          setState({ status: "done" });
          return true;
        }
        if (edit.reason === "empty-target") {
          setState({
            status: "error",
            message: "That is not something that can be muted.",
          });
          return false;
        }
        const unreachable = health
          .filter((r) => r.status !== "connected")
          .map((r) => r.url);
        setState({
          status: "error",
          message:
            "No mute list was found, and not every relay answered, so Setu " +
            "cannot tell whether you have one. Publishing now could erase it. " +
            (unreachable.length > 0
              ? `Unreachable: ${unreachable.join(", ")}.`
              : ""),
        });
        return false;
      }

      if (!isPlausibleMuteWrite(current, edit.template)) {
        setState({
          status: "error",
          message:
            "That edit would change far more than one entry, so it was blocked. " +
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
              "No relay accepted the updated mute list.",
          });
          return false;
        }
        // The list itself comes back through the shared store query, so there is
        // nothing to set here beyond clearing the in-flight state.
        setState({ status: "done" });
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

  return { state, apply, reset };
}
