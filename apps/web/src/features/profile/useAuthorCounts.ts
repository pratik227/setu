import {
  type AggregatedCount,
  aggregateCount,
  NO_COUNT,
  relaysFor,
} from "@setu/core";
import { Kind } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_RELAYS, useEngine } from "../../engine/EngineProvider";

/**
 * How many notes, articles and followers an author has — asked of relays, not
 * counted locally.
 *
 * This replaces counting rows in the local store, which was honest about being a
 * local sample but reported 22 where the real figure was 388. The gap is not a bug
 * in the counting; it is that the store holds one page of that author's history and
 * always will.
 *
 * NIP-45 `COUNT` is the way out: the relay answers with a number and sends no
 * events, so a total costs one round trip instead of a download. Three constraints
 * shape how it is used here.
 *
 * **Only COUNT-capable relays are asked.** A relay without NIP-45 does not reply
 * and does not error — the subscription just hangs. `relaysFor("counts", …)` filters
 * against each relay's NIP-11 document, and relays we have no document for are kept
 * (a missing document is common and does not mean refusal).
 *
 * **Answers are combined with `max`, not `+`.** See `countAggregate.ts`: every relay
 * stores the same notes, so summing multiplies the answer by the number of relays.
 *
 * **No answer is not zero.** When nothing supports COUNT the result is `unavailable`
 * and the UI falls back to the local figure, relabelled as local. Printing "0 notes"
 * for someone with thousands is worse than printing a smaller true number that says
 * what it is.
 */

/** Counts we ask for, and the filter that defines each. */
export interface AuthorCounts {
  readonly notes: AggregatedCount;
  readonly replies: AggregatedCount;
  readonly reads: AggregatedCount;
  /**
   * How many kind-3 lists these relays hold that name this author.
   *
   * A follower count, and it is a *lower bound* in a stronger sense than the others.
   * `notes` is bounded because a relay may not hold every note; this is bounded
   * because nobody publishes their followers at all. The edge only exists inside
   * other people's contact lists, so the honest ceiling on what any client can say is
   * "this many of the lists these relays happen to hold" — and `countAggregate`'s
   * `max`-not-`sum` rule matters more here than anywhere, since a popular account's
   * followers overlap almost completely between relays.
   *
   * `useAuthorFollowing` is the other direction and needs none of this hedging:
   * following is a list its own author publishes.
   */
  readonly followers: AggregatedCount;
  /** True while at least one COUNT is in flight. */
  readonly loading: boolean;
  /** False when no configured relay implements NIP-45. */
  readonly supported: boolean;
}

const EMPTY: AuthorCounts = {
  notes: NO_COUNT,
  replies: NO_COUNT,
  reads: NO_COUNT,
  followers: NO_COUNT,
  loading: false,
  supported: false,
};

export function useAuthorCounts(pubkey: string | undefined): AuthorCounts {
  const engine = useEngine();
  const [counts, setCounts] = useState<AuthorCounts>(EMPTY);

  // Which relays can answer at all. Recomputed per pubkey rather than memoised
  // globally because NIP-11 documents land asynchronously — a relay unknown at
  // mount may be known by the time a profile is opened.
  const capable = useMemo(
    () => relaysFor("counts", DEFAULT_RELAYS, engine.relayInfo.all()),
    [engine],
  );

  useEffect(() => {
    if (!pubkey) {
      setCounts(EMPTY);
      return;
    }
    if (capable.length === 0) {
      setCounts({ ...EMPTY, supported: false });
      return;
    }
    let cancelled = false;
    setCounts((previous) => ({ ...previous, loading: true, supported: true }));

    /*
     * Only two of the three figures can be asked for.
     *
     * `notes` is every kind-1 the author published, replies included — NIP-01 has
     * no "has no `e` tag" filter, so a relay cannot separate top-level notes from
     * replies and neither can we. `replies` is therefore left unavailable rather
     * than filled in from the local index, because a local number displayed under
     * a "counted by your relays" label is a lie about where it came from.
     */
    const ask = async (filter: Record<string, unknown>) => {
      const results = await engine.pool.count(
        capable.map((relay) => ({ relay, filter: filter as never })),
      );
      return aggregateCount(results);
    };

    void (async () => {
      const [notes, reads, followers] = await Promise.all([
        ask({ kinds: [Kind.ShortTextNote], authors: [pubkey] }),
        ask({ kinds: [Kind.LongFormArticle], authors: [pubkey] }),
        // Followers, by the only route there is: count the contact lists that name
        // this author. `#p`, not `authors` — this asks about lists *other people*
        // wrote, which is the whole reason the figure cannot be exact.
        ask({ kinds: [Kind.Contacts], "#p": [pubkey] }),
      ]);
      if (cancelled) return;
      setCounts({
        notes,
        // Unanswerable by any relay; the UI omits the pill rather than
        // substituting the local figure. See the note above.
        replies: NO_COUNT,
        reads,
        followers,
        loading: false,
        supported: true,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [pubkey, capable, engine]);

  return counts;
}
