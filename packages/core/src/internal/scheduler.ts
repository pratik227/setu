/**
 * Tick schedulers.
 *
 * Every batching seam in this package (observer notification, verification,
 * network ingest) takes a {@link Scheduler} so that "once per tick" is a
 * parameter rather than a hard-coded `queueMicrotask`. Tests inject
 * {@link microtaskScheduler} for determinism; the app uses
 * {@link frameScheduler} so a large backfill collapses into one render per
 * frame instead of one per event.
 *
 * No DOM types are imported — `requestAnimationFrame` is probed off
 * `globalThis` so this file stays headless.
 */

/** Runs `fn` at the end of the current tick. Must never run `fn` inline. */
export type Scheduler = (fn: () => void) => void;

/** Flush at the end of the current microtask queue drain. */
export const microtaskScheduler: Scheduler = (fn) => {
  queueMicrotask(fn);
};

/** Flush on the next macrotask (`setTimeout(0)`). */
export const timeoutScheduler: Scheduler = (fn) => {
  setTimeout(fn, 0);
};

type RafLike = (cb: () => void) => unknown;

/**
 * Flush once per animation frame in a browser, or on the next macrotask
 * elsewhere. This is the right default for anything feeding the UI: a burst of
 * socket messages arriving as separate I/O callbacks still collapses into a
 * single flush.
 */
export const frameScheduler: Scheduler = (fn) => {
  const raf = (globalThis as { requestAnimationFrame?: RafLike })
    .requestAnimationFrame;
  if (typeof raf === "function") {
    raf(fn);
    return;
  }
  setTimeout(fn, 0);
};

/** The package-wide default: microtask, i.e. the cheapest correct batch. */
export const defaultScheduler: Scheduler = microtaskScheduler;
