import { Kind, type NostrEvent } from "@setu/protocol";
import { useCallback, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { useSharedStoreQuery } from "../../engine/sharedStoreQuery";
import { useSharedSubscription } from "../../engine/sharedSubscription";
import { usePublish } from "../compose/usePublish";
import { useSession } from "../identity/SessionProvider";
import {
  editCommunityList,
  isJoined,
  isPlausibleCommunityWrite,
  listedCommunities,
} from "./communityList";

/**
 * The communities this account follows (NIP-51 kind 10004), and joining or leaving.
 *
 * Read and write in one hook because they are the same document, and a separate
 * reader would give the join button a second, independently-stale copy of the list
 * it is about to replace.
 *
 * The write repeats the discipline from `useFollowAction` rather than sharing it —
 * for the same reason `useApplyFollowPack` does. Every replaceable list in this app
 * follows the same four steps, but the *plausibility rule* differs per list, and a
 * shared helper is how the wrong rule ends up applied to the wrong document.
 *
 * Joining is public: kind 10004 is an unencrypted list of `a` tags on relays anyone
 * can read. The button's caption says so, because "join" in most software means a
 * private membership record on a server, and this is closer to a public follow.
 */

const FETCH_TIMEOUT_MS = 6000;

export type MembershipState =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly address: string }
  | { readonly status: "error"; readonly message: string };

export interface CommunityMembership {
  /** Community addresses this account follows. */
  readonly joined: readonly string[];
  /** False until a kind-10004 has actually been seen for this account. */
  readonly loaded: boolean;
  readonly state: MembershipState;
  isJoined(address: string): boolean;
  toggle(address: string, relayHint?: string): Promise<boolean>;
  dismissError(): void;
}

interface ListSnapshot {
  readonly event: NostrEvent | undefined;
  readonly joined: readonly string[];
  readonly loaded: boolean;
}

const EMPTY: ListSnapshot = { event: undefined, joined: [], loaded: false };

function project(rows: readonly { event: NostrEvent }[]): ListSnapshot {
  // The store resolves replaceable last-write-wins, so row 0 is the newest.
  const newest = rows[0]?.event;
  if (!newest) return EMPTY;
  return { event: newest, joined: listedCommunities(newest), loaded: true };
}

export function useCommunityMembership(): CommunityMembership {
  const engine = useEngine();
  const { session } = useSession();
  const { publish } = usePublish();
  const [state, setState] = useState<MembershipState>({ status: "idle" });

  const pubkey = session?.pubkey;
  const filter = useMemo(
    () =>
      pubkey
        ? {
            kinds: [Kind.CommunityList],
            authors: [pubkey],
            limit: REPLACEABLE_LIST_LIMIT,
          }
        : undefined,
    [pubkey],
  );

  useSharedSubscription(filter);
  const snapshot = useSharedStoreQuery({
    key: pubkey ? `communities:${pubkey}` : "",
    filter,
    project,
    initial: EMPTY,
  });

  const toggle = useCallback(
    async (address: string, relayHint?: string): Promise<boolean> => {
      if (!session?.canSign) {
        setState({
          status: "error",
          message: "This session cannot sign, so it cannot join a community.",
        });
        return false;
      }
      setState({ status: "working", address });

      // Re-fetched from the relays, never taken from the local copy: the local
      // one may be a page behind, and a stale base for a replaceable write drops
      // whatever arrived since.
      const listFilter = {
        kinds: [Kind.CommunityList],
        authors: [session.pubkey],
        limit: REPLACEABLE_LIST_LIMIT,
      };
      let fetched: readonly NostrEvent[] = [];
      try {
        fetched = await Promise.race([
          engine.subscriptions.fetch({
            filters: engine.relays.map((relay) => ({
              relay,
              filter: listFilter,
            })),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out")), FETCH_TIMEOUT_MS),
          ),
        ]);
      } catch {
        setState({
          status: "error",
          message:
            "Could not reach the relays to read your community list. Nothing was changed.",
        });
        return false;
      }

      const current = [...fetched]
        .filter((event) => event.kind === Kind.CommunityList)
        .sort((a, b) => b.created_at - a.created_at)[0];

      const health = engine.pool.health();
      const connected = health.filter((r) => r.status === "connected").length;
      const absenceConfirmed =
        engine.relays.length > 0 && connected === engine.relays.length;

      const edit = editCommunityList({
        current,
        absenceConfirmed,
        address,
        action: isJoined(current, address) ? "leave" : "join",
        ...(relayHint ? { relayHint } : {}),
      });

      if (!edit.ok) {
        if (edit.reason === "no-change") {
          // Our view was out of date and the network already agrees.
          setState({ status: "idle" });
          return true;
        }
        setState({
          status: "error",
          message:
            "No community list was found, and not every relay answered, so Setu " +
            "cannot tell whether you have one. Publishing now could erase it.",
        });
        return false;
      }

      if (!isPlausibleCommunityWrite(current, edit.template)) {
        setState({
          status: "error",
          message:
            "That edit would have changed far more than one community, so it was blocked.",
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
              "No relay accepted the updated list.",
          });
          return false;
        }
        setState({ status: "idle" });
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

  return {
    joined: snapshot.joined,
    loaded: snapshot.loaded,
    state,
    isJoined: (address) => snapshot.joined.includes(address),
    toggle,
    dismissError: () => setState({ status: "idle" }),
  };
}
