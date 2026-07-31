/**
 * A grow-only set of ids we want events for, and the policy for when to re-ask.
 *
 * Every "counts for the visible notes" query has the same shape of problem: the
 * set of ids changes on every arriving note, and a subscription keyed directly on
 * it is closed and reopened before any relay has answered — so the counts never
 * arrive at all. Two failure modes sit either side of the fix:
 *
 *  - **Replace-on-change** churns: a live feed re-REQs several times per second,
 *    which spends the relay's subscription budget on cancellations.
 *  - **Reset-on-every-change debounce** livelocks: on a busy feed ids arrive faster
 *    than any sensible delay, so re-arming the timer pushes the callback back
 *    indefinitely and no REQ is ever sent.
 *
 * So the set only grows, the published (subscribed) set lags it, and republishing
 * is gated on two independent conditions: enough *new* ids to be worth a round
 * trip, and enough elapsed time since the last one. The caller owns the timer and
 * uses a leading schedule — see the consumers.
 *
 * Growth is bounded by an LRU cap. Ids never repeat the way authors do, so an
 * unbounded union would eventually put a thousand `#e` values in one filter; the
 * least recently *wanted* ids are dropped instead. A dropped id keeps whatever
 * counts were already computed for it — this class decides what we ask for, not
 * what we remember.
 */

/** Tuning for one interest set. All three are load-bearing; see the class doc. */
export interface InterestPolicy {
  /** Hard cap on tracked ids, LRU-evicted. Bounds the size of one filter. */
  readonly max: number;
  /** New ids required before republishing is worth a round trip. */
  readonly threshold: number;
  /** Minimum gap between republishes, whatever the threshold says. */
  readonly cooldownMs: number;
  /**
   * How long the published set may stay short of the wanted one.
   *
   * The threshold alone leaves a hole: a surface that adds three ids and then goes
   * quiet would never be covered, because nothing more arrives to trip the
   * threshold. After this long, any new id is enough.
   */
  readonly maxStaleMs: number;
}

export class InterestSet {
  /** Insertion-ordered; re-wanting an id moves it to the end (LRU). */
  private readonly ids = new Set<string>();
  private ordered: readonly string[] = [];
  private orderedStale = false;
  private published: readonly string[] = [];
  private fresh = 0;
  private evicted = false;
  private publishedAtMs: number | undefined;

  constructor(private readonly policy: InterestPolicy) {}

  /** Ids currently being asked for. Reference-stable between republishes. */
  get publishedIds(): readonly string[] {
    return this.published;
  }

  /** Every id we want, newest interest last. */
  get wantedIds(): readonly string[] {
    if (this.orderedStale) {
      this.ordered = [...this.ids];
      this.orderedStale = false;
    }
    return this.ordered;
  }

  /**
   * Record interest in some ids.
   *
   * Ids already tracked are moved to the most-recent end rather than counted as
   * new: a feed re-rendering its top 40 rows is not new demand, and counting it
   * as such would trip the threshold on every render.
   */
  want(ids: readonly string[]): void {
    for (const id of ids) {
      if (id === "") continue;
      if (this.ids.delete(id)) {
        this.ids.add(id);
        continue;
      }
      this.ids.add(id);
      this.fresh += 1;
    }
    while (this.ids.size > this.policy.max) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
      // An evicted id may still be in the published filter, so the published set
      // is now wrong in a way the threshold cannot notice.
      if (this.published.includes(oldest)) this.evicted = true;
    }
    this.orderedStale = true;
  }

  /**
   * Whether the published set should be replaced now.
   *
   * True on the first non-empty set — nothing is subscribed yet, so waiting only
   * delays every count on screen — and after that only when the wait for the
   * accumulated demand has elapsed. See {@link delayUntilPublishable}.
   */
  shouldPublish(nowMs: number): boolean {
    return this.delayUntilPublishable(nowMs) === 0;
  }

  /**
   * How long until {@link shouldPublish} becomes true with no further demand, or
   * `undefined` when only new ids could make it true.
   *
   * This is what lets a caller arm exactly one timer: waking earlier would burn a
   * tick to learn nothing, and waking on demand alone would strand the ids a quiet
   * surface added.
   *
   * The cooldown applies to eviction too, and that is the whole reason this
   * returns a delay rather than a boolean. A set held permanently at its cap — the
   * notification target set is, by construction — evicts something on *every* new
   * id, so treating eviction as urgent turns the cap into a re-subscribe per
   * arriving event, which is the churn this class exists to stop. An evicted id
   * means the published filter is stale, not that it is wrong to keep using for
   * another few seconds.
   */
  delayUntilPublishable(nowMs: number): number | undefined {
    if (this.ids.size === 0) return undefined;
    if (this.publishedAtMs === undefined) return 0;
    if (this.fresh === 0 && !this.evicted) return undefined;
    const wait =
      this.evicted || this.fresh >= this.policy.threshold
        ? this.policy.cooldownMs
        : this.policy.maxStaleMs;
    return Math.max(0, this.publishedAtMs + wait - nowMs);
  }

  /** Adopt the wanted set as the published one and reset the counters. */
  publish(nowMs: number): readonly string[] {
    this.published = this.wantedIds.slice();
    this.publishedAtMs = nowMs;
    this.fresh = 0;
    this.evicted = false;
    return this.published;
  }

  /** New ids accumulated since the last publish. Exposed for tests. */
  get freshCount(): number {
    return this.fresh;
  }
}
