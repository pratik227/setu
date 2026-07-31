import { describe, expect, it } from "vitest";
import { defaultRetentionPolicy } from "./retention";
import {
  CRITICAL_PRESSURE_RATIO,
  classifyStorage,
  HIGH_PRESSURE_RATIO,
  MINIMUM_RETENTION_SECONDS,
  policyForPressure,
  readStorageEstimate,
  retentionSecondsFor,
  shouldSweep,
} from "./storagePressure";

const DAY = 24 * 60 * 60;

describe("classifyStorage", () => {
  it("classifies an ordinary disk as ok", () => {
    const pressure = classifyStorage({ usage: 10, quota: 100 });
    expect(pressure.level).toBe("ok");
    expect(pressure.ratio).toBeCloseTo(0.1);
  });

  it("classifies at the thresholds, inclusively", () => {
    expect(
      classifyStorage({ usage: HIGH_PRESSURE_RATIO * 100, quota: 100 }).level,
    ).toBe("high");
    expect(
      classifyStorage({ usage: CRITICAL_PRESSURE_RATIO * 100, quota: 100 })
        .level,
    ).toBe("critical");
    expect(classifyStorage({ usage: 69.9, quota: 100 }).level).toBe("ok");
  });

  it.each([
    ["no estimate at all", undefined],
    ["a missing usage", { quota: 100 }],
    ["a missing quota", { usage: 10 }],
    ["a non-numeric field", { usage: "10" as unknown as number, quota: 100 }],
    ["an infinite quota", { usage: 10, quota: Number.POSITIVE_INFINITY }],
    ["a NaN usage", { usage: Number.NaN, quota: 100 }],
    ["a negative usage", { usage: -1, quota: 100 }],
  ])("treats %s as unknown", (_label, estimate) => {
    const pressure = classifyStorage(estimate);
    expect(pressure.level).toBe("unknown");
    expect(pressure.ratio).toBeUndefined();
  });

  it("treats a zero quota as unknown, not as completely full", () => {
    // A browser declining to answer, not an emergency. Dividing by it gives Infinity
    // and would evict everything evictable on the spot.
    expect(classifyStorage({ usage: 5, quota: 0 }).level).toBe("unknown");
  });
});

describe("readStorageEstimate", () => {
  it("reads a working storage manager", async () => {
    const pressure = await readStorageEstimate({
      estimate: () => Promise.resolve({ usage: 95, quota: 100 }),
    });
    expect(pressure.level).toBe("critical");
  });

  it("is unknown with no storage manager or no estimate function", async () => {
    expect((await readStorageEstimate(undefined)).level).toBe("unknown");
    expect((await readStorageEstimate({})).level).toBe("unknown");
  });

  it("is unknown when estimate rejects", async () => {
    // It rejects in some private-browsing modes, which means the same thing as the API
    // being absent — not something to surface.
    const pressure = await readStorageEstimate({
      estimate: () => Promise.reject(new Error("denied")),
    });
    expect(pressure.level).toBe("unknown");
  });
});

describe("retentionSecondsFor", () => {
  it("leaves the configured window alone when there is no pressure", () => {
    for (const level of ["unknown", "ok"] as const) {
      expect(retentionSecondsFor(level, 30 * DAY)).toBe(30 * DAY);
    }
  });

  it("shortens under high and critical pressure", () => {
    expect(retentionSecondsFor("high", 30 * DAY)).toBe(14 * DAY);
    expect(retentionSecondsFor("critical", 30 * DAY)).toBe(
      MINIMUM_RETENTION_SECONDS,
    );
  });

  it("pressure never pulls the window below the floor", () => {
    // Below the floor the reader is scrolling rows while they are deleted. A client
    // that empties the screen you are reading has chosen the wrong failure.
    expect(retentionSecondsFor("critical", 30 * DAY)).toBeGreaterThanOrEqual(
      MINIMUM_RETENTION_SECONDS,
    );
    expect(MINIMUM_RETENTION_SECONDS).toBe(7 * DAY);
  });

  it("keeps a window the caller deliberately made shorter than the floor", () => {
    // The two rules conflict here, and this is the resolution: the floor bounds
    // *pressure*, not the operator. Flooring last would widen a deliberately
    // aggressive 3-day policy to 7, so a configured setting would silently not apply.
    for (const level of ["ok", "unknown", "high", "critical"] as const) {
      expect(retentionSecondsFor(level, 3 * DAY)).toBe(3 * DAY);
    }
  });
});

describe("policyForPressure", () => {
  const base = defaultRetentionPolicy({ maxAgeSeconds: 30 * DAY });

  it("returns the same object when nothing changes", () => {
    // So the common case of an unremarkable disk costs no allocation and no work.
    expect(policyForPressure(base, "ok")).toBe(base);
    expect(policyForPressure(base, "unknown")).toBe(base);
  });

  it("tightens the age under pressure", () => {
    expect(policyForPressure(base, "high").maxAgeSeconds).toBe(14 * DAY);
    expect(policyForPressure(base, "critical").maxAgeSeconds).toBe(
      MINIMUM_RETENTION_SECONDS,
    );
  });

  it("raises the sweep cap only when critical", () => {
    expect(policyForPressure(base, "high").maxPerSweep).toBe(base.maxPerSweep);
    expect(policyForPressure(base, "critical").maxPerSweep).toBe(
      base.maxPerSweep * 2,
    );
  });

  it("never widens what may be evicted", () => {
    // Pressure shortens the window; it does not touch the allowlist. A quota
    // emergency is not a reason to destroy the only copy of something.
    for (const level of ["unknown", "ok", "high", "critical"] as const) {
      const policy = policyForPressure(base, level);
      expect(policy.evictableKinds).toEqual(base.evictableKinds);
      expect(policy.keepAuthors).toEqual(base.keepAuthors);
    }
  });
});

describe("shouldSweep", () => {
  it("skips only when storage is measurably fine", () => {
    expect(shouldSweep("ok")).toBe(false);
    expect(shouldSweep("high")).toBe(true);
    expect(shouldSweep("critical")).toBe(true);
  });

  it("sweeps when the level is unknown", () => {
    // The age-only behaviour that existed before this module. Never reclaiming
    // anything on a browser without `estimate()` would be worse.
    expect(shouldSweep("unknown")).toBe(true);
  });
});
