/**
 * NIP-72 moderated communities: kind 34550 defines one, kind 4550 approves a post
 * into it.
 *
 * The model is worth stating plainly because everything else here follows from it:
 * **a post is not in a community because its author said so.** Anyone can tag any
 * event with a community address — that is a *request*. It becomes community content
 * only when a moderator publishes a kind-4550 approval naming it. So a client that
 * renders every `a`-tagged post as the community's content has not implemented
 * moderation, it has implemented an unmoderated hashtag while displaying a
 * moderator list, which is worse than not supporting communities at all.
 *
 * ## Three things are verified, and none of them can be skipped
 *
 * 1. **The approver is a moderator of *this* community.** A kind-4550 from anyone
 *    else is a stranger's opinion. It is not enough that the event is well formed;
 *    the author must appear in the community definition's moderator list.
 * 2. **The approval names the community it claims to.** Its `a` tag must match the
 *    address being viewed — otherwise an approval for community X would admit a post
 *    into community Y.
 * 3. **The embedded copy is verified before it is trusted.** NIP-72 puts the whole
 *    approved event in the approval's `content` so a client can render without a
 *    second fetch. That copy is written by the *moderator*, so taking it at face
 *    value lets a moderator publish an approval whose embedded content says
 *    something the author never wrote — a forged post attributed to a real person,
 *    carrying their pubkey. {@link approvedPost} therefore recomputes the id and
 *    checks the signature, and rejects a mismatch outright.
 *
 * ## What this module deliberately does not decide
 *
 * Whether to *show* an unapproved post. A community screen showing only approved
 * content is the correct default, but a moderator reviewing the queue needs the
 * opposite, and an author wants to see their own pending post. Those are surface
 * decisions; this module reports approval status as a fact and lets the caller
 * choose.
 */

import { computeEventId, verifyEventSignature } from "./event";
import { isHex32 } from "./hex";
import { Kind } from "./kinds";
import { dTag, parseAddress } from "./tags";
import type { EventTemplate, Hex32, NostrEvent } from "./types";

/** Community definition (addressable). */
export const COMMUNITY_KIND = 34550;
/** A moderator's approval of one post. */
export const COMMUNITY_APPROVAL_KIND = 4550;

/** Where a community asks for different kinds of traffic to go. */
export interface CommunityRelays {
  /** Where posts should be published. */
  readonly author: readonly string[];
  /** Where approval requests are collected. */
  readonly requests: readonly string[];
  /** Where moderators publish approvals. */
  readonly approvals: readonly string[];
  /** Relays given with no marker — usable for anything. */
  readonly all: readonly string[];
}

export interface Community {
  readonly identifier: string;
  readonly author: Hex32;
  /** `name` tag, falling back to the identifier so a community is nameable. */
  readonly name: string;
  readonly description?: string;
  readonly image?: string;
  /**
   * Pubkeys allowed to approve posts. **Always includes the community's own
   * author**, per the spec: the creator moderates their own community even
   * without a self-referencing `p` tag, and omitting them would make a community
   * whose author forgot that tag permanently unmoderatable.
   */
  readonly moderators: readonly Hex32[];
  readonly relays: CommunityRelays;
  readonly createdAt: number;
  /** `34550:<pubkey>:<identifier>` */
  readonly address: string;
}

/** http(s) only — an arbitrary string from a stranger's event. */
function safeImage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** The address of a community, from its parts. */
export function communityAddress(author: string, identifier: string): string {
  return `${COMMUNITY_KIND}:${author}:${identifier}`;
}

/**
 * Parse a kind-34550.
 *
 * Rejected without a `d` tag: `d` is what makes the community addressable, and a
 * synthetic one would produce a community that posts cannot reference and its own
 * author cannot replace.
 */
