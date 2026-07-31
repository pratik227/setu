/**
 * The scheduling policy, tested with an injected timer so nothing here sleeps.
 */

import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "../contracts";
import { microtaskScheduler } from "../internal/scheduler";
import { makeEvent } from "../testing/fixtures";
import {
  MAX_SWEEP_DELAY_MS,
  MIN_SWEEP_DELAY_MS,
  startStoreMaintenance,
  sweepDelayMs,
  type TimerHandle,
} from "./maintenance";
import { MemoryEventStore } from "./memoryStore";
import { defaultRetentionPolicy, type RetentionPolicy } from "./retention";

/** A timer the test drives by hand. */
function fakeTimer() {
  const pending: { fn: () => void; ms: number }[] = [];
  let cleared = 0;
  return {
    setTimer: (fn: () => void, ms: number): TimerHandle => {
      pending.push({ fn, ms });
      return pending.length;
    },
    clearTimer: (): void => {
      cleared += 1;
    },
    get cleared(): number {
      return cleared;
    },
    get delays(): readonly number[] {
      return pending.map((p) => p.ms);
    },
    /** Runs the most recently scheduled callback and lets its awaits settle. */
    async fire(): Promise<void> {
      const next = pending.pop();
      if (!next) throw new Error("nothing scheduled");
      next.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("sweepDelayMs", () => {
  const bounds = { minMs: 1_000, maxMs: 60_000 };

  it("sleeps the maximum when nothing expires", () => {
    // Still a re-check, not forever: a newly arrived deadline must not wait on a
    // timer scheduled when the store had none.
    expect(sweepDelayMs(undefined, 1_000, bounds)).toBe(60_000);
  });

  it("waits until the deadline when it is inside the window", () => {
    expect(sweepDelayMs(1_005, 1_000, bounds)).toBe(5_000);
  });

  it("clamps a due or past deadline to the floor rather than spinning", () => {
    expect(sweepDelayMs(1_000, 1_000, bounds)).toBe(1_000);
    expect(sweepDelayMs(500, 1_000, bounds)).toBe(1_000);
  });

  it("clamps a far-future deadline to the ceiling", () => {
    // A laptop that slept through a deadline must not be waiting on a timer set
    // hours ago.
    expect(sweepDelayMs(9_999_999, 1_000, bounds)).toBe(60_000);
  });

  it("defaults to the module's bounds", () => {
    expect(sweepDelayMs(undefined, 0)).toBe(MAX_SWEEP_DELAY_MS);
    expect(sweepDelayMs(1, 100)).toBe(MIN_SWEEP_DELAY_MS);
  });
});

describe("startStoreMaintenance", () => {
  it("sweeps expirations and reschedules against the next deadline", async () => {
    const clock = { now: 1_000 };
    const store = new MemoryEventStore({
      scheduler: microtaskScheduler,
      now: () => clock.now,
    });
    await store.put(
      makeEvent({ kind: 1, tags: [["expiration", "1100"]], created_at: 900 }),
    );
    await store.put(
      makeEvent({
        id: "b".repeat(64),
        kind: 1,
        tags: [["expiration", "1005"]],
        created_at: 900,
      }),
    );
    const timer = fakeTimer();
    const stop = startStoreMaintenance({
      store,
      startupDelayMs: 10,
      now: () => clock.now,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    expect(timer.delays).toEqual([10]);

    await timer.fire();
    // Nothing due yet, and the next pass lands on the soonest deadline.
    expect(await store.count({})).toBe(2);
    expect(timer.delays).toEqual([5_000]);

    clock.now = 1_006;
    await timer.fire();
    expect(await store.count({})).toBe(1);
    // The surviving deadline is 94s out, so the ceiling decides.
    expect(timer.delays).toEqual([MAX_SWEEP_DELAY_MS]);

    stop();
    expect(timer.cleared).toBe(1);
  });

  it("stops scheduling once stopped", async () => {
    const store = new MemoryEventStore({ scheduler: microtaskScheduler });
    const timer = fakeTimer();
    const stop = startStoreMaintenance({
      store,
      startupDelayMs: 10,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    stop();
    // A pass already in flight when the account scope goes away must not queue
    // another one against a store that is being closed.
    await timer.fire();
    expect(timer.delays).toEqual([]);
  });

  it("evicts on the retention interval, not on every pass", async () => {
    const evictStale = vi.fn(async (_policy: RetentionPolicy) => 0);
    const store = Object.assign(
      new MemoryEventStore({ scheduler: microtaskScheduler }),
      { evictStale },
    );
    const timer = fakeTimer();
    const stop = startStoreMaintenance({
      store,
      retention: defaultRetentionPolicy(),
      retentionIntervalMs: 0,
      startupDelayMs: 1,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    await timer.fire();
    expect(evictStale).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps looping after a failing pass", async () => {
    const store = new MemoryEventStore({ scheduler: microtaskScheduler });
    const broken: EventStore = Object.assign(store, {
      sweepExpired: () => Promise.reject(new Error("database closed")),
    });
    const onError = vi.fn();
    const timer = fakeTimer();
    const stop = startStoreMaintenance({
      store: broken,
      startupDelayMs: 1,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      onError,
    });
    await timer.fire();
    expect(onError).toHaveBeenCalledTimes(1);
    // The usual cause is a store that has just lost its backing; the next pass is
    // answered by whatever took over.
    expect(timer.delays.length).toBe(1);
    stop();
  });
});
