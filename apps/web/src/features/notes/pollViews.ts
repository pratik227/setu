/**
 * A poll's ballot, as the row renders it.
 *
 * The arithmetic is trivial and the *wording* is the whole job, for the same
 * reason `countAggregate.ts` exists: we are holding a sample and the obvious
 * rendering claims a result. "62% — Yes" over a bar is a statement about how the
 * poll went. What we actually know is "5 of the 8 responses this device was served
 * picked Yes", and those are different claims — the second is a measurement, the
 * first is an extrapolation from a sample nobody chose, taken over relays nobody
 * enumerated.
 *
 * So this module produces:
 *
 *  - `atLeast` per option, never a percentage. The bar's width is `shareOfSample`,
 *    which exists for layout and is deliberately not formatted into text anywhere.
 *  - one `sampleNotice` line that states the denominator and says it is a floor.
 *    A poll card without that line is the misleading version of this feature.
 *
 * The other trap is the denominator itself. A multiple-choice poll's shares do not
 * sum to 1 — one voter can pick three options — so a bar is a share *of voters*,
 * not a slice of a pie, and nothing here arranges them as one.
 */

import type { Poll, PollTally } from "@setu/protocol";

/** One option's row on the ballot. */
export interface PollOptionRow {
  readonly id: string;
  readonly label: string;
  /**
   * Voters we counted for this option. A floor: the responses we were served are
   * a subset of the responses that exist, so this can only be too low.
   */
  readonly atLeast: number;
  /**
   * `atLeast / voters`, clamped to 0..1 — **for the bar's width only**.
   *
   * Never formatted into text. A number rendered as "62%" reads as the poll's
   * result, and this is the share of a sample; the bar is honest because it sits
   * under a line that says what the denominator is, and a percentage label would
   * be read without that line.
   */
  readonly shareOfSample: number;
  /** The reader's own newest response picked this option. */
  readonly chosen: boolean;
}

/** Everything a poll card renders. */
export interface PollView {
  readonly question: string;
  readonly options: readonly PollOptionRow[];
  /**
   * Distinct voters we counted — the denominator every option row is "N of" and
   * the number `sampleNotice` describes.
   *
   * Not turnout. It is how many responses reached this device, which is a fact
   * about our relay set as much as about the poll.
   */
  readonly voters: number;
  /** True for a multiple-choice poll: the controls are checkboxes, not radios. */
  readonly multiple: boolean;
  readonly ended: boolean;
  readonly endsAt?: number;
  /**
   * The one line that keeps the card honest: what the counts are counted over.
   *
   * Always present, including when there is nothing to count — "0 responses" and
   * "no responses reached us" are different statements, and a bar chart of zeroes
   * with no caption reads as the first.
   */
  readonly sampleNotice: string;
  /** Extra sentences about how the sample was cleaned up. May be empty. */
  readonly caveats: readonly string[];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Wording for the tally line.
 *
 * `bounded` means the relay query hit its own limit, so responses were withheld to
 * honour it — the count is a floor for a second, independent reason and the line
 * says so rather than folding it into the same phrase.
 */
function sampleNotice(tally: PollTally, bounded: boolean): string {
  if (tally.voters === 0) {
    return "No responses to this poll reached the relays this device reads. That is not the same as nobody having voted.";
  }
  const responses = plural(tally.voters, "response", "responses");
  const floor = bounded
    ? "at least this many — the query was capped, so older responses may not have been served"
    : "a floor, not a result: we can only count what our relays carried";
  return `${responses} on the relays this device reads — ${floor}.`;
}

function caveats(tally: PollTally): readonly string[] {
  const out: string[] = [];
  if (tally.revisedVoters > 0) {
    // Evidence that newest-per-voter collapsing happened. Counting every event
    // instead would have inflated the tally by exactly this much.
    out.push(
      `${plural(tally.revisedVoters, "voter", "voters")} answered more than once; only their newest response is counted.`,
    );
  }
  if (tally.lateResponses > 0) {
    out.push(
      `${plural(tally.lateResponses, "response", "responses")} arrived after the poll closed and were not counted.`,
    );
  }
  return out;
}

export interface PollViewInput {
  readonly poll: Poll;
  readonly tally: PollTally;
  /** True when the relay query reached its limit, so the sample is truncated. */
  readonly bounded: boolean;
  /** Option ids the reader's own newest response picked. */
  readonly chosen: ReadonlySet<string>;
  /** Current time in seconds. A parameter so this stays pure. */
  readonly now: number;
}

/** Build the ballot. Pure: the same inputs always give the same card. */
export function pollView({
  poll,
  tally,
  bounded,
  chosen,
  now,
}: PollViewInput): PollView {
  const byOption = new Map(
    tally.options.map((option) => [option.optionId, option.atLeast]),
  );

  return {
    question: poll.question,
    options: poll.options.map((option) => {
      const atLeast = byOption.get(option.id) ?? 0;
      return {
        id: option.id,
        label: option.label,
        atLeast,
        // Zero voters gives a zero-width bar rather than a division by zero, which
        // renders as `NaN%` in a `style` attribute and silently drops the rule.
        shareOfSample: tally.voters === 0 ? 0 : atLeast / tally.voters,
        chosen: chosen.has(option.id),
      };
    }),
    voters: tally.voters,
    multiple: poll.type === "multiplechoice",
    ended: poll.endsAt !== undefined && now > poll.endsAt,
    ...(poll.endsAt !== undefined ? { endsAt: poll.endsAt } : {}),
    sampleNotice: sampleNotice(tally, bounded),
    caveats: caveats(tally),
  };
}

/** "3 of 8 responses we hold", the only count text on an option row. */
export function optionCountLabel(row: PollOptionRow, voters: number): string {
  if (voters === 0) return "no responses";
  return `${row.atLeast} of ${voters}`;
}
