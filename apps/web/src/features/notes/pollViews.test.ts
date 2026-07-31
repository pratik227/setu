import type { Poll, PollTally } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { optionCountLabel, pollView } from "./pollViews";

const POLL: Poll = {
  id: "1".repeat(64),
  author: "a".repeat(64),
  question: "Ship it?",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  type: "singlechoice",
  relays: [],
  createdAt: 1000,
};

const tally = (over: Partial<PollTally> = {}): PollTally => ({
  options: [
    { optionId: "yes", atLeast: 3 },
    { optionId: "no", atLeast: 1 },
  ],
  voters: 4,
  responses: 4,
  revisedVoters: 0,
  lateResponses: 0,
  ...over,
});

const build = (
  over: {
    poll?: Poll;
    tally?: PollTally;
    bounded?: boolean;
    now?: number;
  } = {},
) =>
  pollView({
    poll: over.poll ?? POLL,
    tally: over.tally ?? tally(),
    bounded: over.bounded ?? false,
    chosen: new Set(),
    now: over.now ?? 2000,
  });

describe("pollView", () => {
  it("carries every declared option through, in the poll's own order", () => {
    expect(build().options.map((row) => row.id)).toEqual(["yes", "no"]);
  });

  it("gives an option with no counted responses a zero, not a gap", () => {
    const view = build({
      tally: tally({ options: [{ optionId: "yes", atLeast: 2 }] }),
    });
    expect(view.options[1]).toMatchObject({ id: "no", atLeast: 0 });
  });

  it("never produces a NaN bar width for a poll nobody answered", () => {
    // `0/0` renders as `NaN%` in a style attribute, which the browser drops — so the
    // bar silently keeps whatever width it had.
    const view = build({
      tally: tally({
        options: [{ optionId: "yes", atLeast: 0 }],
        voters: 0,
        responses: 0,
      }),
    });
    for (const row of view.options) expect(row.shareOfSample).toBe(0);
  });

  it("states the denominator and that the count is a floor", () => {
    const notice = build().sampleNotice;
    expect(notice).toContain("4 responses");
    // The claim the whole module exists to avoid making: a result.
    expect(notice).toContain("floor");
    expect(notice).not.toContain("%");
  });

  it("says something different when nothing reached us, not '0 responses'", () => {
    // "0 responses" over a bar chart of zeroes reads as nobody having voted.
    const notice = build({
      tally: tally({ options: [], voters: 0, responses: 0 }),
    }).sampleNotice;
    expect(notice).toContain("No responses");
    expect(notice).toContain("not the same as nobody having voted");
  });

  it("names the query cap as a second, independent reason the count is low", () => {
    expect(build({ bounded: true }).sampleNotice).toContain("capped");
  });

  it("reports voters whose older answers were discarded", () => {
    const view = build({ tally: tally({ revisedVoters: 2 }) });
    expect(view.caveats.join(" ")).toContain(
      "2 voters answered more than once",
    );
  });

  it("reports responses that arrived after the poll closed", () => {
    const view = build({ tally: tally({ lateResponses: 1 }) });
    expect(view.caveats.join(" ")).toContain("after the poll closed");
  });

  it("marks a poll ended only once its deadline has passed", () => {
    const ending = { ...POLL, endsAt: 2000 };
    expect(build({ poll: ending, now: 1999 }).ended).toBe(false);
    expect(build({ poll: ending, now: 2001 }).ended).toBe(true);
  });

  it("marks the reader's own picks", () => {
    const view = pollView({
      poll: POLL,
      tally: tally(),
      bounded: false,
      chosen: new Set(["no"]),
      now: 2000,
    });
    expect(view.options.map((row) => row.chosen)).toEqual([false, true]);
  });
});

describe("optionCountLabel", () => {
  it("shows a fraction with the denominator, never a percentage", () => {
    const [row] = build().options;
    expect(optionCountLabel(row!, 4)).toBe("3 of 4");
  });

  it("says so plainly when there is nothing to be a fraction of", () => {
    const [row] = build().options;
    expect(optionCountLabel(row!, 0)).toBe("no responses");
  });
});
