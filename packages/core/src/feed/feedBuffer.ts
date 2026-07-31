/**
 * A sorted feed row list with an immutable snapshot.
 *
 * Two properties the feed depends on:
 *
 *  - **No full re-sort per insert.** Rows arrive one at a time from the store's
 *    live query; sorting an N-row list on each of N arrivals is the quadratic
 *    behaviour that makes a backfill feel like a hang. Insertion is a binary
 *    search plus a splice, and merging a staged batch is a linear merge of two
 *    already-sorted lists.
 *  - **Snapshots are frozen and shared.** The view gets the same array object
 *    until something actually changes, so reference equality is a valid
 *    "did the feed change?" check.
 */

import type { Timestamp } from "@setu/protocol";
import type { FeedEntry } from "./feedTypes";

/** Newest-first ordering, ties broken by row key so it is total and stable. */
export function compareEntriesNewestFirst(a: FeedEntry, b: FeedEntry): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** An ordered, keyed collection of feed rows. */
export class FeedBuffer {
  private items: FeedEntry[] = [];
  private readonly byKey = new Map<string, FeedEntry>();
  private cached: readonly FeedEntry[] | undefined;

  /** Number of rows held. */
  get size(): number {
    return this.items.length;
  }

  /** True when the buffer holds a row with this key. */
  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** The row with this key, if present. */
  get(key: string): FeedEntry | undefined {
    return this.byKey.get(key);
  }

  /**
   * Inserts or replaces a row, keeping the list sorted.
   *
   * Replacement removes and re-inserts because a repost group's `createdAt` moves
   * when a newer repost joins it.
   */
  upsert(entry: FeedEntry): void {
    const existing = this.byKey.get(entry.key);
    if (existing !== undefined) {
      if (existing === entry) return;
      this.removeAt(this.indexOf(existing));
    }
    const index = this.insertionIndex(entry);
    this.items.splice(index, 0, entry);
    this.byKey.set(entry.key, entry);
    this.cached = undefined;
  }

  /** Removes a row by key. Returns true if it was present. */
  remove(key: string): boolean {
    const existing = this.byKey.get(key);
    if (existing === undefined) return false;
    const index = this.indexOf(existing);
    if (index >= 0) this.removeAt(index);
    this.byKey.delete(key);
    this.cached = undefined;
    return true;
  }

  /** `createdAt` of the newest row. */
  newestCreatedAt(): Timestamp | undefined {
    return this.items[0]?.createdAt;
  }

  /** `createdAt` of the oldest row — the `until` anchor for pagination. */
  oldestCreatedAt(): Timestamp | undefined {
    return this.items[this.items.length - 1]?.createdAt;
  }

  /**
   * Merges another buffer's rows in as a single linear pass, leaving `other`
   * empty. This is the staged-rows flush.
   */
  drainFrom(other: FeedBuffer): void {
    if (other.size === 0) return;
    const incoming = other.items;
    const merged: FeedEntry[] = new Array(this.items.length + incoming.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < this.items.length && j < incoming.length) {
      const a = this.items[i]!;
      const b = incoming[j]!;
      if (compareEntriesNewestFirst(a, b) <= 0) {
        merged[k++] = a;
        i += 1;
      } else {
        merged[k++] = b;
        j += 1;
      }
    }
    while (i < this.items.length) merged[k++] = this.items[i++]!;
    while (j < incoming.length) merged[k++] = incoming[j++]!;
    this.items = merged;
    for (const entry of incoming) this.byKey.set(entry.key, entry);
    other.clear();
    this.cached = undefined;
  }

  /** An immutable, newest-first snapshot. Stable by reference between changes. */
  snapshot(): readonly FeedEntry[] {
    if (this.cached === undefined) {
      this.cached = Object.freeze([...this.items]);
    }
    return this.cached;
  }

  /** Drops every row. */
  clear(): void {
    this.items = [];
    this.byKey.clear();
    this.cached = undefined;
  }

  private removeAt(index: number): void {
    if (index < 0) return;
    const [removed] = this.items.splice(index, 1);
    if (removed !== undefined) this.byKey.delete(removed.key);
  }

  private insertionIndex(entry: FeedEntry): number {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareEntriesNewestFirst(this.items[mid]!, entry) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /** Binary search to the row's sort neighbourhood, then a short walk by key. */
  private indexOf(entry: FeedEntry): number {
    const start = this.insertionIndex(entry);
    for (let i = start; i < this.items.length; i += 1) {
      const candidate = this.items[i]!;
      if (candidate.key === entry.key) return i;
      if (candidate.createdAt !== entry.createdAt) break;
    }
    // The row's createdAt may have changed since insertion; fall back to a scan.
    return this.items.findIndex((item) => item.key === entry.key);
  }
}
