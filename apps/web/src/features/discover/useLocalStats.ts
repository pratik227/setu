import { Kind } from "@setu/protocol";
import { useEffect, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";

/**
 * What this device knows.
 *
 * Every field is a `count` over the local store or a reading off the relay pool.
 * None of it is a network-wide figure, because Setu has no indexer and cannot
 * have one without asking a server to be trusted for the number: a relay only
 * knows its own contents, and "how many users exist on Nostr" is not a question
 * any relay can answer. A client that displays a global counter is either running
 * its own crawler or repeating someone else's — so the honest version of that
 * panel is this one, scoped to your own index and labeled as such.
 */
export interface LocalStats {
  /** Every event held, all kinds. */
  readonly events: number;
  readonly notes: number;
  /** Distinct authors whose kind-0 we hold — the store keeps one per author. */
  readonly profiles: number;
  readonly zapReceipts: number;
  readonly relaysConnected: number;
  readonly relaysFailed: number;
  readonly relaysConfigured: number;
  /** False until the first count resolves, so zero is never shown as a fact. */
  readonly ready: boolean;
}

const INITIAL: LocalStats = {
  events: 0,
  notes: 0,
  profiles: 0,
  zapReceipts: 0,
  relaysConnected: 0,
  relaysFailed: 0,
  relaysConfigured: 0,
  ready: false,
};

/**
 * Poll the local index for its size.
 *
 * Polling rather than observing on purpose: an observer for "every event" would
 * re-materialize the entire store on every write, which is the most expensive
 * possible way to learn a number that only needs to be roughly current. Four
 * counts on a timer cost nothing and cannot wedge the ingest path.
 */
export function useLocalStats(intervalMs = 4000): LocalStats {
  const engine = useEngine();
  const [stats, setStats] = useState<LocalStats>(INITIAL);

  useEffect(() => {
    let cancelled = false;

    const read = async (): Promise<void> => {
      const [events, notes, profiles, zapReceipts] = await Promise.all([
        engine.store.count({}),
        engine.store.count({ kinds: [Kind.ShortTextNote] }),
        engine.store.count({ kinds: [Kind.Metadata] }),
        engine.store.count({ kinds: [Kind.Zap] }),
      ]);
      if (cancelled) return;

      const health = engine.pool.health();
      setStats({
        events,
        notes,
        profiles,
        zapReceipts,
        relaysConnected: health.filter((r) => r.status === "connected").length,
        // "Failed" is the state a reader needs to see: a relay stuck retrying is
        // why a feed looks quiet, and hiding it makes a broken client look calm.
        relaysFailed: health.filter(
          (r) => r.status === "failed" || r.status === "blocked",
        ).length,
        relaysConfigured: engine.relays.length,
        ready: true,
      });
    };

    void read();
    const timer = setInterval(() => void read(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [engine, intervalMs]);

  return stats;
}
