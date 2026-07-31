/**
 * Reconnect backoff.
 *
 * Exponential with jitter and a hard cap. The jitter matters more than it looks:
 * a client that reconnects to twenty relays on a deterministic schedule
 * synchronises its own retries into a thundering herd after any network blip, and
 * relays rate-limit accordingly.
 *
 * `random` is injected so the schedule is assertable in tests.
 */

/** Backoff tuning. Defaults give 1s → 30s with ±30% jitter. */
export interface BackoffOptions {
  /** Delay before the first retry, before jitter. */
  readonly baseMs?: number;
  /** Ceiling for the delay, jitter included. */
  readonly maxMs?: number;
  /** Fraction of the delay to jitter by, in each direction. 0 disables. */
  readonly jitterRatio?: number;
  /** Source of randomness in `[0, 1)`. Inject for deterministic tests. */
  readonly random?: () => number;
}

/** Resolved backoff defaults. */
export const DEFAULT_BACKOFF = {
  baseMs: 1_000,
  maxMs: 30_000,
  jitterRatio: 0.3,
} as const;

/**
 * Delay in ms before retry number `attempt` (0-based).
 *
 * `random() === 0.5` yields the un-jittered schedule
 * `1s, 2s, 4s, 8s, 16s, 30s, 30s, …`.
 */
export function computeBackoffDelay(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const maxMs = options.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const jitterRatio = options.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio;
  const random = options.random ?? Math.random;

  const safeAttempt = Math.max(0, Math.floor(attempt));
  // 2 ** 40 already overflows any sane cap; clamp the exponent to keep the
  // arithmetic finite.
  const raw = Math.min(maxMs, baseMs * 2 ** Math.min(safeAttempt, 40));
  const jitter = raw * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.min(maxMs, Math.round(raw + jitter)));
}
