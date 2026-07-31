/**
 * Event signature verification.
 *
 * Two non-negotiables shape this file:
 *
 *  1. **Verification is always on.** There is no "trust this relay" flag and no
 *     sampling. A client that renders unverified events is a client that can be
 *     made to attribute arbitrary content to any pubkey.
 *  2. **Verification is off the receive path.** Schnorr verification is ~50–100µs;
 *     a 500-event backfill verified inline is a visible stall. So `verify` queues
 *     and the queue drains once per tick, in bounded chunks with a yield between
 *     them, so the event loop keeps breathing.
 *
 * The actual cryptography is injected. This package must not depend on a curve
 * implementation — that lives in `@setu/protocol`.
 */

import type { Hex32, NostrEvent } from "@setu/protocol";
import type { EventVerifier } from "../contracts";
import type { IsValidEventShapeFn } from "../internal/filterMatch";
import { isValidEventShape as defaultIsValidEventShape } from "../internal/filterMatch";
import type { Scheduler } from "../internal/scheduler";
import { defaultScheduler } from "../internal/scheduler";

/** The injected signature check. May be sync or async. */
export type VerifySignatureFn = (
  event: NostrEvent,
) => boolean | Promise<boolean>;

/** Counters for a debug/health UI. */
export interface VerifierStats {
  /** Events that passed shape and signature checks. */
  readonly verified: number;
  /** Events rejected for a bad shape. */
  readonly invalidShape: number;
  /** Events rejected for a bad signature. */
  readonly badSignature: number;
  /** Events rejected because the verifier itself threw. */
  readonly errored: number;
}

/** Construction options for {@link BatchingEventVerifier}. */
export interface BatchingEventVerifierOptions {
  /** The real Schnorr check, e.g. `@setu/protocol`'s `verifyEventSignature`. */
  readonly verifySignature: VerifySignatureFn;
  /** Injected structural validator, run before the expensive check. */
  readonly isValidEventShape?: IsValidEventShapeFn;
  /** Tick source for the queue drain. */
  readonly scheduler?: Scheduler;
  /** Events verified per chunk before yielding to the event loop. Default 32. */
  readonly chunkSize?: number;
  /**
   * How many `(id, sig)` results to remember, so the same event arriving from
   * five relays is verified once. Default 4096; 0 disables caching.
   */
  readonly cacheSize?: number;
}

interface QueueEntry {
  readonly event: NostrEvent;
  readonly resolve: (ok: boolean) => void;
}

/**
 * The default verifier: correct, always-on, and batched off the receive path.
 *
 * This is the implementation app code should use. See {@link NoopVerifier} for
 * the test-only alternative.
 */
export class BatchingEventVerifier implements EventVerifier {
  private queue: QueueEntry[] = [];
  private scheduled = false;
  private draining: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, boolean>();
  private counts = {
    verified: 0,
    invalidShape: 0,
    badSignature: 0,
    errored: 0,
  };
  private readonly isValidShape: IsValidEventShapeFn;
  private readonly scheduler: Scheduler;
  private readonly chunkSize: number;
  private readonly cacheSize: number;

  constructor(private readonly options: BatchingEventVerifierOptions) {
    this.isValidShape = options.isValidEventShape ?? defaultIsValidEventShape;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.chunkSize = Math.max(1, options.chunkSize ?? 32);
    this.cacheSize = options.cacheSize ?? 4_096;
  }

  /** Cumulative counters. Safe to poll for a debug overlay. */
  stats(): VerifierStats {
    return { ...this.counts };
  }

  /** Number of events waiting for the next drain. */
  get queueDepth(): number {
    return this.queue.length;
  }

  async verify(event: NostrEvent): Promise<boolean> {
    if (!this.isValidShape(event)) {
      this.counts.invalidShape += 1;
      return false;
    }
    const cached = this.cache.get(cacheKey(event));
    if (cached !== undefined) return cached;
    return new Promise<boolean>((resolve) => {
      this.queue.push({ event, resolve });
      this.schedule();
    });
  }

  /**
   * Verifies a batch and returns only the events that passed, in input order.
   *
   * This is the shape the ingest path wants: hand it everything a relay sent,
   * store what survives.
   */
  async verifyAll(
    events: readonly NostrEvent[],
  ): Promise<readonly NostrEvent[]> {
    if (events.length === 0) return [];
    const results = await Promise.all(
      events.map(async (event) => ({ event, ok: await this.verify(event) })),
    );
    return results.filter((r) => r.ok).map((r) => r.event);
  }

  /** Drains the queue now and resolves when it is empty. */
  async flush(): Promise<void> {
    this.drain();
    await this.draining;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.scheduler(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.draining = this.draining.then(() => this.process(batch));
  }

  private async process(batch: readonly QueueEntry[]): Promise<void> {
    for (let start = 0; start < batch.length; start += this.chunkSize) {
      const chunk = batch.slice(start, start + this.chunkSize);
      await Promise.all(chunk.map((entry) => this.verifyOne(entry)));
      // Yield between chunks so a large backfill cannot monopolise the loop.
      if (start + this.chunkSize < batch.length) {
        await new Promise<void>((resolve) => this.scheduler(() => resolve()));
      }
    }
  }

  private async verifyOne(entry: QueueEntry): Promise<void> {
    const key = cacheKey(entry.event);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      entry.resolve(cached);
      return;
    }
    let ok: boolean;
    try {
      ok = (await this.options.verifySignature(entry.event)) === true;
    } catch {
      this.counts.errored += 1;
      entry.resolve(false);
      return;
    }
    if (ok) this.counts.verified += 1;
    else this.counts.badSignature += 1;
    this.remember(key, ok);
    entry.resolve(ok);
  }

  private remember(key: string, ok: boolean): void {
    if (this.cacheSize === 0) return;
    if (this.cache.size >= this.cacheSize) {
      // Cheap FIFO eviction; a verification cache does not need true LRU.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, ok);
  }
}

function cacheKey(event: NostrEvent): string {
  return `${event.id}:${event.sig}`;
}

/**
 * A verifier that accepts everything.
 *
 * **This must never be used in app code.** It exists so tests can exercise the
 * store, pool, feed and subscription layers without a curve implementation. Any
 * production wiring that reaches for this is a security bug: it makes every
 * rendered event forgeable by any relay in the path.
 */
export class NoopVerifier implements EventVerifier {
  async verify(): Promise<boolean> {
    return true;
  }

  async verifyAll(
    events: readonly NostrEvent[],
  ): Promise<readonly NostrEvent[]> {
    return events;
  }
}

/**
 * The default construction path for a verifier.
 *
 * Deliberately the only convenient factory: getting a working verifier requires
 * supplying a real signature function, so "verification off" is never the easy
 * option.
 */
export function createEventVerifier(
  options: BatchingEventVerifierOptions,
): BatchingEventVerifier {
  return new BatchingEventVerifier(options);
}

/** Type-only re-export so callers can annotate ids without importing protocol. */
export type VerifiedEventId = Hex32;
