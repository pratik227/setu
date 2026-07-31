import { describe, expect, it } from "vitest";
import { aggregateCount, formatCount, NO_COUNT } from "./countAggregate";
import type { RelayCountResult } from "./countRequests";

const ok = (
  relay: string,
  count: number,
  approximate = false,
): RelayCountResult => ({
  relay,
  ok: true,
  count,
  approximate,
});
const fail = (relay: string): RelayCountResult => ({
  relay,
  ok: false,
  reason: "timeout",
});

describe("aggregateCount", () => {
  it("takes the maximum, never the sum", () => {
    // The category error this prevents: every relay stores the same notes, so
    // summing four answers for a 400-note author reports 1,600.
    const result = aggregateCount([ok("a", 400), ok("b", 398), ok("c", 400)]);
    expect(result.atLeast).toBe(400);
  });

  it("is not the average either", () => {
    // A young relay holds a fraction of an old account's history; averaging
    // lands below every individual answer, and so below the truth.
    expect(aggregateCount([ok("a", 400), ok("b", 10)]).atLeast).toBe(400);
  });

  it("marks the aggregate approximate if any relay estimated", () => {
    // The maximum may well be the estimated figure.
    expect(aggregateCount([ok("a", 100), ok("b", 900, true)]).approximate).toBe(
      true,
    );
    expect(aggregateCount([ok("a", 100), ok("b", 90)]).approximate).toBe(false);
  });

  it("distinguishes no answer from a count of zero", () => {
    // "0 notes" about someone with thousands, because no relay supports COUNT,
    // is a lie the reader cannot detect.
    const none = aggregateCount([fail("a"), fail("b")]);
    expect(none.unavailable).toBe(true);
    expect(none.asked).toBe(2);
    expect(none.answered).toBe(0);

    const zero = aggregateCount([ok("a", 0)]);
    expect(zero.unavailable).toBe(false);
    expect(zero.atLeast).toBe(0);
  });

  it("reports how many of the asked relays answered", () => {
    const result = aggregateCount([ok("a", 5), fail("b"), fail("c")]);
    expect(result).toMatchObject({ answered: 1, asked: 3, atLeast: 5 });
  });

  it("handles being asked nothing", () => {
    expect(aggregateCount([])).toEqual({ ...NO_COUNT, asked: 0 });
  });
});

describe("formatCount", () => {
  it("returns undefined when there is no answer, so callers cannot print zero", () => {
    expect(formatCount(aggregateCount([fail("a")]))).toBeUndefined();
  });

  it("prints a small count plainly", () => {
    // "at least 3" reads as pedantry when one relay almost certainly has it all.
    expect(formatCount(aggregateCount([ok("a", 3)]))).toBe("3");
  });

  it("marks a large count as a lower bound", () => {
    expect(formatCount(aggregateCount([ok("a", 400)]))).toBe("400+");
  });

  it("marks an estimate", () => {
    expect(formatCount(aggregateCount([ok("a", 12, true)]))).toBe("~12");
    expect(formatCount(aggregateCount([ok("a", 4000, true)]))).toBe("~4,000+");
  });

  it("honours a custom exact threshold", () => {
    expect(formatCount(aggregateCount([ok("a", 50)]), { exactBelow: 10 })).toBe(
      "50+",
    );
  });

  it("prints a genuine zero", () => {
    expect(formatCount(aggregateCount([ok("a", 0)]))).toBe("0");
  });
});
