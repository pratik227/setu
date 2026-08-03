import {
  buildApproval,
  type Community,
  isModerator,
  type NostrEvent,
  tagForCommunity,
} from "@setu/protocol";
import { useCallback, useState } from "react";
import { buildNote } from "../compose/buildNote";
import { usePublish } from "../compose/usePublish";
import { useSession } from "../identity/SessionProvider";
import { approvalRelays, submitRelays } from "./communityRelays";

/**
 * The two writes a community accepts: submitting a post, and approving one.
 *
 * Both go through the ordinary `usePublish` — which means both get proof of work,
 * the author's own write relays, and the local echo, for free. What they add is a
 * second set of destinations: a community names the relays its moderators actually
 * read, and a post that only reaches the author's own relays is a post no moderator
 * will ever see. `publish(template, alsoTo)` exists for exactly this.
 *
 * ## Submitting is not posting
 *
 * A submitted post is a *request*. It is a real, signed, published kind-1 that
 * anyone can read — it simply is not community content until a moderator says so.
 * The UI must say that, because the alternative is a user watching their post fail
 * to appear and concluding the client dropped it. {@link SubmitState} carries
 * `submitted` rather than `posted` for that reason.
 *
 * ## Approving is publishing a public statement
 *
 * A kind-4550 is signed by the moderator and says "I admit this". It is not a
 * private flag, it cannot be un-said except by a NIP-09 deletion request that
 * relays may ignore, and it embeds the post — so a moderator approving something
 * is republishing it under their own signature. The surface says so before the
 * button is pressed.
 *
 * ## There is no reject
 *
 * NIP-72 has no rejection event. A moderator declines by *not* approving. Adding a
 * "Reject" button would be a control that publishes nothing and changes nothing
 * anywhere, which is worse than its absence: the moderator would believe the author
 * had been told.
 */

export type SubmitState =
  | { readonly status: "idle" }
  | { readonly status: "working" }
  /** Published and awaiting a moderator. Deliberately not called "posted". */
  | { readonly status: "submitted" }
  | { readonly status: "error"; readonly message: string };

export type ApproveState =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly postId: string }
  | { readonly status: "done"; readonly postId: string }
  | { readonly status: "error"; readonly message: string };

export interface CommunityWrites {
  readonly submitState: SubmitState;
  readonly approveState: ApproveState;
  /** True when the signed-in account may approve posts here. */
  readonly canModerate: boolean;
  submit(content: string): Promise<boolean>;
  approve(post: NostrEvent): Promise<boolean>;
  resetSubmit(): void;
  resetApprove(): void;
}

export function useCommunityWrites(
  community: Community | undefined,
): CommunityWrites {
  const { session } = useSession();
  const { publish } = usePublish();
  const [submitState, setSubmit] = useState<SubmitState>({ status: "idle" });
  const [approveState, setApprove] = useState<ApproveState>({ status: "idle" });

  const canModerate =
    community !== undefined &&
    session?.canSign === true &&
    isModerator(community, session.pubkey);

  const submit = useCallback(
    async (content: string): Promise<boolean> => {
      if (!community || !session?.canSign) {
        setSubmit({
          status: "error",
          message: "This session cannot sign, so it cannot post.",
        });
        return false;
      }
      if (content.trim() === "") return false;

      setSubmit({ status: "working" });
      try {
        // An ordinary note, plus the community's `a` tag. Nothing about the note
        // itself is special — which is the point: it is readable by every client,
        // community-aware or not.
        const template = tagForCommunity(buildNote({ content }), community);
        const outcome = await publish(template, submitRelays(community));
        if (!outcome.accepted) {
          setSubmit({
            status: "error",
            message:
              outcome.results.find((r) => r.message)?.message ??
              "No relay accepted the post.",
          });
          return false;
        }
        setSubmit({ status: "submitted" });
        return true;
      } catch (cause) {
        setSubmit({
          status: "error",
          message:
            cause instanceof Error ? cause.message : "Signing was declined.",
        });
        return false;
      }
    },
    [community, session, publish],
  );

  const approve = useCallback(
    async (post: NostrEvent): Promise<boolean> => {
      if (!community || !session?.canSign) return false;
      // Re-checked here, not just in the UI: the button being hidden is a
      // rendering decision, and an approval from a non-moderator is an event that
      // every correct client will ignore — publishing one wastes a write and
      // tells the user something happened that did not.
      if (!isModerator(community, session.pubkey)) {
        setApprove({
          status: "error",
          message: "You are not a moderator of this community.",
        });
        return false;
      }

      setApprove({ status: "working", postId: post.id });
      try {
        const template = buildApproval(
          post,
          community,
          Math.floor(Date.now() / 1000),
        );
        const outcome = await publish(template, approvalRelays(community));
        if (!outcome.accepted) {
          setApprove({
            status: "error",
            message:
              outcome.results.find((r) => r.message)?.message ??
              "No relay accepted the approval.",
          });
          return false;
        }
        // Cleared by the feed itself: the approval lands in the store and the
        // post moves from pending to approved through the ordinary observer, so
        // there is nothing for this hook to reconcile.
        setApprove({ status: "done", postId: post.id });
        return true;
      } catch (cause) {
        setApprove({
          status: "error",
          message:
            cause instanceof Error ? cause.message : "Signing was declined.",
        });
        return false;
      }
    },
    [community, session, publish],
  );

  return {
    submitState,
    approveState,
    canModerate,
    submit,
    approve,
    resetSubmit: () => setSubmit({ status: "idle" }),
    resetApprove: () => setApprove({ status: "idle" }),
  };
}
