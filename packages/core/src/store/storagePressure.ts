/**
 * How full the browser's storage is, and what retention should do about it.
 *
 * {@link ./retention} decides *what* may be evicted and evicts by age. Age alone was
 * the whole policy, and it does not close the loop the module was written for: the
 * doc says it exists to stay inside the quota, but nothing ever asked what the quota
 * was. A heavy account can hold thirty days of a busy follow list and still meet the
 * limit, and the failure mode is the one that module names — a write error on ingest,
 * so the client keeps rendering and silently stops recording.
 *
 * So this reads `navigator.storage.estimate()` and turns it into a pressure level that
 * tightens retention. Three properties matter more than the arithmetic.
 *
 * ## Unknown is its own answer, and it means "change nothing"
 *
 * `estimate()` is advisory. It is absent in some browsers, coarse or deliberately
 * padded in others, and can report a quota far larger than the disk. Both ways of
 * collapsing that into a number are harmful: treating unknown as *full* deletes a
 * reader's history for no reason, and treating it as *empty* means the protection never
 * engages. So `unknown` is a level of its own and it maps to the existing age-only
 * policy — the behaviour before this module existed, which is a safe thing to fall back
 * to precisely because it was safe on its own.
 *
 * ## Pressure tightens the window, it never widens the allowlist
 *
 * Under pressure the *age* comes down. What may be evicted at all is untouched: still
 * no own events, no private messages, no replaceable configuration, no NIP-70 protected
 * events. A quota emergency is not a reason to destroy the only copy of something — see
 * `retention.ts` for why that list is default-deny.
 *
 * ## There is a floor, and it is not zero
 *
 * However full the disk, *pressure* never pulls the window below
 * {@link MINIMUM_RETENTION_SECONDS}. Below that the reader is scrolling rows while they
 * are being deleted, and a client that empties the screen you are reading has chosen
 * the wrong failure. If the floor is not enough to fit, the honest outcome is a write
 * error the app can report — not a cache that eats the present to save itself.
 *
 * The floor bounds pressure, not the operator: a caller who configures a window
 * shorter than the floor keeps it. See {@link retentionSecondsFor}.
 */

import type { RetentionPolicy } from "./retention";

/** The shape of `navigator.storage.estimate()`, as much of it as we use. */
export interface StorageEstimate {
  readonly usage?: number | undefined;
  readonly quota?: number | undefined;
}

export type PressureLevel = "unknown" | "ok" | "high" | "critical";

/** Above this share of the quota, start tightening. */
export const HIGH_PRESSURE_RATIO = 0.7;
/** Above this share, tighten hard — a write failure is close. */
export const CRITICAL_PRESSURE_RATIO = 0.9;

/** Never evict anything newer than this, at any pressure. Seven days. */
export const MINIMUM_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** Retention window under high pressure, before the floor is applied. */
export const HIGH_PRESSURE_SECONDS = 14 * 24 * 60 * 60;

export interface StoragePressure {
  readonly level: PressureLevel;
  /** Share of quota used, or `undefined` when it could not be determined. */
  readonly ratio: number | undefined;
  readonly usage: number | undefined;
  readonly quota: number | undefined;
}

const UNKNOWN: StoragePressure = {
  level: "unknown",
  ratio: undefined,
  usage: undefined,
  quota: undefined,
};

/**
 * Classify a storage estimate.
 *
 * Every way the estimate can be useless resolves to `unknown` rather than to a number:
 * a missing field, a non-finite one, a negative one, and a zero quota — which is not
 * "completely full" but a browser declining to answer, and dividing by it would produce
 * `Infinity` and evict everything evictable on the spot.
 */
export function classifyStorage(
  estimate: StorageEstimate | undefined,
): StoragePressure {
  if (!estimate) return UNKNOWN;
  const { usage, quota } = estimate;
  if (typeof usage !== "number" || typeof quota !== "number") return UNKNOWN;
  if (!Number.isFinite(usage) || !Number.isFinite(quota)) return UNKNOWN;
  if (usage < 0 || quota <= 0) return UNKNOWN;

  const ratio = usage / quota;
  const level: PressureLevel =
    ratio >= CRITICAL_PRESSURE_RATIO
      ? "critical"
      : ratio >= HIGH_PRESSURE_RATIO
        ? "high"
        : "ok";
  return { level, ratio, usage, quota };
}

/**
 * Read the estimate from a storage manager, never throwing.
 *
 * `estimate()` rejects in some private-browsing modes and is absent entirely in
 * others. A failure here is not worth surfacing — it means the same thing as an absent
 * API, and the caller's answer to both is `unknown`.
 */
export async function readStorageEstimate(storage?: {
  estimate?: () => Promise<StorageEstimate>;
}): Promise<StoragePressure> {
  if (typeof storage?.estimate !== "function") return UNKNOWN;
  try {
    return classifyStorage(await storage.estimate());
  } catch {
    return UNKNOWN;
  }
}

/**
 * The retention window a pressure level calls for, floored.
 *
 * `unknown` and `ok` both return the base policy's own window: pressure only ever
 * *shortens* it, so a configured 30 days is never silently extended because the disk
 * happens to be empty.
 */
export function retentionSecondsFor(
  level: PressureLevel,
  baseSeconds: number,
): number {
  const target =
    level === "critical"
      ? MINIMUM_RETENTION_SECONDS
      : level === "high"
        ? HIGH_PRESSURE_SECONDS
        : baseSeconds;
  /*
   * Floor first, then clamp to the base — and the order is the whole rule.
   *
   * The two constraints genuinely conflict for a caller who configured a window
   * *shorter* than the floor, and flooring last resolves it the wrong way: it would
   * widen a deliberately aggressive 3-day policy to 7, so a configured setting would
   * silently not apply. The floor exists to stop *pressure* from eating the present,
   * not to overrule the operator. So it bounds the pressure-derived target, and the
   * base still wins whenever it is stricter.
   */
  return Math.min(baseSeconds, Math.max(MINIMUM_RETENTION_SECONDS, target));
}

/**
 * The base policy, adjusted for how full storage is.
 *
 * Returns the *same object* when nothing changes, so a caller can skip work on the
 * common case of an unremarkable disk.
 */
export function policyForPressure(
  base: RetentionPolicy,
  level: PressureLevel,
): RetentionPolicy {
  const maxAgeSeconds = retentionSecondsFor(level, base.maxAgeSeconds);
  // Under critical pressure a sweep is also allowed to examine more rows per pass:
  // the cap exists so a sweep does not stall the tab, and a tab that is about to fail
  // its next write has a worse problem than a slow sweep.
  const maxPerSweep =
    level === "critical" ? base.maxPerSweep * 2 : base.maxPerSweep;
  if (
    maxAgeSeconds === base.maxAgeSeconds &&
    maxPerSweep === base.maxPerSweep
  ) {
    return base;
  }
  return { ...base, maxAgeSeconds, maxPerSweep };
}

/**
 * Whether it is worth sweeping at all right now.
 *
 * `unknown` sweeps: it is the age-only behaviour that existed before this module, and
 * the one thing worse than sweeping on an unmeasurable disk is never reclaiming
 * anything on a browser that does not implement `estimate()`.
 */
export function shouldSweep(level: PressureLevel): boolean {
  return level !== "ok";
}
