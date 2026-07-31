import type { UnsignedEvent } from "@setu/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MiningProgress, PowMineRequest, PowWorkerMessage } from "./pow";

/**
 * The mining worker's lifetime, and the promise a publish waits on.
 *
 * One worker per attempt, terminated the moment the attempt ends. That looks
 * wasteful — worker startup is a few milliseconds — and it is the only way to make
 * cancellation real: a worker inside `mineEvent` cannot read a message until the
 * loop returns, so `terminate()` is the cancel, and a terminated worker cannot be
 * reused. Reusing one would also mean carrying its state between attempts, where a
 * late `progress` from the previous run can only ever be a lie.
 *
 * Every path settles the promise exactly once, including the ones that are not
 * supposed to happen: a worker that fails to load, one that never answers, and a
 * composer unmounted mid-mine. `publish` is awaiting this, so a path that resolves
 * nothing is a Post button that spins until the tab is closed.
 */

/** What the mine produced, before signing has had a chance to spoil it. */
export type PowAttempt =
  | { readonly outcome: "mined"; readonly event: UnsignedEvent }
  | { readonly outcome: "timeout" }
  | { readonly outcome: "skipped" }
  | { readonly outcome: "unavailable" };

export interface PowRunner {
  /** Present only while a worker is running. */
  readonly progress: MiningProgress | undefined;
  /** Never rejects: every way this can end is a described outcome. */
  mine(
    event: UnsignedEvent,
    plan: { readonly targetBits: number; readonly budgetMs: number },
  ): Promise<PowAttempt>;
  /** Give up now and publish without the work. Safe to call when idle. */
  skip(): void;
}

/**
 * Grace on top of the worker's own deadline before the main thread stops waiting.
 *
 * `mineEvent` enforces the budget itself, so this only fires when the worker is not
 * running at all — blocked by a CSP that forbids workers without raising an error,
 * or killed by the browser under memory pressure. Without it those cases hang the
 * publish forever.
 */
const WATCHDOG_GRACE_MS = 5000;

export function usePow(): PowRunner {
  const [progress, setProgress] = useState<MiningProgress | undefined>();
  const worker = useRef<Worker | undefined>(undefined);
  const settle = useRef<((attempt: PowAttempt) => void) | undefined>(undefined);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Tear down and answer, at most once per attempt. */
  const finish = useCallback((attempt: PowAttempt) => {
    if (watchdog.current !== undefined) clearTimeout(watchdog.current);
    watchdog.current = undefined;
    worker.current?.terminate();
    worker.current = undefined;
    setProgress(undefined);
    const resolve = settle.current;
    settle.current = undefined;
    resolve?.(attempt);
  }, []);

  const skip = useCallback(() => {
    if (settle.current) finish({ outcome: "skipped" });
  }, [finish]);

  // A composer closed mid-mine must not leave a thread burning CPU behind a screen
  // that no longer exists. Resolving as skipped rather than dropping the promise:
  // whatever was awaiting it still needs an answer.
  useEffect(() => {
    return () => {
      if (settle.current) finish({ outcome: "skipped" });
    };
  }, [finish]);

  const mine = useCallback(
    (
      event: UnsignedEvent,
      plan: { readonly targetBits: number; readonly budgetMs: number },
    ): Promise<PowAttempt> => {
      // A second attempt while one is in flight abandons the first. It cannot be
      // queued: the caller of the first is waiting on a note the user has already
      // moved on from.
      if (settle.current) finish({ outcome: "skipped" });

      let created: Worker;
      try {
        // `import.meta.url` rather than a string path: this is what lets Vite emit
        // the worker as its own module chunk, in dev and in a build.
        created = new Worker(new URL("./mine.worker.ts", import.meta.url), {
          type: "module",
        });
      } catch {
        // No `Worker` at all (a non-DOM test environment), or one the browser
        // refused to construct. Mining on the main thread instead would freeze the
        // tab, which is worse than publishing without the work and saying so.
        return Promise.resolve({ outcome: "unavailable" });
      }

      return new Promise<PowAttempt>((resolve) => {
        settle.current = resolve;
        worker.current = created;
        setProgress({
          targetBits: plan.targetBits,
          hashes: 0,
          elapsedMs: 0,
          budgetMs: plan.budgetMs,
        });

        created.onmessage = (message: MessageEvent<PowWorkerMessage>) => {
          const data = message.data;
          switch (data.type) {
            case "progress":
              setProgress({
                targetBits: plan.targetBits,
                hashes: data.hashes,
                elapsedMs: data.elapsedMs,
                budgetMs: plan.budgetMs,
              });
              return;
            case "mined":
              finish({ outcome: "mined", event: data.event });
              return;
            case "timeout":
              finish({ outcome: "timeout" });
              return;
          }
        };

        // A worker that cannot load its module (a bad chunk, a blocked import) fires
        // this instead of ever answering.
        created.onerror = () => finish({ outcome: "unavailable" });
        created.onmessageerror = () => finish({ outcome: "unavailable" });

        watchdog.current = setTimeout(
          () => finish({ outcome: "timeout" }),
          plan.budgetMs + WATCHDOG_GRACE_MS,
        );

        const request: PowMineRequest = {
          event,
          targetBits: plan.targetBits,
          budgetMs: plan.budgetMs,
        };
        created.postMessage(request);
      });
    },
    [finish],
  );

  return { progress, mine, skip };
}
