/**
 * The seam that decides whether a storage failure is a degraded session or a
 * broken app. Every case here is a failure mode a real browser produces:
 * IndexedDB missing entirely, and IndexedDB failing partway through a session
 * (quota, a deleted database, a closed connection).
 */

import type { Filter, NostrEvent } from "@setu/protocol";
import { describe, expect, it, vi } from "vitest";
import type { EventStore, StoredEvent } from "../contracts";
import { microtaskScheduler } from "../internal/scheduler";
import { makeEvent } from "../testing/fixtures";
import { FallbackEventStore } from "./fallbackStore";
import { MemoryEventStore } from "./memoryStore";

/** A store that starts working and can be made to fail on demand. */
class FlakyStore extends MemoryEventStore {
  broken = false;
  closed = false;

  override async put(event: NostrEvent, relay?: string): Promise<boolean> {
    this.fail();
    return super.put(event, relay);
  }

  override async query(filter: Filter): Promise<readonly StoredEvent[]> {
    this.fail();
    return super.query(filter);
  }

  override close(): void {
    this.closed = true;
    super.close();
  }

  private fail(): void {
    if (this.broken) throw new Error("QuotaExceededError");
  }
}

function fallbackOver(
  primary: EventStore,
  onFallback?: (error: unknown) => void,
): FallbackEventStore {
  return new FallbackEventStore({
    createPrimary: () => primary,
    createFallback: () =>
      new MemoryEventStore({ scheduler: microtaskScheduler }),
    ...(onFallback ? { onFallback } : {}),
  });
}

describe("FallbackEventStore", () => {
  it("uses the primary while it works", async () => {
    const primary = new FlakyStore({ scheduler: microtaskScheduler });
    const store = fallbackOver(primary);
    expect(await store.put(makeEvent({ id: "a".repeat(64) }))).toBe(true);
    expect(store.isDegraded).toBe(false);
    expect(primary.size).toBe(1);
    store.close();
  });

  it("degrades when the primary cannot be constructed at all", async () => {
    const onFallback = vi.fn();
    const store = new FallbackEventStore({
      createPrimary: () => {
        throw new Error("MissingAPIError: indexedDB");
      },
      createFallback: () =>
        new MemoryEventStore({ scheduler: microtaskScheduler }),
      onFallback,
    });
    expect(store.isDegraded).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
    // The app still works, which is the whole point.
    expect(await store.put(makeEvent({ id: "b".repeat(64) }))).toBe(true);
    expect(await store.count({})).toBe(1);
    store.close();
  });

  it("retries the failed write on the fallback instead of surfacing an error", async () => {
    const primary = new FlakyStore({ scheduler: microtaskScheduler });
    const onFallback = vi.fn();
    const store = fallbackOver(primary, onFallback);
    primary.broken = true;

    const event = makeEvent({ id: "c".repeat(64) });
    // The ingest path would otherwise drop this event on the floor.
    expect(await store.put(event)).toBe(true);
    expect(store.isDegraded).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(await store.get(event.id)).toBeDefined();
    store.close();
  });

  it("reports the failure once, however many operations fail after it", async () => {
    const primary = new FlakyStore({ scheduler: microtaskScheduler });
    const onFallback = vi.fn();
    const store = fallbackOver(primary, onFallback);
    primary.broken = true;
    await store.query({});
    await store.query({});
    await store.put(makeEvent({ id: "d".repeat(64) }));
    expect(onFallback).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("closes the failed primary so its handle is not left open", async () => {
    const primary = new FlakyStore({ scheduler: microtaskScheduler });
    const store = fallbackOver(primary);
    primary.broken = true;
    await store.query({});
    expect(primary.closed).toBe(true);
    store.close();
  });

  it("re-registers live observers against the fallback", async () => {
    const primary = new FlakyStore({ scheduler: microtaskScheduler });
    const store = fallbackOver(primary);
    const kept = makeEvent({ id: "e".repeat(64) });
    await store.put(kept);

    const seen: number[] = [];
    store.observe({ kinds: [1] }, (events) => seen.push(events.length));
    await primary.settle();
    expect(seen).toEqual([1]);

    primary.broken = true;
    await store.query({ kinds: [1] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Told the row is gone, rather than left rendering an event no read can
    // return any more.
    expect(seen).toEqual([1, 0]);

    // And still live: a write after the switch reaches the same callback.
    await store.put(makeEvent({ id: "f".repeat(64) }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.at(-1)).toBe(1);
    store.close();
  });

  it("unsubscribing after a degrade detaches from the fallback too", async () => {
    const primary = new FlakyStore({ scheduler: microtaskScheduler });
    const store = fallbackOver(primary);
    const seen: number[] = [];
    const stop = store.observe({ kinds: [1] }, (e) => seen.push(e.length));
    primary.broken = true;
    await store.query({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = seen.length;
    stop();
    await store.put(makeEvent({ id: "1".repeat(64) }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.length).toBe(before);
    store.close();
  });

  it("does not hide a failure in the fallback itself", async () => {
    const primary = new FlakyStore({ scheduler: microtaskScheduler });
    const broken = new FlakyStore({ scheduler: microtaskScheduler });
    broken.broken = true;
    const store = new FallbackEventStore({
      createPrimary: () => primary,
      createFallback: () => broken,
    });
    primary.broken = true;
    // An in-memory store that throws is a bug in this package, not a storage
    // condition, so it must not be swallowed.
    await expect(store.put(makeEvent({ id: "2".repeat(64) }))).rejects.toThrow(
      "QuotaExceededError",
    );
    store.close();
  });

  it("reports zero evicted when the active store cannot evict", async () => {
    const store = fallbackOver(new MemoryEventStore({}));
    expect(
      await store.evictStale({
        maxAgeSeconds: 1,
        keepAuthors: [],
        evictableKinds: [1],
        maxPerSweep: 10,
      }),
    ).toBe(0);
    store.close();
  });
});