export function parseCommunity(event: NostrEvent): Community | undefined {
  if (event.kind !== COMMUNITY_KIND) return undefined;
  const identifier = dTag(event);
  if (identifier === undefined || identifier === "") return undefined;

  let name: string | undefined;
  let description: string | undefined;
  let image: string | undefined;
  const moderators: Hex32[] = [];
  const seenModerator = new Set<string>();
  const author: string[] = [];
  const requests: string[] = [];
  const approvals: string[] = [];
  const all: string[] = [];

  for (const tag of event.tags) {
    const value = tag[1];
    switch (tag[0]) {
      case "name":
        name ??= value;
        break;
      case "description":
        description ??= value;
        break;
      case "image":
        image ??= safeImage(value);
        break;
      case "p": {
        // The marker is what grants moderation. A bare `p` tag on a community is
        // a mention, not a moderator, and treating it as one would hand approval
        // rights to anyone the description happened to reference.
        if (tag[3] !== "moderator") break;
        const pubkey = value?.toLowerCase();
        if (pubkey && isHex32(pubkey) && !seenModerator.has(pubkey)) {
          seenModerator.add(pubkey);
          moderators.push(pubkey as Hex32);
        }
        break;
      }
      case "relay": {
        if (!value) break;
        switch (tag[2]) {
          case "author":
            author.push(value);
            break;
          case "requests":
            requests.push(value);
            break;
          case "approvals":
            approvals.push(value);
            break;
          default:
            all.push(value);
            break;
        }
        break;
      }
      default:
        break;
    }
  }

  // The creator always moderates — see the field doc.
  const creator = event.pubkey.toLowerCase() as Hex32;
  if (!seenModerator.has(creator)) moderators.unshift(creator);

  const trimmedName = name?.trim();
  return {
    identifier,
    author: creator,
    name: trimmedName && trimmedName !== "" ? trimmedName : identifier,
    ...(description?.trim() ? { description: description.trim() } : {}),
    ...(image ? { image } : {}),
    moderators,
    relays: { author, requests, approvals, all },
    createdAt: event.created_at,
    address: communityAddress(creator, identifier),
  };
}

/** Newest definition per address — a relay may hold several versions. */
export function newestCommunities(
  events: readonly NostrEvent[],
): readonly Community[] {
  const byAddress = new Map<string, Community>();
  for (const event of events) {
    const community = parseCommunity(event);
    if (community === undefined) continue;
    const held = byAddress.get(community.address);
    if (held === undefined || community.createdAt > held.createdAt) {
      byAddress.set(community.address, community);
    }
  }
  return [...byAddress.values()];
}

export interface CommunityApproval {
  /** The community this approval is for. */
  readonly address: string;
  /** The approved post's id. */
  readonly postId: Hex32;
  /** Who approved it. Must be checked against the community's moderators. */
  readonly approver: Hex32;
  /** The post's author, per the approval's `p` tag. */
  readonly postAuthor?: Hex32;
  /** The post's kind, per the `k` tag. */
  readonly postKind?: number;
  /** The moderator's embedded copy. **Unverified** — see {@link approvedPost}. */
  readonly embedded?: NostrEvent;
  readonly createdAt: number;
}

