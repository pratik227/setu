/**
 * The scorecard, kept current enough to route with.
 *
 * `relayScorecard.ts` is pure; this is the moving part around it. The consumer is
 * the outbox router's fallback ordering, which runs on a hot path (every routed
 * read for an author with no relay list), so the contract is shaped around never
 * making a router wait:
 *
 *  - **`order()` is synchronous and answers from the last completed scan.** A
 *    router that awaited a store aggregation per route would turn eight queries
 *    into eighty. Staleness is acceptable here in a way waiting is not: relay
 *    behaviour drifts over hours, not between two REQs.
 *  - **Reading is what schedules refreshing.** The first `order()` returns the
 *    input unchanged (bootstrap = configured order, the pre-scorecard behaviour)
 *    and kicks a scan; later calls re-kick it when the TTL has lapsed. No timer
 *    runs when nothing routes, so an idle tab pays nothing.
 *  - **A failed scan is a skipped scan.** The store throwing (a closing IndexedDB
 *    during account switch, typically) must degrade to configured-order routing,
 *    never to a routing error — the scorecard is an optimisation, and an
 *    optimisation that can break its caller is a bug with extra steps.
 */

import type { EventStore, StoredEvent } from "../contracts";
import {
  orderByDelivery,
  type RelayScorecard,
  scorecardQueries,
  scoreRows,
} from "./relayScorecard";

export interface RelayScorecardSourceOptions {
  readonly store: EventStore;
  /** How long a scan stays fresh. Default 60s. */
  readonly ttlMs?: number;
  /** Millisecond clock, injectable for tests. */
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export interface RelayScorecardSource {
  /** Order `urls` for a query over `kinds`. Never blocks; never drops a relay. */
  order(urls: readonly string[], kinds?: readonly number[]): readonly string[];
  /** The last completed scan, for surfaces that render the numbers. */
  current(): RelayScorecard | undefined;
  /** Force a scan now. Exposed for tests; production goes through `order`. */
  refresh(): Promise<void>;
}

export function createRelayScorecardSource(
  options: RelayScorecardSourceOptions,
): RelayScorecardSource {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? (() => Date.now());

  let scorecard: RelayScorecard | undefined;
  let scannedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  const refresh = async (): Promise<void> => {
    // Single-flight: a burst of routes while a scan runs must coalesce into that
    // scan, not queue eight more behind it.
    if (inFlight !== undefined) return inFlight;
    inFlight = (async () => {
      try {
        const rows: StoredEvent[] = [];
        for (const query of scorecardQueries()) {
          rows.push(
            ...(await options.store.query({
              kinds: [...query.kinds],
              limit: query.limit,
            })),
          );
        }
        scorecard = scoreRows(rows);
        scannedAt = now();
      } catch (error) {
        // Degrade to whatever we had (possibly nothing). Stamping `scannedAt`
        // anyway would suppress retries for a full TTL after a transient failure;
        // leaving it stale lets the next order() try again.
        options.onError?.(error);
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    order(urls, kinds) {
      if (now() - scannedAt >= ttlMs) void refresh();
      return orderByDelivery(urls, scorecard, kinds);
    },
    current: () => scorecard,
    refresh,
  };
}
