/**
 * Verification: always on, batched, and cached.
 */

import { describe, expect, it, vi } from "vitest";
import { microtaskScheduler } from "../internal/scheduler";
import { hex, makeEvent } from "../testing/fixtures";
import { BatchingEventVerifier, NoopVerifier } from "./verifier";

function verifier(
  verifySignature: (event: ReturnType<typeof makeEvent>) => boolean,
  chunkSize = 32,
) {
  return new BatchingEventVerifier({
    verifySignature,
    scheduler: microtaskScheduler,
    chunkSize,
  });
}

describe("BatchingEventVerifier", () => {
  it("accepts good signatures and rejects bad ones, counting both", async () => {
    const bad = makeEvent({ id: hex("bad") });
    const subject = verifier((event) => event.id !== bad.id);
    const good = makeEvent({ id: hex("good") });

    expect(await subject.verify(good)).toBe(true);
    expect(await subject.verify(bad)).toBe(false);
    expect(subject.stats()).toMatchObject({ verified: 1, badSignature: 1 });
  });

  it("does not run the signature check on structurally invalid events", async () => {
    const check = vi.fn(() => true);
    const subject = verifier(check);
    const malformed = { ...makeEvent(), sig: "short" } as never;
    expect(await subject.verify(malformed)).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(subject.stats().invalidShape).toBe(1);
  });

  it("batches concurrent verifications into one drain", async () => {
    let calls = 0;
    const subject = verifier(() => {
      calls += 1;
      return true;
    });
    const events = Array.from({ length: 40 }, (_, i) =>
      makeEvent({ id: hex(`b-${i}`) }),
    );
    const pending = events.map((event) => subject.verify(event));
    // Everything is queued synchronously; nothing has been verified yet.
    expect(subject.queueDepth).toBe(40);
    expect(calls).toBe(0);

    expect(await Promise.all(pending)).toEqual(new Array(40).fill(true));
    expect(calls).toBe(40);
    expect(subject.queueDepth).toBe(0);
  });

  it("chunks a large batch and still resolves every caller", async () => {
    const subject = verifier(() => true, 3);
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ id: hex(`c-${i}`) }),
    );
    const results = await Promise.all(
      events.map((event) => subject.verify(event)),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  it("verifies the same event only once, however many relays send it", async () => {
    const check = vi.fn(() => true);
    const subject = verifier(check);
    const event = makeEvent({ id: hex("dup") });
    expect(await subject.verify(event)).toBe(true);
    expect(await subject.verify(event)).toBe(true);
    expect(await subject.verify(event)).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing signature check as a rejection", async () => {
    const subject = verifier(() => {
      throw new Error("curve exploded");
    });
    expect(await subject.verify(makeEvent({ id: hex("boom") }))).toBe(false);
    expect(subject.stats().errored).toBe(1);
  });

  it("verifyAll returns only the survivors, in input order", async () => {
    const bad = makeEvent({ id: hex("va-bad") });
    const subject = verifier((event) => event.id !== bad.id);
    const first = makeEvent({ id: hex("va-1") });
    const second = makeEvent({ id: hex("va-2") });
    const survivors = await subject.verifyAll([first, bad, second]);
    expect(survivors.map((e) => e.id)).toEqual([first.id, second.id]);
    expect(await subject.verifyAll([])).toEqual([]);
  });

  it("flush() drains without waiting for the tick", async () => {
    let calls = 0;
    const subject = verifier(() => {
      calls += 1;
      return true;
    });
    void subject.verify(makeEvent({ id: hex("flush") }));
    await subject.flush();
    expect(calls).toBe(1);
  });
});

describe("NoopVerifier", () => {
  it("accepts everything — which is why it must never ship in app code", async () => {
    const subject = new NoopVerifier();
    const events = [makeEvent({ id: hex("noop-1") })];
    expect(await subject.verify()).toBe(true);
    expect(await subject.verifyAll(events)).toEqual(events);
  });
});
