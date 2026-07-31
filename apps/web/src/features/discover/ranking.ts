/**
 * Ranking over events we already hold.
 *
 * Pure functions, no store and no React: given the same events they produce the
 * same output, which is the only reason these numbers can be trusted. Everything
 * here describes **the local index** — the events this device has received and
 * verified — and nothing else. There is no indexer behind Setu, so there is no
 * such thing as a network-wide "trending" number to compute; a ranking of what
 * your own relays handed you is a different claim, and the UI must say so.
 *
 * A count here therefore means "how many events in this sample", where the
 * sample is a bounded, newest-first window of the local store. That is a real
 * measurement of a real thing; it is not a popularity estimate.
 */

import type { HasTags } from "@setu/protocol";
import { hashtags, tokenizeContent } from "@setu/protocol";

/** The minimum an event needs for topic extraction. */
export interface TopicSource extends HasTags {
  readonly content: string;
}

/** The minimum an event needs for author ranking. */
export interface AuthorSource {
  readonly pubkey: string;
}

export interface RankedTopic {
  /** Case-folded, `#`-less topic name. */
  readonly tag: string;
  /** Events in the sample that mention it. */
  readonly count: number;
}

export interface RankedAuthor {
  readonly pubkey: string;
  /** Events in the sample authored by them. */
  readonly count: number;
}

/**
 * Case-fold a topic to its canonical form.
 *
 * `#Nostr`, `#nostr` and `nostr` are one topic: NIP-24 says `t` tags should be
 * lowercase, but plenty of clients publish mixed case, and treating those as
 * separate topics splits one conversation into two chips that each look half as
 * active as the thing actually is.
 */
export function normalizeTopic(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^#+/, "").toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Topics one event contributes, deduped.
 *
 * Both sources count: the `t` tags (authoritative, what relays filter on) and
 * hashtags written inline in the body, which many notes have without a matching
 * tag. Deduping per event means the unit is "notes mentioning this topic" rather
 * than "times the word appears" — otherwise one note repeating a word ten times
 * outranks ten people discussing it.
 */
export function topicsOf(event: TopicSource): readonly string[] {
  const seen = new Set<string>();

  for (const value of hashtags(event)) {
    const topic = normalizeTopic(value);
    if (topic) seen.add(topic);
  }

  // The tokenizer is the single definition of what a hashtag is in note text.
  // A second regex here would drift from what the renderer makes clickable.
  for (const token of tokenizeContent(event.content)) {
    if (token.type !== "hashtag") continue;
    const topic = normalizeTopic(token.tag);
    if (topic) seen.add(topic);
  }

  return [...seen];
}

/**
 * Sort a count map into a stable ranking.
 *
 * Ties break on the key, ascending. Arbitrary tie order would make chips shuffle
 * on every unrelated store write, since a live sample re-ranks constantly and
 * ties are the common case in a small sample.
 */
function rank<T>(
  counts: ReadonlyMap<string, number>,
  limit: number | undefined,
  make: (key: string, count: number) => T,
): readonly T[] {
  const out = [...counts.entries()]
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .map(([key, count]) => make(key, count));
  return limit === undefined ? out : out.slice(0, limit);
}

/** Topics in the sample, most-mentioned first. */
export function rankTopics(
  events: readonly TopicSource[],
  limit?: number,
): readonly RankedTopic[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const topic of topicsOf(event)) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }
  return rank(counts, limit, (tag, count) => ({ tag, count }));
}

/** Authors in the sample, most events first. */
export function rankAuthors(
  events: readonly AuthorSource[],
  limit?: number,
): readonly RankedAuthor[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (!event.pubkey) continue;
    counts.set(event.pubkey, (counts.get(event.pubkey) ?? 0) + 1);
  }
  return rank(counts, limit, (pubkey, count) => ({ pubkey, count }));
}
