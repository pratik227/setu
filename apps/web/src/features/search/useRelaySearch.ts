/**
 * NIP-50 search, where a relay supports it.
 *
 * Two things this hook does not do, both deliberate.
 *
 * **It does not read the array `fetch` returns.** That array is the union of a
 * network read and a local read of the same filter, and the local half is not
 * search-filtered: the store's injected matcher (`@setu/protocol`'s
 * `matchesFilter`) ignores `search` on purpose, because NIP-50 relevance is
 * relay-defined and a local approximation of it would be a different query wearing
 * the same name. So the local half of that array is "the newest `limit` notes",
 * which is not a result set. Relay hits reach the screen the way every other event
 * in this app does — the relay writes them into the store and the UI reads the
 * store back — which is why the only thing this hook publishes is `completed`, the
 * signal to re-read.
 *
 * **It does not ask a relay that has not said it can answer.** See
 * `searchRouting.ts`: a relay without NIP-50 drops the `search` field and returns
 * its newest events, which is worse than nothing because it looks like results.
 *
 * The honest consequence, verified against the four default relays in
 * `EngineProvider`: none of them implements NIP-50, so for a default install this
 * hook reports `unavailable` and never opens a subscription. That fact is the
 * hook's main output, not an error case — the palette shows it instead of an empty
 * list, because "no relay you use can search" is actionable and "nothing matched"
 * is not.
 */

import {
  MIN_SEARCH_QUERY_LENGTH,
  planRelaySearch,
  type SearchReach,
  type SearchRouting,
  searchFilters,
  searchReach,
} from "@setu/core";
import { Kind } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";

/**
 * Kinds a relay search asks for.
 *
 * Profiles and notes in one filter rather than two. A relay caps `max_filters` per
 * REQ, and splitting a query that a single filter expresses spends that budget for
 * nothing.
 */
const SEARCH_KINDS: readonly number[] = [Kind.Metadata, Kind.ShortTextNote];

/**
 * How long typing must pause before a REQ goes out.
 *
 * Longer than a UI debounce because the cost is not a re-render: every keystroke
 * would open a subscription on every capable relay and abandon it a keystroke
 * later, which burns the relay's per-connection subscription budget and gets a
 * client rate-limited. Local results are already updating on every keystroke, so
 * the wait is not felt as latency.
 */
const DEBOUNCE_MS = 450;

export type RelaySearchStatus =
  /** Nothing asked: query too short, or no relay can answer. */
  | "idle"
  /** A REQ is out. */
  | "searching"
  /** Every relay asked has answered or timed out. */
  | "done"
  /** The read threw. Shown, never swallowed. */
  | "failed";

export interface RelaySearchState {
  readonly reach: SearchReach;
  readonly routing: SearchRouting;
  readonly status: RelaySearchStatus;
  /** Relay URLs this query was actually sent to. */
  readonly asked: readonly string[];
  /**
   * Increments once per completed search.
   *
   * The signal to re-read the store, not a result count — the results themselves
   * are in the store by the time this changes.
   */
  readonly completed: number;
  readonly error?: string;
}

export function useRelaySearch(open: boolean, query: string): RelaySearchState {
  const engine = useEngine();
  const [capabilities, setCapabilities] = useState(0);
  const [status, setStatus] = useState<RelaySearchStatus>("idle");
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState<string | undefined>();

  /*
   * Kick the capability fetch when the palette opens.
   *
   * The engine already loads NIP-11 documents in the background at startup, and
   * `RelayInfoCache` caches both hits and misses, so this is a no-op in the common
   * case. It matters in the uncommon one: a palette opened in the first second of
   * a session would otherwise plan against an empty cache and, once every relay
   * resolved as pending, render "checking" forever because nothing told React the
   * cache had filled.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void engine.relayInfo.loadAll(engine.relays).then(() => {
      if (!cancelled) setCapabilities((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, open]);

  const routing = useMemo(() => {
    const resolved = new Set(
      engine.relays.filter((url) => engine.relayInfo.isResolved(url)),
    );
    return planRelaySearch({
      urls: engine.relays,
      infos: engine.relayInfo.all(),
      resolved,
    });
    // `capabilities` is the dependency that matters: the cache mutates in place,
    // so its own identity never changes and only the bump can invalidate this.
  }, [engine, capabilities]);

  const filters = useMemo(
    () => searchFilters({ routing, query, kinds: SEARCH_KINDS }),
    [routing, query],
  );

  useEffect(() => {
    if (!open || filters.length === 0) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setStatus("searching");
      setError(undefined);
      engine.subscriptions
        .fetch({ filters })
        .then(() => {
          if (cancelled) return;
          setStatus("done");
          // The results are in the store; this tells the corpus to re-read it.
          setCompleted((n) => n + 1);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setStatus("failed");
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [engine, open, filters]);

  return useMemo(
    () => ({
      reach: searchReach(routing),
      routing,
      status,
      asked: filters.map((f) => f.relay),
      completed,
      ...(error ? { error } : {}),
    }),
    [routing, status, filters, completed, error],
  );
}

/** Re-exported so the palette's copy and the routing agree on one number. */
export { MIN_SEARCH_QUERY_LENGTH };
