import {
  approvalApplies,
  approvedPost,
  COMMUNITY_APPROVAL_KIND,
  COMMUNITY_POST_KINDS,
  type Community,
  type NostrEvent,
  parseApproval,
} from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSharedSubscription } from "../../engine/sharedSubscription";

/**
 * The posts a community's moderators have actually admitted.
 *
 * The whole feature lives in what this refuses to show. Anyone can tag a note with
 * a community address; that is a *request*, and rendering requests as community
 * content implements an unmoderated hashtag while displaying a moderator list —
 * strictly worse than not supporting communities, because it lends a moderator's
 * name to posts they never saw.
 *
 * So the feed is built from **approvals**, not from posts:
 *
 *  1. Subscribe to kind-4550 naming this community.
 *  2. Keep only approvals written by one of *its* moderators (`approvalApplies`).
 *  3. Resolve each to a post, preferring the copy this device received from a relay
 *     over the moderator's embedded one, and verifying the embedded one when that is
 *     all there is (`approvedPost` recomputes the id and checks the signature).
 *
 * ## Two subscriptions, not one
 *
 * The approvals are one; the tagged posts are the other. Fetching the posts too
 * looks redundant — every approval embeds its post — but it is what makes step 3
 * able to prefer an untampered copy, and it is also what a moderator's review queue
 * would read. Both are bounded and neither is opened until a community is opened.
 *
 * ## Pending is reported, never rendered as content
 *
 * `pending` counts posts that claim the community and have no valid approval. A
 * surface may say "12 awaiting moderation" — that is a true and useful fact — but
 * must not list them as though they were in.
 */

const APPROVAL_LIMIT = 200;
const POST_LIMIT = 200;

export interface CommunityFeedState {
  /** Approved posts, newest first. Verified — see the module doc. */
  readonly posts: readonly NostrEvent[];
  /**
   * Posts claiming this community with no valid approval, newest first.
   *
   * Exposed as events rather than a count because a moderator has to *act* on
   * them, and a queue cannot be built from a number. Every non-moderator surface
   * must still treat these as pending: they are requests, and rendering them
   * beside approved posts is the failure this whole module exists to prevent.
   */
  readonly pendingPosts: readonly NostrEvent[];
  /** How many are pending. Convenience for surfaces that only disclose a figure. */
  readonly pending: number;
  /**
   * Approvals that named a post this device cannot show — no relay copy, and no
   * usable embedded one. Distinct from "not approved": the moderation happened,
   * the content is missing.
   */
  readonly unresolved: number;
  readonly loaded: boolean;
}

const EMPTY: CommunityFeedState = {
  posts: [],
  pendingPosts: [],
  pending: 0,
  unresolved: 0,
  loaded: false,
};

export function useCommunityFeed(
  community: Community | undefined,
): CommunityFeedState {
  const engine = useEngine();
  const [approvalEvents, setApprovals] = useState<
    readonly NostrEvent[] | undefined
  >();
  const [postEvents, setPosts] = useState<readonly NostrEvent[]>([]);

  const address = community?.address;

  const approvalFilter = useMemo(
    () =>
      address
        ? {
            kinds: [COMMUNITY_APPROVAL_KIND],
            "#a": [address],
            limit: APPROVAL_LIMIT,
          }
        : undefined,
    [address],
  );
  const postFilter = useMemo(
    () =>
      address
        ? {
            kinds: [...COMMUNITY_POST_KINDS],
            "#a": [address],
            limit: POST_LIMIT,
          }
        : undefined,
    [address],
  );

  useSharedSubscription(approvalFilter);
  useSharedSubscription(postFilter);

  useEffect(() => {
    if (!approvalFilter) {
      setApprovals(undefined);
      return;
    }
    setApprovals(undefined);
    return engine.store.observe(approvalFilter, (rows) => {
      setApprovals(rows.map((row) => row.event));
    });
  }, [engine, approvalFilter]);

  useEffect(() => {
    if (!postFilter) {
      setPosts([]);
      return;
    }
    setPosts([]);
    return engine.store.observe(postFilter, (rows) => {
      setPosts(rows.map((row) => row.event));
    });
  }, [engine, postFilter]);

  return useMemo(() => {
    if (community === undefined || approvalEvents === undefined) return EMPTY;

    const held = new Map(postEvents.map((event) => [event.id, event]));
    const posts: NostrEvent[] = [];
    const approved = new Set<string>();
    let unresolved = 0;

    for (const event of approvalEvents) {
      const approval = parseApproval(event);
      if (approval === undefined) continue;
      // The two checks that make this moderation rather than a hashtag.
      if (!approvalApplies(approval, community)) continue;

      // One post, one entry: two moderators approving the same thing is normal
      // and must not double it in the feed.
      if (approved.has(approval.postId)) continue;
      approved.add(approval.postId);

      const post = approvedPost(approval, held.get(approval.postId));
      if (post === undefined) {
        unresolved += 1;
        continue;
      }
      posts.push(post);
    }

    posts.sort((a, b) => b.created_at - a.created_at);

    const pendingPosts = postEvents
      .filter((event) => !approved.has(event.id))
      .sort((a, b) => b.created_at - a.created_at);

    return {
      posts,
      pendingPosts,
      pending: pendingPosts.length,
      unresolved,
      loaded: true,
    };
  }, [community, approvalEvents, postEvents]);
}
