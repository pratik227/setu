/**
 * Feed data model.
 *
 * A feed row is not an event: a repost row carries several reposter pubkeys and
 * one target, and a note row carries one event. Making that a first-class type
 * (rather than "an event plus a map the view consults") is what keeps repost
 * coalescing out of the render path.
 */

import type { Hex32, NostrEvent, Timestamp } from "@setu/protocol";

/** What a feed is: kinds, optional narrowing, and the relays to ask. */
export interface FeedDefinition {
  /** Event kinds the feed shows. Required — an unkinded feed is a full sync. */
  readonly kinds: readonly number[];
  /** Restrict to these authors. Enables outbox routing when a router is present. */
  readonly authors?: readonly Hex32[];
  /** Restrict to these `#t` hashtag values. */
  readonly hashtags?: readonly string[];
  /**
   * Oldest `created_at` the feed is interested in.
   *
   * The difference between a bounded feed and a firehose. An unscoped kind-1
   * query across several relays is thousands of events a minute, and the cost is
   * not just bandwidth: the relay streams history until it reaches the limit, so
   * the reader waits on events they will never scroll to. A `since` turns
   * "everything you have" into "the last day", which is the question actually
   * being asked.
   *
   * Interacts with `loadMore()`: paging windows backwards with `until`, so a
   * `since` is the floor those pages stop at. That is intended — a 24-hour feed
   * that pages into last month is not a 24-hour feed.
   */
  readonly since?: Timestamp;
  /**
   * Relays to query when outbox routing does not apply (no authors, or no
   * router). Also the fallback for hashtag feeds, which have no author to route by.
   */
  readonly relays: readonly string[];
}

/** Whether a row renders as a single event or as a coalesced repost. */
export type FeedEntryKind = "note" | "repost";

/** One row in a feed. Immutable; updates produce a new object. */
export interface FeedEntry {
  /**
   * Stable row identity. `note:<eventId>` for notes, `repost:<targetId>:<anchor>`
   * for a coalesced repost group. Use this as the React key.
   */
  readonly key: string;
  readonly kind: FeedEntryKind;
  /** The event that drives display: the note, or the newest repost in the group. */
  readonly event: NostrEvent;
  /** Sort key. For a repost group, the newest repost's `created_at`. */
  readonly createdAt: Timestamp;
  /** Pubkeys that reposted, oldest repost first. Empty for notes. */
  readonly reposters: readonly Hex32[];
  /** Ids of the repost events collapsed into this row. Empty for notes. */
  readonly repostIds: readonly Hex32[];
  /** The reposted event's id, when this is a repost row. */
  readonly targetId?: Hex32;
  /** The reposted event itself, if the repost embedded it or we hold it. */
  readonly target?: NostrEvent;
}

/** An immutable view of a feed's current state. */
export interface FeedSnapshot {
  /** Rows, newest first. A frozen array — safe to hand straight to a view. */
  readonly entries: readonly FeedEntry[];
  /** Rows held back because the reader has scrolled away from the top. */
  readonly pendingCount: number;
  /** True while `loadMore()` is in flight. */
  readonly loading: boolean;
  /** True once a `loadMore()` produced nothing new. */
  readonly exhausted: boolean;
  /** True while new rows are being staged rather than inserted. */
  readonly paused: boolean;
}
