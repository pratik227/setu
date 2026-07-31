/**
 * The kind-7s held for one note — a local read, and deliberately only that.
 *
 * No subscription of its own. `useInteractions` already asks every relay for the
 * interactions on the notes on screen, under one shared REQ with a bound; the
 * reaction events this hook reads are the ones that query brought back. Opening a
 * second REQ for the same kind and the same `#e` would double the traffic to show a
 * breakdown of numbers the app has already fetched — and it would do it per note,
 * which is the subscription-per-row failure `useInteractions` exists to avoid.
 *
 * The consequence is worth stating plainly rather than hiding: this shows the
 * reactions **we already hold**, so a surface that has not registered interest in
 * the note gets nothing. That is why it is used for a thread's focused note, which
 * is always inside the interaction tracker's window.
 *
 * The read is unbounded, matching the local half of `useInteractions`: a bound
 * applied locally would make a chip's count *fall* as newer reactions pushed older
 * ones out of the window, and a count that goes down is worse than one that is a
 * floor.
 */

import { Kind, type NostrEvent } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import {
  type GroupedReactions,
  groupReactions,
  NO_REACTIONS,
} from "./noteReactions";

const NO_EVENTS: readonly NostrEvent[] = [];

/**
 * Reaction events for one note, at a stable identity.
 *
 * The store re-emits its whole matching set on every write, so the array is only
 * replaced when the set of event ids actually changed — otherwise a reaction on an
 * unrelated note would re-render this row and re-group its chips.
 */
function useReactionEvents(noteId: string): readonly NostrEvent[] {
  const engine = useEngine();
  const [events, setEvents] = useState<readonly NostrEvent[]>(NO_EVENTS);

  useEffect(() => {
    if (noteId === "") {
      setEvents(NO_EVENTS);
      return;
    }
    setEvents(NO_EVENTS);
    return engine.store.observe(
      { kinds: [Kind.Reaction], "#e": [noteId] },
      (rows) => {
        setEvents((current) => {
          if (rows.length === current.length) {
            const same = rows.every(
              (row, i) => row.event.id === current[i]?.id,
            );
            if (same) return current;
          }
          return rows.map((row) => row.event);
        });
      },
    );
  }, [engine, noteId]);

  return events;
}

/** Grouped reactions for one note. See `noteReactions.ts` for the rules. */
export function useNoteReactions(
  noteId: string,
  viewerPubkey?: string,
): GroupedReactions {
  const events = useReactionEvents(noteId);
  return useMemo(
    () =>
      events.length === 0 ? NO_REACTIONS : groupReactions(events, viewerPubkey),
    [events, viewerPubkey],
  );
}
