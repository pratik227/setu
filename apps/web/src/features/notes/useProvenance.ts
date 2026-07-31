import { useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";

/** Which relays served an event, as recorded when it was stored. */
export type ProvenanceMap = ReadonlyMap<string, readonly string[]>;

/**
 * The relays each note actually arrived from.
 *
 * Every store row carries this already — the store merges provenance rather than
 * duplicating a row when the same event arrives from a second relay. Nothing has
 * ever shown it, and it is the one fact this client knows that a reader cannot
 * get anywhere else: a note held by one relay is a different thing from a note
 * held by four, and only the client that verified both can say so.
 *
 * Local reads only. This never opens a subscription: provenance is a property of
 * what we already received, so asking the network for it would be incoherent.
 */
export function useProvenance(noteIds: readonly string[]): ProvenanceMap {
  const engine = useEngine();
  const [map, setMap] = useState<ProvenanceMap>(new Map());

  const key = useMemo(() => [...new Set(noteIds)].sort().join(","), [noteIds]);

  // Same leading-schedule discipline as the other interest-tracking hooks: on a
  // live feed the id set changes faster than any sensible delay, so re-arming a
  // timer per change would push the callback back indefinitely.
  const [settled, setSettled] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    if (key === settled) return;
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setSettled(latest.current);
    }, 400);
  }, [key, settled]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  useEffect(() => {
    const ids = settled ? settled.split(",") : [];
    if (ids.length === 0) {
      setMap(new Map());
      return;
    }
    return engine.store.observe({ ids }, (events) => {
      const next = new Map<string, readonly string[]>();
      for (const stored of events) {
        next.set(stored.event.id, stored.provenance.relays);
      }
      setMap(next);
    });
  }, [engine, settled]);

  return map;
}

/** Host portion of a relay URL, for a compact label. */
export function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^wss?:\/\//, "").replace(/\/$/, "");
  }
}
