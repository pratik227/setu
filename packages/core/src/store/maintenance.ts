/**
 * The timer a host starts to keep a persistent store tidy.
 *
 * `expiration.ts` explains why nothing in this package sets a timer by itself:
 * waking a backgrounded tab is host policy, and a headless engine has no business
 * deciding it. This module is that policy made explicit and opt-in — the host
 * calls {@link startStoreMaintenance} and gets a stop function back, so the
 * scheduling decision stays visible at the composition root instead of being
 * hidden inside a store constructor.
 *
 * It does two things a store cannot do for itself:
 *
 *  - **Runs the NIP-40 sweep on an idle screen.** Every write already sweeps, so
 *    a client receiving relay traffic needs no help. The gap is the idle tab: an
 *    event that expires while nothing is being written stays on a rendered screen
 *    until something touches the store, because no observer fires by itself.
 *  - **Runs retention eviction** (see {@link ./retention}), which is the only
 *    thing that actually bounds a persistent store's size. Without it the store
 *    grows until the origin's quota is reached and *writes* start failing, which
 *    presents as a client that has quietly stopped keeping up with the network.
 *
 * The delay between passes is derived from the store's own next deadline rather
 * than fixed, so a store with nothing expiring costs one indexed read per idle
 * interval, and one with a deadline five seconds out is swept five seconds out.
 * Browsers throttle timers in background tabs to roughly a minute, which is the
 * behaviour we want anyway and the reason the ceiling is a minute.
 */

import type { Timestamp } from "@setu/protocol";
import type { EventStore } from "../contracts";
import type { EvictingEventStore, RetentionPolicy } from "./retention";

/** Opaque host timer handle; `number` in a browser, an object under Node. */
export type TimerHandle = unknown;
export type SetTimer = (fn: () => void, ms: number) => TimerHandle;
export type ClearTimer = (handle: TimerHandle) => void;

/** Never busier than this, even when a deadline has already passed. */
export const MIN_SWEEP_DELAY_MS = 250;
/**
 * Longest we ever sleep. Also the re-check interval when nothing is expiring: a
 * newly arrived event with a one-minute deadline must not wait on a timer that
 * was scheduled when the store had no deadlines at all.
 */
export const MAX_SWEEP_DELAY_MS = 60_000;
/**
 * How long after start-up the first pass runs.
 *
 * The first seconds of a session belong to the feed. Reads already hide expired
 * events, so a sweep that waits costs nothing but reclaimed space, while a sweep
 * that races the first queries competes with them for the same database.
 */
export const STARTUP_DELAY_MS = 5_000;
/** Retention is a bulk read; hourly is often enough to stay ahead of quota. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

export interface StoreMaintenanceOptions {
  readonly store: EventStore & Partial<EvictingEventStore>;
  /** Omit to sweep expirations only, evicting nothing. */
  readonly retention?: RetentionPolicy;
  readonly retentionIntervalMs?: number;
  readonly startupDelayMs?: number;
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Unix seconds, matching the store's clock. */
  readonly now?: () => Timestamp;
  readonly setTimer?: SetTimer;
  readonly clearTimer?: ClearTimer;
  readonly onError?: (error: unknown) => void;
}

/**
 * How long to wait before the next sweep, given the soonest deadline held.
 *
 * Pure, and clamped at both ends: the floor keeps a store full of just-expired
 * events from spinning, and the ceiling means a far-future deadline — or a laptop
 * that slept through one — still gets re-examined on a schedule instead of
 * sitting behind a timer set hours ago.
 */
export function sweepDelayMs(
  nextExpirationAt: Timestamp | undefined,
  now: Timestamp,
  bounds: { readonly minMs: number; readonly maxMs: number } = {
    minMs: MIN_SWEEP_DELAY_MS,
    maxMs: MAX_SWEEP_DELAY_MS,
  },
): number {
  if (nextExpirationAt === undefined) return bounds.maxMs;
  const seconds = nextExpirationAt - now;
  if (seconds <= 0) return bounds.minMs;
  return Math.min(Math.max(seconds * 1_000, bounds.minMs), bounds.maxMs);
}

/**
 * Starts the maintenance loop. Returns a stop function; call it when the account
 * scope the store belongs to goes away.
 */
export function startStoreMaintenance(
  options: StoreMaintenanceOptions,
): () => void {
  const { store, retention, onError } = options;
  const setTimer: SetTimer =
    options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: ClearTimer =
    options.clearTimer ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const bounds = {
    minMs: options.minDelayMs ?? MIN_SWEEP_DELAY_MS,
    maxMs: options.maxDelayMs ?? MAX_SWEEP_DELAY_MS,
  };
  const retentionIntervalMs =
    options.retentionIntervalMs ?? RETENTION_INTERVAL_MS;

  let stopped = false;
  let handle: TimerHandle;
  // Start-up counts as the last eviction, so a tab that is opened and closed
  // repeatedly does not pay for a bulk read on every open.
  let lastEvictionMs = Date.now();

  const tick = async (): Promise<void> => {
    try {
      await store.sweepExpired();
      if (
        retention !== undefined &&
        store.evictStale !== undefined &&
        Date.now() - lastEvictionMs >= retentionIntervalMs
      ) {
        lastEvictionMs = Date.now();
        await store.evictStale(retention);
      }
    } catch (error) {
      // A failed pass must not stop the loop: the usual cause is a store that has
      // just lost its backing, and the next pass will be answered by whatever
      // took over.
      onError?.(error);
    }
    if (stopped) return;
    let delay = bounds.maxMs;
    try {
      delay = sweepDelayMs(await store.nextExpirationAt(), now(), bounds);
    } catch (error) {
      onError?.(error);
    }
    if (stopped) return;
    handle = setTimer(() => void tick(), delay);
  };

  handle = setTimer(
    () => void tick(),
    options.startupDelayMs ?? STARTUP_DELAY_MS,
  );

  return () => {
    stopped = true;
    clearTimer(handle);
  };
}
