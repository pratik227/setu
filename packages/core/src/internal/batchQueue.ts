/**
 * A push-in / flush-per-tick queue.
 *
 * The single shared mechanism behind "batch it off the receive path": callers
 * push individual items synchronously and the drain callback is invoked at most
 * once per scheduler tick with everything that accumulated. Used by the event
 * verifier and by the subscription manager's ingest path.
 */

import type { Scheduler } from "./scheduler";
import { defaultScheduler } from "./scheduler";

/** Options for {@link BatchQueue}. */
export interface BatchQueueOptions<T> {
  /** Invoked once per tick with everything queued since the last flush. */
  readonly onFlush: (items: readonly T[]) => void | Promise<void>;
  /** Tick source. Defaults to a microtask. */
  readonly scheduler?: Scheduler;
  /**
   * Flush immediately, without waiting for the tick, once this many items are
   * queued. Bounds memory under a sustained firehose. 0 disables.
   */
  readonly maxQueued?: number;
  /** Reports errors thrown by `onFlush`; a throwing drain must not stop the queue. */
  readonly onError?: (error: unknown) => void;
}

/** Accumulates items and drains them once per tick. */
export class BatchQueue<T> {
  private queue: T[] = [];
  private scheduled = false;
  private draining: Promise<void> = Promise.resolve();
  private readonly scheduler: Scheduler;

  constructor(private readonly options: BatchQueueOptions<T>) {
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  /** Number of items waiting for the next flush. */
  get size(): number {
    return this.queue.length;
  }

  /** Queue one item, scheduling a flush if none is pending. */
  push(item: T): void {
    this.queue.push(item);
    this.schedule();
  }

  /** Queue many items with a single scheduling decision. */
  pushAll(items: readonly T[]): void {
    if (items.length === 0) return;
    this.queue.push(...items);
    this.schedule();
  }

  private schedule(): void {
    const max = this.options.maxQueued ?? 0;
    if (max > 0 && this.queue.length >= max) {
      this.flushNow();
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.scheduler(() => {
      this.scheduled = false;
      this.flushNow();
    });
  }

  private flushNow(): void {
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    // Chain drains so two flushes never interleave — ordering matters for
    // last-write-wins semantics downstream.
    this.draining = this.draining.then(async () => {
      try {
        await this.options.onFlush(items);
      } catch (error) {
        this.options.onError?.(error);
      }
    });
  }

  /**
   * Drain synchronously-queued items now and resolve once every in-flight drain
   * (including this one) has settled.
   */
  async flush(): Promise<void> {
    this.flushNow();
    await this.draining;
  }

  /** Discard queued items without draining them. */
  clear(): void {
    this.queue = [];
  }
}
