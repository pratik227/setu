import { describe, expect, it } from "vitest";
import { trendingWindowLabel } from "./DiscoverPanel";

/**
 * The window is a *synced number*, and the panel offers four of them.
 *
 * So the interesting cases are the values that are not in the list. A document
 * written by a build offering different windows, or by a hand edit, arrives with a
 * number the picker cannot name — and the panel prints that window into every claim
 * it makes ("across 40 notes from the last …"). Rounding to the nearest listed option
 * would make each of those a statement about a period the panel is not filtering on.
 */

describe("trendingWindowLabel", () => {
  it.each([
    [3600, "1 hour"],
    [4 * 3600, "4 hours"],
    [12 * 3600, "12 hours"],
    [24 * 3600, "24 hours"],
  ])("names the listed window %i as %s", (seconds, label) => {
    expect(trendingWindowLabel(seconds)).toBe(label);
  });

  it.each([
    [6 * 3600, "6 hours"],
    [48 * 3600, "48 hours"],
    [90 * 60, "2 hours"],
    [1800, "30 minutes"],
    [60, "1 minute"],
    [30, "30 seconds"],
  ])("labels the unlisted window %i as %s", (seconds, label) => {
    expect(trendingWindowLabel(seconds)).toBe(label);
  });

  it("never renders a zero or a fraction", () => {
    // A sub-second window is nonsense, but it is a number a document can carry, and
    // "the last 0 seconds" reads as a bug in the count rather than in the setting.
    for (const seconds of [0.4, 0.9, 1]) {
      expect(trendingWindowLabel(seconds)).toBe("1 second");
    }
  });

  it("pluralises on the rendered number, not the input", () => {
    // 3540s rounds to 59 minutes, 3599s rounds to 60 — both plural. The trap is a
    // value that rounds *to* one, which must not read "1 minutes".
    expect(trendingWindowLabel(62)).toBe("1 minute");
    expect(trendingWindowLabel(3660)).toBe("1 hour");
  });
});
