import type { EventTemplate, NostrEvent } from "@setu/protocol";
import { COMMUNITY_KIND, Kind, parseAddress } from "@setu/protocol";

/**
 * The communities an account follows: NIP-51 kind 10004, a list of `a` tags.
 *
 * Mirrors `notes/bookmarkList.ts` deliberately, down to the shape of the refusals,
 * because it is the same hazard: kind 10004 is **replaceable**, so a write built
 * from a list we failed to fetch does not add one community — it replaces every
 * community the account had with one. The rules that prevent that are the same
 * three used everywhere else in this codebase for a replaceable write:
 *
 *  1. refuse to create a list from an unconfirmed absence,
 *  2. copy every existing tag through byte-for-byte, including ones this build
 *     does not understand and the `content` field (which on a NIP-51 list holds
 *     encrypted *private* entries — regenerating it destroys them),
 *  3. sanity-check the size change before publishing.
 *
 * Joining is public. A kind 10004 is an unencrypted list of `a` tags, so following
 * a community tells anyone reading your relays that you did — worth stating in the
 * UI, and the reason this module does not pretend a "private join" exists.
 */

export type CommunityListRefusal = "unverified-absence" | "no-change";

export type CommunityListResult =
  | { readonly ok: true; readonly template: EventTemplate }
  | { readonly ok: false; readonly reason: CommunityListRefusal };

/** Community addresses in the list, in order, deduplicated. */
export function listedCommunities(
  event: NostrEvent | undefined,
): readonly string[] {
  if (!event) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "a" || !tag[1]) continue;
    // Only community coordinates: a kind-10004 may legitimately carry other `a`
    // tags, and treating one as a community would put a broken row in the list.
    if (parseAddress(tag[1])?.kind !== COMMUNITY_KIND) continue;
    if (seen.has(tag[1])) continue;
    seen.add(tag[1]);
    out.push(tag[1]);
  }
  return out;
}

/** True when the list names this community. */
export function isJoined(
  event: NostrEvent | undefined,
  address: string,
): boolean {
  return listedCommunities(event).includes(address);
}

export interface CommunityListEdit {
  readonly current: NostrEvent | undefined;
  /** True only when every queried relay answered and none held a list. */
  readonly absenceConfirmed: boolean;
  readonly address: string;
  readonly action: "join" | "leave";
  /** Relay hint stored beside the address, when the community named one. */
  readonly relayHint?: string;
}

/** Build the replacement kind-10004 for a join or a leave. */
export function editCommunityList(
  input: CommunityListEdit,
): CommunityListResult {
  const { current, absenceConfirmed, address, action, relayHint } = input;

  if (!current && !absenceConfirmed) {
    return { ok: false, reason: "unverified-absence" };
  }

  const already = isJoined(current, address);
  if (action === "join" && already) return { ok: false, reason: "no-change" };
  if (action === "leave" && !already) return { ok: false, reason: "no-change" };

  const existing = current?.tags ?? [];
  const tags: string[][] = [];

  if (action === "leave") {
    // Every entry for this address, not just the first: a list that named it
    // twice would otherwise still name it once after leaving.
    for (const tag of existing) {
      if (tag[0] === "a" && tag[1] === address) continue;
      tags.push([...tag]);
    }
  } else {
    for (const tag of existing) tags.push([...tag]);
    tags.push(relayHint ? ["a", address, relayHint] : ["a", address]);
  }

  return {
    ok: true,
    template: {
      kind: Kind.CommunityList,
      // Verbatim: on a NIP-51 list this holds encrypted private entries, and
      // blanking it destroys them with no way back.
      content: current?.content ?? "",
      created_at: Math.floor(Date.now() / 1000),
      tags,
    },
  };
}

/**
 * Refuse a write that loses an implausible number of communities.
 *
 * A join or a leave moves the count by exactly one. Anything else is a bug
 * upstream of here, and the cost of publishing it is somebody's whole list.
 */
export function isPlausibleCommunityWrite(
  before: NostrEvent | undefined,
  template: EventTemplate,
): boolean {
  const previous = listedCommunities(before).length;
  const next = (template.tags ?? []).filter(
    (tag) =>
      tag[0] === "a" && parseAddress(tag[1] ?? "")?.kind === COMMUNITY_KIND,
  ).length;
  return Math.abs(next - previous) <= 1;
}
