/**
 * NIP-40 expiration bookkeeping, shared by every {@link ../contracts.EventStore}
 * implementation.
 *
 * An `["expiration", "<unix seconds>"]` tag is the author asking that the event be
 * treated as gone once that second arrives. Like NIP-09 deletions (see
 * {@link ./tombstones}), the rule is enforced at the storage boundary rather than
 * in views — a rule that lives in one screen is a rule the next screen forgets,
 * and "the note the author asked to disappear is still on screen" is exactly the
 * failure a reader would call a bug.
 *
 * Four decisions are worth stating, because they are the ones a reader will
 * question:
 *
 *  1. **An already-expired event is rejected at insert.** It never enters the
 *     store, so there is no window — not even one frame — in which a query can
 *     return it while something else is on its way to sweep it up. Rejection is
 *     the only version of this rule that does not depend on sweep timing.
 *  2. **Reads filter, sweeps delete.** Every read path drops events whose
 *     deadline has passed, using the store's own clock; deletion of the row is a
 *     separate step. Read filtering is what makes expiry *exact* — it needs no
 *     timer and cannot be late. The sweep is what reclaims space and is what
 *     wakes observers.
 *  3. **No timer lives in this package.** A sweep runs on every write (a live
 *     client writes constantly) and on demand via
 *     {@link ../contracts.EventStore.sweepExpired}, and
 *     {@link ../contracts.EventStore.nextExpirationAt} tells a caller when the
 *     next deadline falls. The accepted trade: if the app is completely idle,
 *     an expired note can sit in storage and stay on an already-rendered screen
 *     until something touches the store — no observer fires by itself. The
 *     alternative is core setting a timer, which would wake a backgrounded tab
 *     on a schedule the user never asked for, and would make a headless package
 *     own host scheduling policy. Deciding whether that wake-up is worth it is
 *     the app's call, and the app has everything it needs to make it.
 *  4. **A malformed value means "no expiration", never "expired".** Deleting
 *     someone's note because a relay handed us `["expiration", "soon"]` is
 *     unrecoverable; keeping a note that asked to be dropped is not. So parsing
 *     is strict and total, and every failure falls the safe way.
 */

import type { Hex32, NostrEvent, Timestamp } from "@setu/protocol";

/** The NIP-40 tag name. */
export const EXPIRATION_TAG = "expiration";

/**
 * Largest accepted expiration, in seconds.
 *
 * Above this a value is treated as malformed rather than as a far-future
 * deadline. `1e12` seconds is the year 33658, so nothing an author could
 * plausibly mean is lost, while the two things actually seen in the wild —
 * millisecond timestamps (~1.7e12) and overflow garbage — are rejected instead
 * of being silently honoured as "never".
 */
export const MAX_EXPIRATION_SECONDS = 1_000_000_000_000;

/** Only unsigned decimal integers, no sign, exponent, decimal point or padding. */
const DIGITS = /^[0-9]{1,15}$/;

/**
 * Parses one `expiration` tag value.
 *
 * Returns `undefined` — meaning "this event has no expiration" — for anything
 * that is not a plain positive integer second count in range: missing, empty,
 * non-numeric, signed, fractional, exponent-notation, whitespace-padded, zero,
 * or absurdly large. Zero is refused with the rest: a literal `"0"` would
 * otherwise mean "expired since 1970", i.e. an event that can never be stored,
 * which is far more likely to be a serialisation bug than an author's intent.
 */
