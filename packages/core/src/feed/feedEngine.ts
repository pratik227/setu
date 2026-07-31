/**
 * The feed.
 *
 * Three behaviours here exist because a live timeline is hostile without them:
 *
 *  1. **A staging buffer for new events.** While the reader has scrolled away
 *     from the top, newer events are held and only counted. Inserting them
 *     immediately makes the list jump under the reader's thumb. `flush()` merges
 *     them at the top when the reader asks.
 *  2. **`until`-based pagination.** `loadMore()` windows backwards from the oldest
 *     loaded row, local first then network. Without it a feed can only scroll back
 *     as far as the local store happens to reach.
 *  3. **Coalesced reposts.** N reposts of one target inside a window are one row
 *     carrying every reposter.
 *
 * The engine never talks to a relay directly. It reads the store (its only source
 * of truth) and asks `SubscriptionManager` to go fill the store in.
 */

import type { Filter, NostrEvent, RelayBasedFilter } from "@setu/protocol";
import type {
  EventStore,
  StoredEvent,
  SubscriptionHandle,
  SubscriptionManager,
  Unsubscribe,
} from "../contracts";
import type { OutboxRouter } from "../relay/outboxRouter";
import { FeedBuffer } from "./feedBuffer";
import type { FeedDefinition, FeedSnapshot } from "./feedTypes";
import { RepostCoalescer } from "./repostCoalescer";

/** Construction options for {@link FeedEngine}. */
export interface FeedEngineOptions {
  readonly store: EventStore;
  readonly subscriptions: SubscriptionManager;
  readonly definition: FeedDefinition;
  /**
   * Outbox router. When present *and* the definition names authors, relays are
   * chosen per author from cached NIP-65 lists; otherwise `definition.relays` is
   * used as-is.
   */
  readonly router?: OutboxRouter;
  /** Rows requested per pagination window. Default 40. */
  readonly pageSize?: number;
  /** Repost coalescing window in seconds. Default 3600. */
  readonly repostWindowSeconds?: number;
  /** Cap on the live query's result set. Omit for "everything matching". */
  readonly observeLimit?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * A single feed: rows, staging, pagination.
 *
 * Lifecycle: construct, `start()`, then `subscribe()` for updates and
 * `pause()`/`flush()`/`loadMore()` as the reader scrolls. `close()` releases the
 * live query and the network subscription.
 */
export class FeedEngine {
  private readonly rows = new FeedBuffer();
  private readonly staged = new FeedBuffer();
  private readonly coalescer: RepostCoalescer;
  private readonly seenEventIds = new Set<string>();
  /** Row key -> the event ids that produced it, for removal on deletion. */
  private readonly keysByEvent = new Map<string, string>();
  private readonly listeners = new Set<(snapshot: FeedSnapshot) => void>();
  private storeSubscription: Unsubscribe | undefined;
  private networkSubscription: SubscriptionHandle | undefined;
  private isPaused = false;
  private pauseWatermark = Number.NEGATIVE_INFINITY;
  private isLoading = false;
  private isExhausted = false;
  private started = false;
  private snapshotCache: FeedSnapshot | undefined;

  constructor(private readonly options: FeedEngineOptions) {
    this.coalescer = new RepostCoalescer({
      ...(options.repostWindowSeconds !== undefined
        ? { windowSeconds: options.repostWindowSeconds }
        : {}),
    });
  }

  /** True while newer rows are being staged instead of inserted. */
  get paused(): boolean {
    return this.isPaused;
  }

  /** Rows held back by the staging buffer. This is the "N new posts" badge. */
  get pendingCount(): number {
    return this.staged.size;
  }

  /**
   * Begins the live query and opens the network subscription.
   *
   * Resolves once the local rows are loaded; network events arrive afterwards
   * through the same store path.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // The live store query is the only way rows enter the feed, including our
    // own published events.
    this.storeSubscription = this.options.store.observe(
      this.localFilter(),
      (events) => this.applyStored(events),
    );
    try {
      const filters = await this.relayFilters({ limit: this.pageSize });
      if (filters.length > 0) {
        this.networkSubscription = this.options.subscriptions.subscribe({
          filters,
          incremental: true,
        });
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /**
   * Holds newer rows back instead of inserting them.
   *
   * Call when the reader scrolls away from the top. The watermark is taken now,
   * so rows already visible keep updating (a repost group can still gain
   * reposters) while genuinely new rows queue up.
   */
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.pauseWatermark =
      this.rows.newestCreatedAt() ?? Number.NEGATIVE_INFINITY;
    this.emit();
  }

  /** Unpauses and merges anything staged. The "scrolled back to top" action. */
  resume(): void {
    this.isPaused = false;
    this.pauseWatermark = Number.NEGATIVE_INFINITY;
    this.flush();
  }

  /**
   * Merges staged rows in at the top, in order.
   *
   * Safe to call while still paused — that is the "show 12 new posts" button,
   * which reveals the rows without changing the reader's scroll mode.
   */
  flush(): void {
    if (this.staged.size === 0) {
      this.emit();
      return;
    }
    this.rows.drainFrom(this.staged);
    if (this.isPaused) {
      this.pauseWatermark =
        this.rows.newestCreatedAt() ?? Number.NEGATIVE_INFINITY;
    }
    this.emit();
  }

