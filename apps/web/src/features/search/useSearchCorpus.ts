/**
 * The snapshot local search runs against.
 *
 * Taken once when the palette opens rather than observed live, which is the
 * opposite of what the rest of this app does with the store — so the reason
 * matters. `observe` fans every store write out to every registered callback, and
 * with a feed running behind an open palette that is hundreds of callbacks a
 * minute, each one re-ranking thousands of candidates while the reader is mid-word.
 * A palette also wants a list that holds still: results reordering under the cursor
 * because a note arrived is how a reader presses Enter on something other than what
 * they were looking at. So this reads the store, and re-reads it exactly when
 * something happened that could plausibly add a match — a completed relay search.
 *
 * The samples are bounded for the usual reason: the store can hold far more than
 * this, and matching is a linear scan on the main thread. But the two bounds are
 * deliberately lopsided. A kind-0 is one small event per person and *is* the answer
 * to "find this person", so the profile bound is generous. Notes are unbounded in
 * volume and the newest ones are the ones anyone is looking for, so that bound is
 * tighter — and the UI says which window it searched, because "no notes matched"
 * over a 2,000-note window is a different statement from one over everything.
 */

import type { NostrEvent } from "@setu/protocol";
import { encodeNpub, Kind, truncateNpub } from "@setu/protocol";
import { useEffect, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { nip05DisplayName } from "../profiles/nip05";
import { parseProfileContent } from "../profiles/profileContent";
import type { NoteCandidate, PersonCandidate } from "./localMatch";

/** Profiles to hold for matching. One small event per person, so this is cheap. */
export const PROFILE_SAMPLE = 4000;

/** Newest notes to search. Named in the UI, because it bounds the claim. */
export const NOTE_SAMPLE = 2000;

/** A profile candidate plus what a row needs to render it. */
export interface SearchPerson extends PersonCandidate {
  readonly avatarUrl?: string;
  /** Best available name — a truncated npub when the profile published none. */
  readonly label: string;
  /** NIP-05 identifier, or a truncated npub. Never a verification claim. */
  readonly handle: string;
}

export interface SearchCorpus {
  readonly people: readonly SearchPerson[];
  readonly notes: readonly NoteCandidate[];
  /** For putting a name on a note row without a second pass over the store. */
  readonly byPubkey: ReadonlyMap<string, SearchPerson>;
  readonly loading: boolean;
  /**
   * The store held at least as many notes as the sample bound, so the search
   * covered a window rather than everything this device has.
   */
  readonly noteSampleFull: boolean;
}

const EMPTY: SearchCorpus = {
  people: [],
  notes: [],
  byPubkey: new Map(),
  loading: false,
  noteSampleFull: false,
};

function toPerson(event: NostrEvent): SearchPerson {
  const details = parseProfileContent(event.content);
  const npub = encodeNpub(event.pubkey);
  const shortNpub = npub ? truncateNpub(npub, 8) : event.pubkey.slice(0, 12);
  return {
    pubkey: event.pubkey,
    ...(npub ? { npub } : {}),
    ...(details.displayName ? { displayName: details.displayName } : {}),
    ...(details.name ? { name: details.name } : {}),
    ...(details.nip05 ? { nip05: details.nip05 } : {}),
    ...(details.about ? { about: details.about } : {}),
    ...(details.picture ? { avatarUrl: details.picture } : {}),
    label: details.displayName ?? details.name ?? shortNpub,
    handle: details.nip05 ? nip05DisplayName(details.nip05) : shortNpub,
  };
}

/**
 * Read the local index for searching.
 *
 * `revision` is the re-read trigger: bump it and the snapshot is retaken. It
 * exists so a completed relay search — whose results reached the store, not this
 * hook — becomes visible without giving the palette a live observer.
 */
export function useSearchCorpus(open: boolean, revision = 0): SearchCorpus {
  const engine = useEngine();
  const [corpus, setCorpus] = useState<SearchCorpus>(EMPTY);

  useEffect(() => {
    if (!open) {
      // Dropped on close: a full snapshot is a few megabytes of strings, and
      // holding it for a palette nobody has open is memory spent on nothing.
      setCorpus(EMPTY);
      return;
    }
    let cancelled = false;
    setCorpus((previous) => ({ ...previous, loading: true }));

    void Promise.all([
      engine.store.query({ kinds: [Kind.Metadata], limit: PROFILE_SAMPLE }),
      engine.store.query({ kinds: [Kind.ShortTextNote], limit: NOTE_SAMPLE }),
    ]).then(([profiles, notes]) => {
      if (cancelled) return;
      const people: SearchPerson[] = [];
      const byPubkey = new Map<string, SearchPerson>();
      for (const row of profiles) {
        // The store enforces replaceable newest-wins, so the first row per
        // author is already the current profile.
        if (byPubkey.has(row.event.pubkey)) continue;
        const person = toPerson(row.event);
        people.push(person);
        byPubkey.set(person.pubkey, person);
      }
      setCorpus({
        people,
        byPubkey,
        notes: notes.map((row) => ({
          id: row.event.id,
          pubkey: row.event.pubkey,
          createdAt: row.event.created_at,
          content: row.event.content,
        })),
        loading: false,
        noteSampleFull: notes.length >= NOTE_SAMPLE,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [engine, open, revision]);

  return corpus;
}