export function parseExpirationValue(
  value: string | undefined,
): Timestamp | undefined {
  if (value === undefined || !DIGITS.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return undefined;
  if (seconds <= 0 || seconds > MAX_EXPIRATION_SECONDS) return undefined;
  return seconds;
}

/**
 * The deadline an event asks for, or `undefined` when it asks for none.
 *
 * When several `expiration` tags are present the **earliest valid** one wins,
 * and malformed ones are skipped rather than shadowing the rest. Both halves of
 * that follow from the same reasoning: the author signed every tag in the list,
 * so honouring the strictest request they signed is the reading that cannot be
 * gamed — under a "first tag wins" rule a garbage first tag would silently
 * extend the life of an event whose real deadline is right there in the list.
 */
export function expirationOf(event: NostrEvent): Timestamp | undefined {
  let earliest: Timestamp | undefined;
  for (const tag of event.tags) {
    if (tag[0] !== EXPIRATION_TAG) continue;
    const at = parseExpirationValue(tag[1]);
    if (at === undefined) continue;
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * True when `event`'s deadline has arrived, given the clock reading `now`.
 *
 * The comparison is inclusive: an event whose expiration equals the current
 * second is already gone. The alternative leaves a one-second window in which an
 * event that asked to be gone is still returned, and there is no reason to
 * prefer that window over honouring the request on time.
 *
 * This single predicate decides both insert rejection and read filtering in both
 * stores, so the two can never disagree about what "expired" means.
 */
export function isExpiredAt(event: NostrEvent, now: Timestamp): boolean {
  const at = expirationOf(event);
  return at !== undefined && now >= at;
}

interface ExpirationEntry {
  readonly id: Hex32;
  readonly expiresAt: Timestamp;
}

/**
 * In-memory deadline index, ordered soonest-first.
 *
 * Only events that actually carry an expiration are tracked, so the common case
 * — a store full of ordinary notes — costs nothing. The Dexie store keeps the
 * equivalent ordering in an IndexedDB index on the denormalised `expiresAt`
 * column and reuses the pure helpers above, so both stores agree by
 * construction.
 */
export class ExpirationIndex {
  private readonly byId = new Map<Hex32, Timestamp>();
  /** Ascending by `expiresAt`, maintained by binary insertion. */
  private readonly order: ExpirationEntry[] = [];

  /** Number of events with a tracked deadline. Diagnostics only. */
  get size(): number {
    return this.byId.size;
  }

  /**
   * Tracks `event` if it carries a usable expiration, returning the deadline.
   *
   * Returns `undefined` for events with no expiration; callers can use that to
   * skip persisting a deadline column.
   */
  add(event: NostrEvent): Timestamp | undefined {
    const expiresAt = expirationOf(event);
    if (expiresAt === undefined) return undefined;
    this.byId.set(event.id, expiresAt);
    // Insert *after* any equal deadlines, so events sharing a second come back
    // from `takeDue` in the order they arrived rather than reversed.
    this.order.splice(this.upperBound(expiresAt), 0, {
      id: event.id,
      expiresAt,
    });
    return expiresAt;
  }

  /** Stops tracking `id`. Called whenever a row leaves the store for any reason. */
  remove(id: Hex32): void {
    const expiresAt = this.byId.get(id);
    if (expiresAt === undefined) return;
    this.byId.delete(id);
    // Binary search to the run of equal deadlines, then a short local walk.
    for (let i = this.lowerBound(expiresAt); i < this.order.length; i += 1) {
      const entry = this.order[i]!;
      if (entry.id === id) {
        this.order.splice(i, 1);
        return;
      }
      if (entry.expiresAt !== expiresAt) return;
    }
  }

  /**
   * The soonest deadline held, or `undefined` when nothing expires.
   *
   * This is what lets a caller decide whether a sweep is worth doing at all, and
   * what a host that *wants* a timer would schedule against.
   */
  earliest(): Timestamp | undefined {
    return this.order[0]?.expiresAt;
  }

  /**
   * Ids whose deadline has arrived at `now`, removed from the index as they are
   * returned — the caller is expected to delete the rows.
   */
  takeDue(now: Timestamp): readonly Hex32[] {
    let count = 0;
    while (count < this.order.length && this.order[count]!.expiresAt <= now) {
      count += 1;
    }
    if (count === 0) return [];
    const due = this.order.splice(0, count);
    for (const entry of due) this.byId.delete(entry.id);
    return due.map((entry) => entry.id);
  }

  /** Drops every tracked deadline. Only for `EventStore.clear()`. */
  clear(): void {
    this.byId.clear();
    this.order.length = 0;
  }

  /** First index whose deadline is at or after `expiresAt`. */
  private lowerBound(expiresAt: Timestamp): number {
    let low = 0;
    let high = this.order.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.order[mid]!.expiresAt < expiresAt) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** First index whose deadline is strictly after `expiresAt`. */
  private upperBound(expiresAt: Timestamp): number {
    let low = 0;
    let high = this.order.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.order[mid]!.expiresAt <= expiresAt) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}
