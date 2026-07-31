import { Kind } from "@setu/protocol";
import { useMemo } from "react";
import type { AuthorView } from "../notes/types";
import { fallbackAuthor, useAuthors } from "../profiles/useAuthors";
import { rankAuthors } from "./ranking";
import { useStoreEvents } from "./useStoreEvents";

export interface ActiveAuthor {
  readonly author: AuthorView;
  /** Notes by this author in the sample. */
  readonly count: number;
}

export interface ActiveAuthors {
  readonly authors: readonly ActiveAuthor[];
  /** Notes the ranking was computed over. */
  readonly sampleSize: number;
  readonly loading: boolean;
}

export interface ActiveAuthorsOptions {
  readonly sampleSize?: number;
  readonly limit?: number;
  readonly subscribe?: boolean;
}

/**
 * Authors ranked by how often they appear in the local store's newest notes.
 *
 * "Active in your feed", not "popular on Nostr". The ranking is over the notes
 * your relay set delivered, so it reflects who you have been receiving — which
 * is genuinely useful for discovery and is a claim we can actually support.
 *
 * Metadata resolution goes through `useAuthors`, so this hook adds no
 * subscriptions of its own for profiles: the batcher already coalesces every
 * profile need in the app into a few rate-limited reads.
 */
export function useActiveAuthors(
  options: ActiveAuthorsOptions = {},
): ActiveAuthors {
  const sampleSize = options.sampleSize ?? 300;
  const limit = options.limit ?? 20;

  const filter = useMemo(
    () => ({ kinds: [Kind.ShortTextNote], limit: sampleSize }),
    [sampleSize],
  );
  const events = useStoreEvents(filter, {
    ...(options.subscribe !== undefined
      ? { subscribe: options.subscribe }
      : {}),
  });

  const ranked = useMemo(
    () =>
      rankAuthors(
        events.map((stored) => stored.event),
        limit,
      ),
    [events, limit],
  );

  const pubkeys = useMemo(() => ranked.map((r) => r.pubkey), [ranked]);
  const resolved = useAuthors(pubkeys);

  const authors = useMemo(
    () =>
      ranked.map((entry) => ({
        author: resolved.get(entry.pubkey) ?? fallbackAuthor(entry.pubkey),
        count: entry.count,
      })),
    [ranked, resolved],
  );

  return { authors, sampleSize: events.length, loading: events.length === 0 };
}
