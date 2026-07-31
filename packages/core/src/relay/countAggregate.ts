import type { RelayCountResult } from "./countRequests";

/**
 * Turning several relays' COUNT answers into one number you can show.
 *
 * The arithmetic is the whole point, and the obvious operation is wrong.
 *
 * **Not the sum.** The same note is stored on every relay that accepted it, so
 * summing four relays' answers for an author with 400 notes reports 1,600. This is
 * not a rounding problem, it is a category error: each relay is answering "how many
 * of these do *I* hold", and those sets overlap almost completely.
 *
 * **Not the average either.** A relay that joined the network last month holds a
 * fraction of an old account's history. Averaging drags the answer below every
 * individual relay's, which is below the truth by construction.
 *
 * **The maximum.** Whichever relay holds the most is a *lower bound* on the real
 * total, and it is the tightest lower bound the data supports. It is exact when one
 * relay has everything, and too low otherwise — never too high. For a count shown
 * next to someone's name, erring low and saying so beats a confident wrong number.
 *
 * That is why {@link AggregatedCount} carries `atLeast` rather than `count`: the
 * name is the disclaimer, and it makes a caller that formats it as an exact total
 * look wrong in review.
 */

export interface AggregatedCount {
  /**
   * A lower bound on the true total — the largest single relay's answer.
   *
   * Named for what it is. There is no way to compute an exact network-wide total
   * without an index of the whole network, which no client has.
   */
  readonly atLeast: number;
  /** True when any contributing relay said its own figure was an estimate. */
  readonly approximate: boolean;
  /** How many relays answered with a usable number. */
  readonly answered: number;
  /** How many we asked. `answered < asked` means the bound is looser. */
  readonly asked: number;
  /** No relay answered, so there is no number — distinct from a count of zero. */
  readonly unavailable: boolean;
}

export const NO_COUNT: AggregatedCount = {
  atLeast: 0,
  approximate: false,
  answered: 0,
  asked: 0,
  unavailable: true,
};

export function aggregateCount(
  results: readonly RelayCountResult[],
): AggregatedCount {
  const answers = results.filter((r) => r.ok);
  if (answers.length === 0) {
    return { ...NO_COUNT, asked: results.length };
  }
  let atLeast = 0;
  let approximate = false;
  for (const answer of answers) {
    if (!answer.ok) continue;
    if (answer.count > atLeast) atLeast = answer.count;
    // One estimate anywhere in the set makes the aggregate an estimate. The
    // maximum may well be the estimated figure.
    if (answer.approximate) approximate = true;
  }
  return {
    atLeast,
    approximate,
    answered: answers.length,
    asked: results.length,
    unavailable: false,
  };
}

/**
 * How to render a count, honestly.
 *
 * The distinctions this preserves, each of which a naive `String(count)` erases:
 *
 *  - **No answer is not zero.** "0 notes" about someone with thousands, because no
 *    relay we asked supports COUNT, is a lie the reader has no way to detect.
 *  - **A bound is not a total.** Below the exact-enough threshold the figure is
 *    shown plainly, since "at least 3" reads as pedantry; above it the `+` says
 *    the real number is larger.
 *  - **An estimate is not a measurement.** `~` when a relay said so.
 */
export function formatCount(
  value: AggregatedCount,
  options: { readonly exactBelow?: number } = {},
): string | undefined {
  if (value.unavailable) return undefined;
  const exactBelow = options.exactBelow ?? 100;
  const prefix = value.approximate ? "~" : "";
  // A single relay answering, below the threshold, is very likely the whole
  // truth; adding "+" there would hedge a number that is almost certainly exact.
  const bounded = value.atLeast >= exactBelow;
  return `${prefix}${value.atLeast.toLocaleString()}${bounded ? "+" : ""}`;
}
