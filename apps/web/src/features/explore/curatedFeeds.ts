import type { FeedDefinition } from "@setu/core";
import type { Filter } from "@setu/protocol";
import { Kind } from "@setu/protocol";

/**
 * The curated feed catalog.
 *
 * A static list, and honest about it: these are filters we wrote, not feeds
 * ranked by an indexer. Every entry's description states the exact filter it
 * runs, so a card promises no more than it delivers — a "Music" card that
 * quietly means "notes tagged #music" is fine as long as it says that, and
 * misleading if it does not.
 *
 * No entry claims a subscriber count, a popularity score, or an author ranking.
 * Those would all require a crawler we do not run.
 */

/** Icon keys, resolved to components by the view. Keeps this module JSX-free. */
export type FeedIconKey =
  | "globe"
  | "article"
  | "media"
  | "music"
  | "highlight"
  | "topic";

export interface CuratedFeed {
  readonly id: string;
  readonly name: string;
  /** One line, and it must describe the actual filter. */
  readonly description: string;
  readonly icon: FeedIconKey;
  readonly definition: FeedDefinition;
}

/** Topics that get their own card. Plain hashtag feeds, nothing more. */
const TOPIC_FEEDS: readonly { id: string; name: string; tag: string }[] = [
  { id: "topic-nostr", name: "Nostr", tag: "nostr" },
  { id: "topic-bitcoin", name: "Bitcoin", tag: "bitcoin" },
  { id: "topic-art", name: "Art", tag: "art" },
  { id: "topic-photography", name: "Photography", tag: "photography" },
  { id: "topic-food", name: "Food", tag: "food" },
];

/**
 * Build the catalog for a relay set.
 *
 * The relay set is a parameter rather than a module constant because a feed is
 * meaningless without knowing which relays it asks — the same filter against a
 * different set is a different feed.
 */
export function curatedFeeds(
  relays: readonly string[],
): readonly CuratedFeed[] {
  const base = [
    {
      id: "global",
      name: "Global firehose",
      description: "Every note and repost these relays will hand us.",
      icon: "globe" as FeedIconKey,
      definition: {
        kinds: [Kind.ShortTextNote, Kind.Repost],
        relays,
      },
    },
    {
      id: "longform",
      name: "Long-form reads",
      description: "NIP-23 articles (kind 30023), newest first.",
      icon: "article" as FeedIconKey,
      definition: { kinds: [Kind.LongFormArticle], relays },
    },
    {
      id: "media",
      name: "Images & video",
      description:
        "NIP-94 file metadata (kind 1063) — media published with hashes and dimensions.",
      icon: "media" as FeedIconKey,
      definition: { kinds: [Kind.FileMetadata], relays },
    },
    {
      id: "pictures",
      name: "Pictures",
      // Named for the kind rather than for a mood. "Photography" would be a claim
      // about what is in these posts; kind 20 is a claim about their structure,
      // which is the only one the filter can actually make.
      description:
        "NIP-68 picture posts (kind 20) — the image is the post, not an attachment.",
      icon: "media" as FeedIconKey,
      definition: { kinds: [Kind.Picture], relays },
    },
    {
      id: "video",
      name: "Video",
      description:
        "NIP-71 video events (kinds 21 and 22), landscape and short-form together.",
      icon: "media" as FeedIconKey,
      definition: { kinds: [Kind.Video, Kind.ShortVideo], relays },
    },
    {
      id: "polls",
      name: "Polls",
      // No "most answered" ordering, for the reason `pollViews.ts` sets out: the
      // responses we hold are a sample, so ranking by them would rank by which
      // polls our own relays happened to carry votes for.
      description: "NIP-88 polls (kind 1068), newest first.",
      icon: "highlight" as FeedIconKey,
      definition: { kinds: [Kind.Poll], relays },
    },
    {
      id: "highlights",
      name: "Highlights",
      description: "NIP-84 highlights (kind 9802) — passages people marked.",
      icon: "highlight" as FeedIconKey,
      definition: { kinds: [Kind.Highlight], relays },
    },
    {
      id: "music",
      name: "Music",
      description: "Notes tagged #music, #nowplaying or #livemusic.",
      icon: "music" as FeedIconKey,
      definition: {
        kinds: [Kind.ShortTextNote],
        hashtags: ["music", "nowplaying", "livemusic"],
        relays,
      },
    },
  ] satisfies CuratedFeed[];

  const topics = TOPIC_FEEDS.map(
    (topic): CuratedFeed => ({
      id: topic.id,
      name: topic.name,
      description: `Notes tagged #${topic.tag}.`,
      icon: "topic",
      definition: {
        kinds: [Kind.ShortTextNote, Kind.Repost],
        hashtags: [topic.tag],
        relays,
      },
    }),
  );

  return [...base, ...topics];
}

/**
 * The local-store filter equivalent to a feed definition.
 *
 * Used to count what we already hold for a feed. Deliberately drops the relay
 * set: the store has no notion of which relay an event arrived from for query
 * purposes, so a count here answers "how many matching events do I hold",
 * which is exactly the number the card claims.
 */
export function feedFilter(definition: FeedDefinition): Filter {
  return {
    kinds: [...definition.kinds],
    ...(definition.authors ? { authors: [...definition.authors] } : {}),
    ...(definition.hashtags ? { "#t": [...definition.hashtags] } : {}),
  };
}

/** Compact relay list for a card: hostnames, with an overflow count. */
export function relayLabel(relays: readonly string[], shown = 2): string {
  const hosts = relays.map((url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  });
  if (hosts.length <= shown) return hosts.join(", ");
  return `${hosts.slice(0, shown).join(", ")} +${hosts.length - shown}`;
}
