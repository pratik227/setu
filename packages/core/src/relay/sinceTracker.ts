/**
 * Per-relay `since` bookkeeping for incremental reads.
 *
 * A single global `since` is wrong the moment two relays disagree — which is
 * always. Relay A is caught up to T, relay B is an hour behind; asking both for
 * `since = T` permanently loses everything B was going to send. So the watermark
 * is keyed by *(relay, filter fingerprint)* and each relay is asked for its own
 * gap.
 *
 * The watermark is also pulled back by an overlap window before use. Relay clocks
 * disagree by seconds to minutes, and `created_at` is author-supplied, so a
 * watermark used exactly is a watermark that drops events.
 */

import type { Filter, RelayBasedFilter, Timestamp } from "@setu/protocol";
import { normalizeRelayUrl } from "./normalize";

/**
 * Seconds to rewind the watermark by. 120s tolerates ordinary clock skew while
 * keeping the refetch small; the store dedups the overlap for free.
 */
export const DEFAULT_OVERLAP_SECONDS = 120;

/**
 * A stable identity for "this query", ignoring the parts that describe the
 * *window* rather than the *subject*.
 *
 * `since`, `until` and `limit` are excluded on purpose: a paginated read and an
 * incremental read of the same subject must share one watermark, or paginating
 * backwards would reset the forward watermark.
 */
export function filterFingerprint(filter: Filter): string {
  const keys = Object.keys(filter)
    .filter((key) => key !== "since" && key !== "until" && key !== "limit")
    .sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = (filter as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const sorted = [...(value as unknown[])].map(String).sort();
      parts.push(`${key}=${sorted.join(",")}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join("&");
}

/** Watermarks keyed by (relay, filter fingerprint). */
export class SinceTracker {
  private readonly watermarks = new Map<string, Timestamp>();

  constructor(
    private readonly overlapSeconds: number = DEFAULT_OVERLAP_SECONDS,
  ) {}

  /** Number of tracked (relay, filter) pairs. */
  get size(): number {
    return this.watermarks.size;
  }

  /** Records the newest `created_at` seen from `relay` for `filter`. */
  record(relay: string, filter: Filter, timestamp: Timestamp): void {
    const key = this.key(relay, filter);
    const current = this.watermarks.get(key);
    if (current === undefined || timestamp > current) {
      this.watermarks.set(key, timestamp);
    }
  }

  /** The raw watermark, with no overlap applied. */
  newest(relay: string, filter: Filter): Timestamp | undefined {
    return this.watermarks.get(this.key(relay, filter));
  }

  /**
   * The `since` to send this relay, or `undefined` when nothing is known yet
   * (in which case the caller should not add a `since` at all — a first read
   * wants history).
   *
   * `localFallback` is the store-wide newest timestamp for the filter, used when
   * this relay has no watermark of its own; it keeps a newly-added relay from
   * refetching all of history while still being per-relay-safe, because the
   * overlap window is applied on top.
   */
  since(
    relay: string,
    filter: Filter,
    localFallback?: Timestamp,
  ): Timestamp | undefined {
    const watermark = this.newest(relay, filter) ?? localFallback;
    if (watermark === undefined) return undefined;
    return Math.max(0, watermark - this.overlapSeconds);
  }

  /**
   * Rewrites one relay-bound filter's `since`, leaving everything else intact.
   *
   * Returns the input unchanged when no watermark exists, so a cold start still
   * asks for history.
   */
  applyTo(
    relayFilter: RelayBasedFilter,
    localFallback?: Timestamp,
  ): RelayBasedFilter {
    const since = this.since(
      relayFilter.relay,
      relayFilter.filter,
      localFallback,
    );
    if (since === undefined) return relayFilter;
    return {
      relay: relayFilter.relay,
      filter: { ...relayFilter.filter, since },
    };
  }

  /** Forgets every watermark. Call on account switch. */
  reset(): void {
    this.watermarks.clear();
  }

  private key(relay: string, filter: Filter): string {
    return `${normalizeRelayUrl(relay)}|${filterFingerprint(filter)}`;
  }
}
