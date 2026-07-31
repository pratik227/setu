import type { FeedDefinition } from "@setu/core";
import { Kind } from "@setu/protocol";

/**
 * The feeds Home can show, and the filters behind them.
 *
 * Split out of the component and kept pure so the load characteristics of each
 * feed are readable in one place. That matters because the difference between
 * these options is not cosmetic — one of them used to be an unbounded firehose,
 * and it was the default.
 *
 * On naming: there is deliberately no "Trending" option. Trending is a ranking
 * over everything published, and computing it needs an indexer that has seen
 * everything published. Setu has no indexer — it has the events this device
 * received from a handful of relays. A ranking of that sample is a real
 * measurement of a real thing, but it is not trending, and labelling it so would
 * be claiming a number we cannot compute. `ranking.ts` makes the same point
 * about the topic and author panels.
 *
 * So the third feed is bounded by time and named for what it is.
 */

export const NOTE_KINDS: readonly number[] = [Kind.ShortTextNote, Kind.Repost];

/** Reply-bearing kinds, added only for the feed that asks for replies. */
const REPLY_KINDS: readonly number[] = [Kind.Comment];

/** How far back the bounded global feed looks. */
export const GLOBAL_WINDOW_SECONDS = 24 * 60 * 60;

export type HomeFeedId = "latest" | "latest-replies" | "global-24h";

export interface HomeFeedOption {
  readonly id: HomeFeedId;
  readonly label: string;
  /** One line under the label in the picker. Says what the feed actually is. */
  readonly description: string;
  /** True when the feed is built from the account's follow list. */
  readonly needsFollows: boolean;
}

export const HOME_FEEDS: readonly HomeFeedOption[] = [
  {
    id: "latest",
    label: "Latest",
    description: "Notes from people you follow",
    needsFollows: true,
  },
  {
    id: "latest-replies",
    label: "Latest with replies",
    description: "Notes and replies from people you follow",
    needsFollows: true,
  },
  {
    id: "global-24h",
    label: "Global · 24h",
    description: "Everything your relays carried in the last day",
    needsFollows: false,
  },
];

export function homeFeedOption(id: HomeFeedId): HomeFeedOption {
  return HOME_FEEDS.find((feed) => feed.id === id) ?? HOME_FEEDS[0]!;
}

export interface HomeFeedInput {
  readonly id: HomeFeedId;
  readonly followedAuthors: readonly string[];
  readonly relays: readonly string[];
  /** Current time in seconds. Passed in so this stays pure and testable. */
  readonly now: number;
}

/**
 * The feed definition for a picker selection.
 *
 * Returns `undefined` when a follow-scoped feed has nobody to scope to. That is
 * not the same as an empty feed and the caller must not treat it as one: with no
 * authors the only filter we could build is the unbounded global one, and
 * silently substituting the firehose for "your follows" is how a client ends up
 * streaming thousands of strangers' notes to someone who asked for the twelve
 * people they follow.
 */
export function homeFeedDefinition({
  id,
  followedAuthors,
  relays,
  now,
}: HomeFeedInput): FeedDefinition | undefined {
  const option = homeFeedOption(id);

  if (option.needsFollows) {
    if (followedAuthors.length === 0) return undefined;
    return {
      kinds:
        id === "latest-replies" ? [...NOTE_KINDS, ...REPLY_KINDS] : NOTE_KINDS,
      // Author-scoped, so the outbox router asks each author's own write relays
      // rather than blanket-querying every socket.
      authors: followedAuthors,
      relays,
    };
  }

  return {
    kinds: NOTE_KINDS,
    relays,
    // The whole point of this option. Without `since` the relay streams its
    // history until it hits the limit, and the reader waits on events they will
    // never scroll to.
    since: now - GLOBAL_WINDOW_SECONDS,
  };
}
