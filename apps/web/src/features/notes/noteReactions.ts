/**
 * Which reactions a note has, grouped — including NIP-30 custom emoji.
 *
 * The action row's heart is a *total*: one number for every kind-7 on the note. It
 * cannot answer "what did people react with", and for a custom emoji reaction it
 * cannot even show the emoji — a kind-7 whose content is `:soapbox:` counts as one
 * heart and the image the reactor chose is discarded. This module is the breakdown,
 * and it is a pure function so the grouping rules are testable without a store.
 *
 * Three rules, each of which the obvious `events.length` per emoji gets wrong:
 *
 *  - **One pubkey counts once per emoji.** Someone who published two `🔥`
 *    reactions to the same note — two clients, or a retry — is one person who liked
 *    it, and counting events shows two.
 *  - **A custom emoji groups by shortcode, not by URL.** Two accounts using the
 *    same `:shortcode:` from different emoji sets are reacting with the same thing
 *    as far as the author who defined it is concerned, and splitting them into two
 *    chips reads as two different reactions.
 *  - **`-` is not a reaction here.** NIP-25 makes it an explicit downvote;
 *    `interactionCounts.ts` already excludes it from the like count, and a chip
 *    showing "👎 3" beside the emoji people chose deliberately would misrepresent
 *    a protocol-level flag as an emoji someone picked.
 *
 * Ordering is by count and then by key, never by arrival: a live note re-groups on
 * every arriving reaction, and ties are the common case, so arbitrary tie order
 * would make the chips shuffle under the reader.
 */

import { emojiTagMap, isSoleShortcode, type NostrEvent } from "@setu/protocol";

/** The key `+` and an empty content collapse to, per NIP-25. */
const LIKE_KEY = "+";

/** What a like renders as when the reactor sent the bare `+`. */
const LIKE_LABEL = "❤️";

/** One distinct reaction on a note. */
export interface ReactionGroup {
  /**
   * Grouping identity: the emoji characters, or `:shortcode:` for a custom one.
   * Also the React key, so it must be unique within a note's groups.
   */
  readonly key: string;
  /** What to show when there is no image: the emoji itself, or `❤️` for `+`. */
  readonly label: string;
  /** NIP-30 image URL, present only for a custom emoji reaction. Unvalidated. */
  readonly imageUrl?: string;
  /** Distinct pubkeys that reacted with this. A floor over the sample we hold. */
  readonly count: number;
  /** True when the signed-in account is one of them. */
  readonly viewerReacted: boolean;
}

export interface GroupedReactions {
  readonly groups: readonly ReactionGroup[];
  /** Reaction events considered, before per-pubkey collapsing. */
  readonly events: number;
  /** Distinct accounts that reacted with anything. */
  readonly reactors: number;
}

export const NO_REACTIONS: GroupedReactions = {
  groups: [],
  events: 0,
  reactors: 0,
};

/** Longest reaction content we will render as a chip. */
const MAX_LABEL = 16;

interface Bucket {
  label: string;
  imageUrl?: string;
  readonly pubkeys: Set<string>;
}

/**
 * The chip one kind-7 belongs in, or `undefined` when it belongs in none.
 *
 * A custom emoji is recognised only when the *whole* content is one shortcode the
 * event also declared. A kind-7 with a sentence in it is not an emoji reaction, and
 * rendering a paragraph as a chip destroys the row's layout — so anything longer
 * than a few characters is dropped rather than truncated, since a truncated
 * reaction misrepresents what was sent.
 */
function bucketFor(
  event: NostrEvent,
):
  | { readonly key: string; readonly label: string; readonly imageUrl?: string }
  | undefined {
  const content = event.content.trim();
  if (content === "-") return undefined;
  if (content === "" || content === LIKE_KEY) {
    return { key: LIKE_KEY, label: LIKE_LABEL };
  }

  const emoji = emojiTagMap(event);
  const shortcode = isSoleShortcode(content, new Set(emoji.keys()));
  if (shortcode !== undefined) {
    const url = emoji.get(shortcode);
    return url === undefined
      ? { key: content, label: content }
      : { key: `:${shortcode}:`, label: `:${shortcode}:`, imageUrl: url };
  }

  if (content.length > MAX_LABEL) return undefined;
  return { key: content, label: content };
}

/**
 * Sort reaction events into a stable order before grouping.
 *
 * Only matters for one thing, and it matters enough to pay for: when two accounts
 * use the same shortcode with different image URLs, the chip has to pick one, and
 * picking "whichever arrived first" makes the rendered emoji depend on relay
 * delivery order — so the same note shows different images across a reload.
 */
function ordered(events: readonly NostrEvent[]): readonly NostrEvent[] {
  return [...events].sort((a, b) =>
    a.created_at === b.created_at
      ? a.id.localeCompare(b.id)
      : a.created_at - b.created_at,
  );
}

/** Group a note's reactions. Pure: the same events always give the same chips. */
export function groupReactions(
  events: readonly NostrEvent[],
  viewerPubkey?: string,
): GroupedReactions {
  const buckets = new Map<string, Bucket>();
  const reactors = new Set<string>();
  let considered = 0;

  for (const event of ordered(events)) {
    const bucket = bucketFor(event);
    if (bucket === undefined) continue;
    considered += 1;
    reactors.add(event.pubkey);
    const existing = buckets.get(bucket.key);
    if (existing === undefined) {
      buckets.set(bucket.key, {
        label: bucket.label,
        ...(bucket.imageUrl ? { imageUrl: bucket.imageUrl } : {}),
        pubkeys: new Set([event.pubkey]),
      });
      continue;
    }
    // A pubkey already in the set is not a second reaction — see the module doc.
    existing.pubkeys.add(event.pubkey);
    // First URL wins, and `ordered` above is what makes "first" deterministic.
    if (existing.imageUrl === undefined && bucket.imageUrl !== undefined) {
      existing.imageUrl = bucket.imageUrl;
    }
  }

  const groups = [...buckets.entries()]
    .map(
      ([key, bucket]): ReactionGroup => ({
        key,
        label: bucket.label,
        ...(bucket.imageUrl ? { imageUrl: bucket.imageUrl } : {}),
        count: bucket.pubkeys.size,
        viewerReacted:
          viewerPubkey !== undefined && bucket.pubkeys.has(viewerPubkey),
      }),
    )
    .sort((a, b) =>
      b.count === a.count ? a.key.localeCompare(b.key) : b.count - a.count,
    );

  return { groups, events: considered, reactors: reactors.size };
}
