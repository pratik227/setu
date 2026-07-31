/**
 * Live-query registry shared by every {@link ../contracts.EventStore}
 * implementation.
 *
 * `EventStore.observe` is the app's event bus, which makes its performance
 * characteristics load-bearing: a 500-event backfill must not produce 500
 * callbacks. So writes never call observers directly. They mark the affected
 * observers dirty and a single flush per scheduler tick re-evaluates them once.
 *
 * Two mechanisms combine:
 *  - **Dirty marking** — an observer is only re-evaluated if one of the touched
 *    events matches its filter, so an unrelated write costs nothing.
 *  - **Batch suspension** — {@link ObserverRegistry.runBatch} holds flushes for
 *    the duration of a multi-event write. Without it, a store whose writes are
 *    genuinely async (Dexie) would flush between every `await` and defeat the
 *    tick batching entirely.
 */

import type { Filter, NostrEvent } from "@setu/protocol";
import type { StoredEvent, Unsubscribe } from "../contracts";
import type { MatchesFilterFn } from "../internal/filterMatch";
import { matchesFilter as defaultMatchesFilter } from "../internal/filterMatch";
import type { Scheduler } from "../internal/scheduler";
import { defaultScheduler } from "../internal/scheduler";

/** Construction options for {@link ObserverRegistry}. */
export interface ObserverRegistryOptions {
  /** Runs a one-shot query — supplied by the owning store. */
  readonly evaluate: (filter: Filter) => Promise<readonly StoredEvent[]>;
  /** Injected NIP-01 matcher; defaults to the local fallback. */
  readonly matchesFilter?: MatchesFilterFn;
  /** Tick source for the coalescing flush. Defaults to a microtask. */
  readonly scheduler?: Scheduler;
  /** A throwing observer callback must not break the others. */
  readonly onError?: (error: unknown) => void;
}

interface ObserverEntry {
  readonly filter: Filter;
  readonly onChange: (events: readonly StoredEvent[]) => void;
  dirty: boolean;
  closed: boolean;
}

/** Registry of active live queries, with coalesced re-evaluation. */
export class ObserverRegistry {
  private readonly entries = new Map<number, ObserverEntry>();
  private nextId = 1;
  private scheduled = false;
  private batchDepth = 0;
  private flushPending = false;
  private settled: Promise<void> = Promise.resolve();
  private readonly matches: MatchesFilterFn;
  private readonly scheduler: Scheduler;

  constructor(private readonly options: ObserverRegistryOptions) {
    this.matches = options.matchesFilter ?? defaultMatchesFilter;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  /** Number of live observers. */
  get activeCount(): number {
    return this.entries.size;
  }

  /**
   * Adds an observer and fires it once with the current matching set.
   *
   * The initial fire is a direct evaluation rather than a queued flush: a fresh
   * reader should not have to wait behind an unrelated batch.
   */
  register(
    filter: Filter,
    onChange: (events: readonly StoredEvent[]) => void,
  ): Unsubscribe {
    const id = this.nextId++;
    const entry: ObserverEntry = {
      filter,
      onChange,
      dirty: false,
      closed: false,
    };
    this.entries.set(id, entry);
    this.track(this.emit(entry));
    return () => {
      entry.closed = true;
      this.entries.delete(id);
    };
  }

  /**
   * Marks every observer whose filter matches one of the touched events dirty.
   *
   * `touched` must include removals (superseded replaceables, deleted events) as
   * well as insertions — the removed event's own shape is what tells us which
   * observers cared about it.
   */
  notify(touched: readonly NostrEvent[]): void {
    if (touched.length === 0 || this.entries.size === 0) return;
    for (const entry of this.entries.values()) {
      if (entry.dirty) continue;
      for (const event of touched) {
        if (this.matches(event, entry.filter)) {
          entry.dirty = true;
          break;
        }
      }
    }
    this.schedule();
  }

  /** Marks every observer dirty. Used by `clear()`, where nothing survives. */
  notifyAll(): void {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) entry.dirty = true;
    this.schedule();
  }

  /**
   * Suspends flushing for the duration of `fn`, then flushes once.
   *
   * Wrap every multi-event write in this. Nested calls are counted, so a
   * `putAll` that internally calls `put` still yields a single flush.
   */
  async runBatch<T>(fn: () => Promise<T> | T): Promise<T> {
    this.batchDepth += 1;
    try {
      return await fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.flushPending) {
        this.flushPending = false;
        this.schedule();
      }
    }
  }

  private schedule(): void {
    if (this.batchDepth > 0) {
      this.flushPending = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.scheduler(() => {
      this.scheduled = false;
      if (this.batchDepth > 0) {
        this.flushPending = true;
        return;
      }
      this.track(this.flush());
    });
  }

  private async flush(): Promise<void> {
    const dirty: ObserverEntry[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.dirty) continue;
      entry.dirty = false;
      dirty.push(entry);
    }
    for (const entry of dirty) {
      await this.emit(entry);
    }
  }

  private async emit(entry: ObserverEntry): Promise<void> {
    try {
      const events = await this.options.evaluate(entry.filter);
      if (entry.closed) return;
      entry.onChange(events);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private track(work: Promise<void>): void {
    this.settled = this.settled.then(() => work);
  }

  /**
   * Resolves once every scheduled and in-flight emission has completed.
   *
   * For tests and for `close()`-time draining; app code observes callbacks, not
   * this promise.
   */
  async settle(): Promise<void> {
    // Give any pending scheduler tick a chance to run before draining.
    await new Promise<void>((resolve) => this.scheduler(() => resolve()));
    await this.settled;
  }

  /** Drops every observer without firing them. */
  close(): void {
    for (const entry of this.entries.values()) entry.closed = true;
    this.entries.clear();
  }
}
