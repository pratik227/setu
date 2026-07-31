import { mineEvent } from "@setu/protocol";
import {
  HASHES_PER_CLOCK_READ,
  type PowMineRequest,
  type PowWorkerMessage,
  PROGRESS_INTERVAL_MS,
} from "./pow";

/**
 * NIP-13 mining, off the main thread.
 *
 * `mineEvent` is a tight loop that yields to nothing: at difficulty 20 it is around
 * a million hashes, which on the main thread means the composer stops accepting
 * keystrokes, and at 24 the tab stops painting altogether. A worker is not an
 * optimisation here, it is the difference between a progress line and a hang.
 *
 * ## Progress comes out through the injected clock
 *
 * Nothing inside the loop can await, and no `setInterval` in this worker can fire
 * while it runs — the thread is busy. But `mineEvent` takes a `now` function and
 * calls it every {@link HASHES_PER_CLOCK_READ} hashes, and `postMessage` is a send,
 * not a wait, so it works from inside. That hook is the only channel out of a
 * running mine, and it is why progress reporting needs no changes in `nip13.ts`.
 *
 * The hash count derived from it is an estimate: it counts clock reads, so it is
 * exact only while `mineEvent` checks its deadline at the interval this file
 * assumes. A drifted constant makes the displayed number wrong, never the mining —
 * the real count comes back with the result.
 *
 * ## Cancellation is termination
 *
 * There is no cooperative cancel and there cannot be: an incoming message cannot be
 * delivered until the loop returns, so a "stop" message would arrive exactly when it
 * is no longer needed. The main thread calls `worker.terminate()` instead, which is
 * immediate and gives the CPU back at once. That is why the hook owns the worker's
 * lifetime and creates a fresh one per attempt.
 */

/**
 * The worker globals, typed locally.
 *
 * `tsconfig` loads the DOM lib for the app, so `self` here is typed as a window.
 * Casting the few members this file uses is smaller and safer than switching libs
 * for one file, and it keeps the contract with the hook visible in one place.
 */
const scope = globalThis as unknown as {
  postMessage(message: PowWorkerMessage): void;
  addEventListener(
    type: "message",
    listener: (event: { data: PowMineRequest }) => void,
  ): void;
};

scope.addEventListener("message", (message) => {
  const { event, targetBits, budgetMs } = message.data;

  const started = performance.now();
  let reads = 0;
  let reportedAt = started;

  /**
   * The deadline clock, doubling as the progress tick.
   *
   * Must keep returning real elapsed time: `mineEvent` computes its deadline from
   * this, so a doctored value here would either abandon mining immediately or never
   * time out at all.
   */
  const now = (): number => {
    const at = performance.now();
    reads += 1;
    if (at - reportedAt >= PROGRESS_INTERVAL_MS) {
      reportedAt = at;
      scope.postMessage({
        type: "progress",
        // The first read happens before any hashing, when the deadline is computed.
        hashes: Math.max(0, reads - 1) * HASHES_PER_CLOCK_READ,
        elapsedMs: at - started,
      });
    }
    return at;
  };

  const result = mineEvent(event, { targetBits, timeoutMs: budgetMs, now });

  scope.postMessage(
    result
      ? {
          type: "mined",
          event: result.event,
          difficulty: result.difficulty,
          hashes: result.hashes,
        }
      : { type: "timeout" },
  );
});
