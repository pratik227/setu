import type { Community } from "@setu/protocol";

/**
 * Where a community's two writes have to reach.
 *
 * Pure and separate from the hook because getting this wrong is silent: a
 * submission that goes only to the author's own write relays is a real, published,
 * correctly-tagged post that **no moderator will ever see**, and the author gets no
 * error — just a post that is never approved. Nothing about that failure is visible
 * from the outside, which is exactly the kind of decision worth testing.
 *
 * A community's kind-34550 marks its relays by purpose. The fallbacks below are
 * ordered by how likely a moderator is to be reading:
 *
 *  - `requests` first for a submission — that marker means "this is where we watch
 *    for posts".
 *  - `approvals` first for an approval, for the mirror-image reason.
 *  - Then `author`, then unmarked relays, because a community that marked nothing
 *    still listed the relays it lives on and those are better than nothing.
 *
 * An empty result is fine and must not be treated as an error: `usePublish` always
 * adds the author's own write relays, and plenty of small communities are read on
 * exactly those. The list here is *additional* reach, not the whole destination.
 */

/** Deduplicated, order-preserving concat. */
function ordered(...groups: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const relay of group) {
      if (relay === "" || seen.has(relay)) continue;
      seen.add(relay);
      out.push(relay);
    }
  }
  return out;
}

/** Extra relays a submission should reach, best first. */
export function submitRelays(community: Community): readonly string[] {
  return ordered(
    community.relays.requests,
    community.relays.author,
    community.relays.all,
  );
}

/** Extra relays an approval should reach, best first. */
export function approvalRelays(community: Community): readonly string[] {
  return ordered(
    community.relays.approvals,
    community.relays.author,
    community.relays.all,
  );
}
