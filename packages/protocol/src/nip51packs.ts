/**
 * NIP-51 follow packs (kind 39089): a curated list of people, published as an
 * addressable event so anyone can share one.
 *
 * The reason this is worth having is the first five minutes. A brand-new Nostr
 * account follows nobody, so its feed is empty, and an empty feed is
 * indistinguishable from a broken client. Every remedy that does not involve
 * following someone is a workaround — search needs a name you do not know, and a
 * global firehose is a wall of strangers. A follow pack is somebody's answer to
 * "who should I read", published in a form a client can apply in one action.
 *
 * ## Parsed defensively, because these are made to be shared
 *
 * A pack is an event from a stranger, surfaced to a user who is about to *follow
 * people based on it*. So:
 *
 *  - **`p` tags are validated as 32-byte hex and deduplicated.** A malformed entry
 *    silently becomes a follow of nothing, and a duplicated one inflates the count
 *    the user is deciding on.
 *  - **Empty packs are parsed but recognisable.** `pubkeys: []` is a real state — a
 *    pack whose author cleared it — and a caller must be able to say "this pack is
 *    empty" rather than showing an inviting button that follows nobody.
 *  - **Nothing here follows anyone.** This module reads; applying a pack is a
 *    kind-3 edit, which lives behind the app's existing follow-list write rules
 *    (re-fetch, confirm absence, merge, never replace from a stale copy). Those
 *    rules exist because a bad kind-3 write silently unfollows everyone, and a
 *    convenience feature is not a reason to route around them.
 *
 * ## `image` and `description` are optional and untrusted
 *
 * Rendered by the app, so they carry the same warning as any other stranger-authored
 * string: the image URL is checked for an http(s) scheme here, and the description
 * is plain text the caller must not treat as markup.
 */

import { isHex32 } from "./hex";
import { Kind } from "./kinds";
import { dTag } from "./tags";
import type { Hex32, NostrEvent } from "./types";

export interface FollowPack {
  /** The `d` tag — identifies the pack within its author's namespace. */
  readonly identifier: string;
  readonly author: Hex32;
  /** `title` tag, or the identifier when the author set none. */
  readonly title: string;
  readonly description?: string;
  /** `image`/`picture` tag, only when it is an http(s) URL. */
  readonly image?: string;
  /** Distinct, well-formed pubkeys. May be empty — see the module doc. */
  readonly pubkeys: readonly Hex32[];
  readonly createdAt: number;
  /** `kind:pubkey:d`, for addressing the pack itself. */
  readonly address: string;
}

/** http(s) only. The value is an arbitrary string from a stranger's event. */
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

/**
 * Parse a kind-39089 into a pack, or `undefined` when it is not one.
 *
 * A pack with no `d` tag is rejected rather than given a synthetic one: `d` is what
 * makes an addressable event addressable, and inventing one would produce a pack
 * that cannot be re-fetched, deduplicated against, or replaced by its own author.
 */
export function parseFollowPack(event: NostrEvent): FollowPack | undefined {
  if (event.kind !== Kind.FollowPack) return undefined;
  const identifier = dTag(event);
  if (identifier === undefined || identifier === "") return undefined;

  const pubkeys: Hex32[] = [];
  const seen = new Set<string>();
  let title: string | undefined;
  let description: string | undefined;
  let image: string | undefined;

  for (const tag of event.tags) {
    const value = tag[1];
    switch (tag[0]) {
      case "p": {
        // Validated, not trusted: a malformed entry would become a follow of
        // nothing, and a duplicate would inflate the number the user decides on.
        const lower = value?.toLowerCase();
        if (lower && isHex32(lower) && !seen.has(lower)) {
          seen.add(lower);
          pubkeys.push(lower as Hex32);
        }
        break;
      }
      case "title":
        title ??= value;
        break;
      case "description":
        description ??= value;
        break;
      case "image":
      case "picture":
        image ??= safeImage(value);
        break;
      default:
        break;
    }
  }

  const trimmedTitle = title?.trim();
  return {
    identifier,
    author: event.pubkey as Hex32,
    // The identifier is a poor title but a true one; a pack with no `title` tag
    // still has to be nameable in a list.
    title: trimmedTitle && trimmedTitle !== "" ? trimmedTitle : identifier,
    ...(description?.trim() ? { description: description.trim() } : {}),
    ...(image ? { image } : {}),
    pubkeys,
    createdAt: event.created_at,
    address: `${Kind.FollowPack}:${event.pubkey}:${identifier}`,
  };
}

/**
 * Newest pack per address, from a set of events.
 *
 * Kind 39089 is addressable, so a relay may legitimately hold several versions and
 * the store's last-write-wins does not span relays that answered separately.
 * Resolving here means a list never shows one pack twice with different contents.
 */
export function newestFollowPacks(
  events: readonly NostrEvent[],
): readonly FollowPack[] {
  const byAddress = new Map<string, FollowPack>();
  for (const event of events) {
    const pack = parseFollowPack(event);
    if (pack === undefined) continue;
    const held = byAddress.get(pack.address);
    // NIP-01 tiebreak on equal timestamps is the lower id, so the comparison is
    // strict — otherwise two relays' copies could alternate on every render.
    if (held === undefined || pack.createdAt > held.createdAt) {
      byAddress.set(pack.address, pack);
    }
  }
  return [...byAddress.values()];
}

/**
 * The members of a pack not already followed.
 *
 * Exported because it is what a UI must show *before* the user commits: "follow 24
 * people" and "follow 3 people you are missing" are different decisions, and the
 * second is the honest one for someone applying a second pack.
 */
export function newMembers(
  pack: FollowPack,
  alreadyFollowing: ReadonlySet<string>,
): readonly Hex32[] {
  return pack.pubkeys.filter((pubkey) => !alreadyFollowing.has(pubkey));
}