  /**
   * Loads one older window.
   *
   * Windows backwards from the oldest row currently held using `until`, local
   * first and only then the network. `until` is inclusive and rows are keyed, so
   * the boundary event is de-duplicated rather than skipped — the alternative
   * (`until - 1`) silently loses events that share the boundary second.
   *
   * Returns the number of rows added; 0 marks the feed exhausted.
   */
  async loadMore(): Promise<number> {
    if (this.isLoading || this.isExhausted) return 0;
    this.isLoading = true;
    this.emit();
    const before = this.rows.size;
    try {
      const until = this.rows.oldestCreatedAt();
      const pageFilter: Filter = {
        ...this.localFilter(),
        limit: this.pageSize,
        ...(until !== undefined ? { until } : {}),
      };

      this.absorb(await this.options.store.query(pageFilter));
      if (this.rows.size - before < this.pageSize) {
        const filters = await this.relayFilters({
          limit: this.pageSize,
          ...(until !== undefined ? { until } : {}),
        });
        if (filters.length > 0) {
          await this.options.subscriptions.fetch({ filters });
          this.absorb(await this.options.store.query(pageFilter));
        }
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.isLoading = false;
    }
    const added = this.rows.size - before;
    if (added === 0) this.isExhausted = true;
    this.emit();
    return added;
  }

  /** The current immutable snapshot. Stable by reference between changes. */
  snapshot(): FeedSnapshot {
    if (this.snapshotCache === undefined) {
      this.snapshotCache = {
        entries: this.rows.snapshot(),
        pendingCount: this.staged.size,
        loading: this.isLoading,
        exhausted: this.isExhausted,
        paused: this.isPaused,
      };
    }
    return this.snapshotCache;
  }

  /** Subscribes to snapshots. Fires immediately with the current one. */
  subscribe(onChange: (snapshot: FeedSnapshot) => void): Unsubscribe {
    this.listeners.add(onChange);
    onChange(this.snapshot());
    return () => {
      this.listeners.delete(onChange);
    };
  }

  /** Releases the live query and the network subscription. */
  close(): void {
    this.storeSubscription?.();
    this.storeSubscription = undefined;
    this.networkSubscription?.close();
    this.networkSubscription = undefined;
    this.listeners.clear();
  }

  // --- filters ----------------------------------------------------------

  private get pageSize(): number {
    return this.options.pageSize ?? 40;
  }

  /** The relay-agnostic filter describing this feed's subject. */
  private localFilter(): Filter {
    const { definition } = this.options;
    const filter: Filter = { kinds: [...definition.kinds] };
    if (definition.authors !== undefined && definition.authors.length > 0) {
      filter.authors = [...definition.authors];
    }
    if (definition.hashtags !== undefined && definition.hashtags.length > 0) {
      filter["#t"] = [...definition.hashtags];
    }
    if (definition.since !== undefined) {
      filter.since = definition.since;
    }
    if (this.options.observeLimit !== undefined) {
      filter.limit = this.options.observeLimit;
    }
    return filter;
  }

  /**
   * Per-relay filters for a network read.
   *
   * Outbox routing applies only when the feed names authors: a hashtag feed has
   * no author whose write relays could be consulted, so it uses the definition's
   * relays.
   */
  private async relayFilters(
    extra: Partial<Filter>,
  ): Promise<readonly RelayBasedFilter[]> {
    const { definition, router } = this.options;
    const base = this.localFilter();
    delete base.limit;
    const filter: Filter = { ...base, ...extra };
    if (
      router !== undefined &&
      definition.authors !== undefined &&
      definition.authors.length > 0
    ) {
      const routed = await router.route(definition.authors, filter);
      if (routed.length > 0) return routed;
    }
    return definition.relays.map((relay) => ({ relay, filter }));
  }

  // --- row assembly -----------------------------------------------------

  /**
   * Reconciles the feed with a live-query result set.
   *
   * Handles removals too: an event that has left the matching set (deleted, or
   * superseded) must leave the feed, or the store stops being the source of
   * truth.
   */
  private applyStored(stored: readonly StoredEvent[]): void {
    const present = new Set<string>();
    for (const row of stored) present.add(row.event.id);
    for (const id of [...this.seenEventIds]) {
      if (present.has(id)) continue;
      this.forget(id);
    }
    this.absorb(stored);
  }

  private absorb(stored: readonly StoredEvent[]): void {
    let changed = false;
    for (const row of stored) {
      if (this.seenEventIds.has(row.event.id)) continue;
      this.seenEventIds.add(row.event.id);
      if (this.place(row.event)) changed = true;
      // A repost's target may itself be in the feed; wire it up either way.
      for (const entry of this.coalescer.resolveTarget(row.event)) {
        if (this.rows.has(entry.key)) this.rows.upsert(entry);
        else if (this.staged.has(entry.key)) this.staged.upsert(entry);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Routes one event's row into the visible list or the staging buffer. */
  private place(event: NostrEvent): boolean {
    const entry = this.coalescer.absorb(event);
    if (entry === undefined) return false;
    this.keysByEvent.set(event.id, entry.key);

    // An update to an already-visible row lands in place, paused or not: the row
    // is on screen already, so revealing new reposters is not a jump.
    if (this.rows.has(entry.key)) {
      this.rows.upsert(entry);
      return true;
    }
    if (this.staged.has(entry.key)) {
      this.staged.upsert(entry);
      return true;
    }
    if (this.isPaused && entry.createdAt > this.pauseWatermark) {
      this.staged.upsert(entry);
      return true;
    }
    this.rows.upsert(entry);
    return true;
  }

  private forget(eventId: string): void {
    this.seenEventIds.delete(eventId);
    const key = this.keysByEvent.get(eventId);
    if (key === undefined) return;
    this.keysByEvent.delete(eventId);
    // Only single-event rows disappear with their event; a repost group survives
    // as long as any of its reposts does.
    if (!key.startsWith("note:")) return;
    if (this.rows.remove(key) || this.staged.remove(key)) {
      this.snapshotCache = undefined;
    }
  }

  private emit(): void {
    this.snapshotCache = undefined;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }
}