/** Parse the embedded copy without trusting it. Shape only. */
function embeddedEvent(content: string): NostrEvent | undefined {
  if (content.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const event = parsed as NostrEvent;
    return typeof event.id === "string" && typeof event.sig === "string"
      ? event
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a kind-4550. Returns `undefined` when it does not name a post. */
export function parseApproval(
  event: NostrEvent,
): CommunityApproval | undefined {
  if (event.kind !== COMMUNITY_APPROVAL_KIND) return undefined;

  let address: string | undefined;
  let postId: string | undefined;
  let postAuthor: string | undefined;
  let postKind: number | undefined;

  for (const tag of event.tags) {
    const value = tag[1];
    switch (tag[0]) {
      case "a": {
        if (address !== undefined || !value) break;
        // Only a community coordinate counts. An `a` tag pointing at some other
        // addressable kind is not an approval into a community.
        const parsedAddress = parseAddress(value);
        if (parsedAddress?.kind === COMMUNITY_KIND) address = value;
        break;
      }
      case "e":
        if (postId === undefined && value && isHex32(value.toLowerCase())) {
          postId = value.toLowerCase();
        }
        break;
      case "p":
        if (postAuthor === undefined && value && isHex32(value.toLowerCase())) {
          postAuthor = value.toLowerCase();
        }
        break;
      case "k": {
        const parsedKind = Number(value);
        if (postKind === undefined && Number.isInteger(parsedKind)) {
          postKind = parsedKind;
        }
        break;
      }
      default:
        break;
    }
  }

  if (address === undefined || postId === undefined) return undefined;

  const embedded = embeddedEvent(event.content);
  return {
    address,
    postId: postId as Hex32,
    approver: event.pubkey.toLowerCase() as Hex32,
    ...(postAuthor ? { postAuthor: postAuthor as Hex32 } : {}),
    ...(postKind !== undefined ? { postKind } : {}),
    ...(embedded ? { embedded } : {}),
    createdAt: event.created_at,
  };
}

/** True when this approval was written by a moderator of this community. */
export function isModerator(community: Community, pubkey: string): boolean {
  return community.moderators.includes(pubkey.toLowerCase() as Hex32);
}

/**
 * True when `approval` genuinely admits a post into `community`.
 *
 * Both halves matter and both have been shipped wrong by real clients: an approval
 * from a non-moderator is a stranger's opinion, and an approval whose `a` tag names
 * a *different* community would otherwise admit a post into one whose moderators
 * never saw it.
 */
export function approvalApplies(
  approval: CommunityApproval,
  community: Community,
): boolean {
  return (
    approval.address === community.address &&
    isModerator(community, approval.approver)
  );
}

/**
 * The post an approval admits, taken from the safest source available.
 *
 * `held` is the event as this device received it from a relay, when we have it —
 * always preferred, because it did not pass through the moderator. Otherwise the
 * embedded copy is used, but only after recomputing its id and checking its
 * signature: the copy is authored by the moderator, so an unverified one lets a
 * moderator publish arbitrary content attributed to somebody else's pubkey.
 *
 * Returns `undefined` when neither source yields an event that verifies, which the
 * caller must treat as "this approval names a post we cannot show" rather than as
 * an absence of moderation.
 */
export function approvedPost(
  approval: CommunityApproval,
  held?: NostrEvent,
): NostrEvent | undefined {
  if (held !== undefined && held.id === approval.postId) return held;

  const embedded = approval.embedded;
  if (embedded === undefined) return undefined;
  // The approval's own `e` tag is the claim; the copy must match it, or a
  // moderator could approve one post and embed another.
  if (embedded.id !== approval.postId) return undefined;
  if (computeEventId(embedded) !== embedded.id) return undefined;
  if (!verifyEventSignature(embedded)) return undefined;
  return embedded;
}

/** Add a community tag to a post template, so it reaches the moderators. */
export function tagForCommunity(
  template: EventTemplate,
  community: Community,
): EventTemplate {
  const relay = community.relays.requests[0] ?? community.relays.all[0] ?? "";
  return {
    ...template,
    tags: [...(template.tags ?? []), ["a", community.address, relay]],
  };
}

/**
 * Build a moderator's approval of `post`.
 *
 * The whole post goes in `content` per the spec, which is what lets other clients
 * render it without a second fetch — and what {@link approvedPost} re-verifies at
 * the other end rather than trusting.
 */
export function buildApproval(
  post: NostrEvent,
  community: Community,
  now: number,
): EventTemplate {
  const relay = community.relays.approvals[0] ?? community.relays.all[0] ?? "";
  return {
    kind: COMMUNITY_APPROVAL_KIND,
    created_at: Math.floor(now),
    content: JSON.stringify(post),
    tags: [
      ["a", community.address, relay],
      ["e", post.id, relay],
      ["p", post.pubkey, relay],
      ["k", String(post.kind)],
    ],
  };
}

/** The kinds a community post may be. Anything else is not community content. */
export const COMMUNITY_POST_KINDS: readonly number[] = [
  Kind.ShortTextNote,
  Kind.Comment,
];

/** Community addresses a post claims membership of, via its `a` tags. */
export function claimedCommunities(event: NostrEvent): readonly string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "a" || !tag[1]) continue;
    if (
      parseAddress(tag[1])?.kind === COMMUNITY_KIND &&
      !out.includes(tag[1])
    ) {
      out.push(tag[1]);
    }
  }
  return out;
}
