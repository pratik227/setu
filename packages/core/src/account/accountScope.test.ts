/**
 * The reset registry. Small mechanism, high consequence: a missed reset here is
 * one account's data rendered under another account's identity.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  clearResettables,
  listResettables,
  registerResettable,
  resetAccountScope,
} from "./accountScope";

afterEach(() => {
  clearResettables();
});

describe("accountScope", () => {
  it("runs every registered reset, in registration order", async () => {
    const order: string[] = [];
    registerResettable("store", () => {
      order.push("store");
    });
    registerResettable("pool", () => {
      order.push("pool");
    });
    registerResettable("feeds", async () => {
      order.push("feeds");
    });

    const report = await resetAccountScope();
    expect(order).toEqual(["store", "pool", "feeds"]);
    expect(report.reset).toEqual(["store", "pool", "feeds"]);
    expect(report.failures).toEqual([]);
  });

  it("keeps going when one reset throws, and reports it", async () => {
    const ran: string[] = [];
    registerResettable("first", () => {
      ran.push("first");
    });
    registerResettable("broken", () => {
      throw new Error("nope");
    });
    registerResettable("last", () => {
      ran.push("last");
    });

    const report = await resetAccountScope();
    // A half-reset scope is the bug; every other reset must still run.
    expect(ran).toEqual(["first", "last"]);
    expect(report.reset).toEqual(["first", "last"]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.name).toBe("broken");
  });

  it("propagates an async rejection as a failure, not a throw", async () => {
    registerResettable("async-broken", async () => {
      throw new Error("async nope");
    });
    const report = await resetAccountScope();
    expect(report.failures.map((f) => f.name)).toEqual(["async-broken"]);
  });

  it("replaces rather than duplicates a re-registered name", async () => {
    let stale = 0;
    let fresh = 0;
    registerResettable("pool", () => {
      stale += 1;
    });
    registerResettable("pool", () => {
      fresh += 1;
    });

    expect(listResettables()).toEqual(["pool"]);
    await resetAccountScope();
    // Hot reload re-runs module init; resetting the stale object would be wrong.
    expect(stale).toBe(0);
    expect(fresh).toBe(1);
  });

  it("keeps registrations across resets, since the singletons persist too", async () => {
    let count = 0;
    registerResettable("cache", () => {
      count += 1;
    });
    await resetAccountScope();
    await resetAccountScope();
    expect(count).toBe(2);
    expect(listResettables()).toEqual(["cache"]);
  });

  it("unregisters on demand, and a stale disposer cannot remove its successor", async () => {
    let first = 0;
    let second = 0;
    const disposeFirst = registerResettable("thing", () => {
      first += 1;
    });
    registerResettable("thing", () => {
      second += 1;
    });

    disposeFirst();
    await resetAccountScope();
    expect(first).toBe(0);
    expect(second).toBe(1);
    expect(listResettables()).toEqual(["thing"]);
  });

  it("removes an entry whose own disposer is called", async () => {
    const dispose = registerResettable("temporary", () => undefined);
    expect(listResettables()).toEqual(["temporary"]);
    dispose();
    expect(listResettables()).toEqual([]);
    expect((await resetAccountScope()).reset).toEqual([]);
  });

  it("rejects an empty name", () => {
    expect(() => registerResettable("", () => undefined)).toThrow();
  });
});
