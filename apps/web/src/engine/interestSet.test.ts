import { describe, expect, it } from "vitest";
import { type InterestPolicy, InterestSet } from "./interestSet";

const POLICY: InterestPolicy = {
  max: 5,
  threshold: 3,
  cooldownMs: 10_000,
  maxStaleMs: 30_000,
};

const set = (over: Partial<InterestPolicy> = {}): InterestSet =>
  new InterestSet({ ...POLICY, ...over });

describe("InterestSet — publishing", () => {
  it("publishes the first non-empty set immediately", () => {
    const interest = set();
    expect(interest.shouldPublish(0)).toBe(false);
    interest.want(["a"]);
    expect(interest.delayUntilPublishable(0)).toBe(0);
    expect(interest.publish(0)).toEqual(["a"]);
  });

  it("does not republish for fewer than `threshold` new ids", () => {
    const interest = set();
    interest.want(["a"]);
    interest.publish(0);
    interest.want(["b", "c"]);
    expect(interest.shouldPublish(11_000)).toBe(false);
  });

  it("waits out the cooldown once the threshold is met", () => {
    const interest = set();
    interest.want(["a"]);
    interest.publish(0);
    interest.want(["b", "c", "d"]);
    expect(interest.shouldPublish(5_000)).toBe(false);
    expect(interest.delayUntilPublishable(5_000)).toBe(5_000);
    expect(interest.shouldPublish(10_000)).toBe(true);
    expect(interest.publish(10_000)).toEqual(["a", "b", "c", "d"]);
  });

  it("publishes a sub-threshold set once it has gone stale", () => {
    const interest = set();
    interest.want(["a"]);
    interest.publish(0);
    interest.want(["b"]);
    expect(interest.delayUntilPublishable(0)).toBe(30_000);
    expect(interest.shouldPublish(29_999)).toBe(false);
    expect(interest.shouldPublish(30_000)).toBe(true);
  });

  it("reports no reachable delay when nothing new is wanted", () => {
    const interest = set();
    interest.want(["a"]);
    interest.publish(0);
    // Nothing but new demand can make this publishable, so a caller must not arm
    // a timer — that is the difference between one wakeup and a spin.
    expect(interest.delayUntilPublishable(0)).toBeUndefined();
  });
});

describe("InterestSet — growth", () => {
  it("counts an id already wanted as re-interest, not as new demand", () => {
    const interest = set();
    interest.want(["a"]);
    interest.publish(0);
    // A feed re-rendering its rows registers the same ids over and over.
    interest.want(["a", "a", "a"]);
    expect(interest.freshCount).toBe(0);
    expect(interest.shouldPublish(60_000)).toBe(false);
  });

  it("never shrinks the wanted set when a surface stops asking", () => {
    const interest = set();
    interest.want(["a", "b"]);
    interest.want(["b"]);
    expect(interest.wantedIds).toEqual(["a", "b"]);
  });

  it("evicts the least recently wanted ids at the cap", () => {
    const interest = set({ max: 3 });
    interest.want(["a", "b", "c"]);
    // Touching "a" moves it to the recent end, so "b" is the next to go.
    interest.want(["a"]);
    interest.want(["d"]);
    expect(interest.wantedIds).toEqual(["c", "a", "d"]);
  });

  it("republishes on eviction without waiting for the threshold", () => {
    const interest = set({ max: 2 });
    interest.want(["a", "b"]);
    interest.publish(0);
    interest.want(["c"]);
    // "a" has been evicted while the relay is still being asked about it, which
    // one new id alone would not have been enough to fix.
    expect(interest.wantedIds).toEqual(["b", "c"]);
    expect(interest.freshCount).toBeLessThan(POLICY.threshold);
    expect(interest.delayUntilPublishable(0)).toBe(POLICY.cooldownMs);
  });

  it("does not let a set pinned at its cap republish on every new id", () => {
    // The notification target set lives permanently at its cap, so eviction
    // happens on every arriving event. Treating that as urgent would turn the cap
    // into a re-subscribe per notification — the churn this class exists to stop.
    const interest = set({ max: 2 });
    interest.want(["a", "b"]);
    interest.publish(0);
    for (const id of ["c", "d", "e"]) interest.want([id]);
    expect(interest.shouldPublish(1_000)).toBe(false);
    expect(interest.shouldPublish(POLICY.cooldownMs)).toBe(true);
  });

  it("ignores empty ids", () => {
    const interest = set();
    interest.want(["", "a"]);
    expect(interest.wantedIds).toEqual(["a"]);
  });
});
