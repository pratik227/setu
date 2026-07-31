import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../contracts";
import {
  classesForKinds,
  contentClassOf,
  orderByDelivery,
  SCORED_KINDS,
  scorecardQueries,
  scoreRows,
} from "./relayScorecard";
import { createRelayScorecardSource } from "./relayScorecardSource";

const A = "wss://a.example";
const B = "wss://b.example";
const C = "wss://c.example";

let counter = 0;
function row(kind: number, relays: readonly string[]): StoredEvent {
  counter += 1;
  return {
    event: {
      id: String(counter).padStart(64, "0"),
      pubkey: "a".repeat(64),
      created_at: 1_700_000_000 + counter,
      kind,
      tags: [],
      content: "",
      sig: "0".repeat(128),
    },
    provenance: { relays: [...relays], firstSeen: 1_700_000_000 },
  } as StoredEvent;
}

describe("contentClassOf / classesForKinds", () => {
  it("maps the kinds that are scored and refuses the rest", () => {
    expect(contentClassOf(0)).toBe("profiles");
    expect(contentClassOf(30023)).toBe("longform");
    expect(contentClassOf(1059)).toBe("privateWraps");
    // Unlisted kinds are not guessed at — a wrong class silently biases routing.
    expect(contentClassOf(30078)).toBeUndefined();
  });

  it("treats no kinds, and only-unscored kinds, as a general question", () => {
    // Ranking a kind-less route by any single class would bias it for no reason.
    expect(classesForKinds(undefined).size).toBeGreaterThan(3);
    expect(classesForKinds([]).size).toBeGreaterThan(3);
    expect(classesForKinds([30078]).size).toBeGreaterThan(3);
    expect([...classesForKinds([0])]).toEqual(["profiles"]);
  });
});

describe("scoreRows", () => {
  it("counts a row once per delivering relay", () => {
    const scores = scoreRows([row(0, [A, B]), row(0, [A])]);
    expect(scores.get(A)?.byClass.get("profiles")).toBe(2);
    expect(scores.get(B)?.byClass.get("profiles")).toBe(1);
  });

  it("counts exclusives — what removing the relay would have cost", () => {
    // Total delivery overstates value: four relays carrying the same notes are
    // interchangeable. Exclusive is the honest removal-cost figure.
    const scores = scoreRows([row(1, [A, B]), row(1, [A]), row(1, [A])]);
    expect(scores.get(A)?.total).toBe(3);
    expect(scores.get(A)?.exclusive).toBe(2);
    expect(scores.get(B)?.exclusive).toBe(0);
  });

  it("merges URL spellings, so a score cannot split across a trailing slash", () => {
    const scores = scoreRows([
      row(0, ["wss://a.example/"]),
      row(0, ["wss://A.EXAMPLE"]),
    ]);
    expect(scores.size).toBe(1);
    expect([...scores.values()][0]?.total).toBe(2);
  });

  it("does not double-count a row whose provenance repeats a relay", () => {
    const scores = scoreRows([row(0, [A, "wss://a.example/"])]);
    expect(scores.get(A)?.total).toBe(1);
    // And a same-relay duplicate still counts as exclusive: one relay delivered it.
    expect(scores.get(A)?.exclusive).toBe(1);
  });

  it("ignores unscored kinds", () => {
    expect(scoreRows([row(30078, [A])]).size).toBe(0);
  });
});

describe("orderByDelivery", () => {
  const scorecard = scoreRows([
    // C is the profile specialist; A carries notes; B has delivered nothing.
    row(0, [C]),
    row(0, [C]),
    row(0, [A]),
    row(1, [A]),
    row(1, [A]),
  ]);

  it("puts the measured deliverers of the asked-for kinds first", () => {
    // The case the module exists for: the profile specialist is LAST in the
    // configured order, and the fallback cap would otherwise never reach it.
    expect(orderByDelivery([A, B, C], scorecard, [0])).toEqual([C, A, B]);
  });

  it("ranks differently for different kinds", () => {
    expect(orderByDelivery([A, B, C], scorecard, [1])).toEqual([A, B, C]);
  });

  it("never drops a relay", () => {
    // A zero is not evidence of uselessness: the relay may be new, or the store
    // empty. Ordering may only reorder.
    for (const kinds of [[0], [1], [30023], undefined] as const) {
      const ordered = orderByDelivery([A, B, C], scorecard, kinds as never);
      expect([...ordered].sort()).toEqual([A, B, C].sort());
    }
  });

  it("keeps configured order among the unmeasured, and on ties", () => {
    expect(orderByDelivery([B, A], scoreRows([]), [0])).toEqual([B, A]);
    const tied = scoreRows([row(0, [A]), row(0, [B])]);
    expect(orderByDelivery([B, A], tied, [0])).toEqual([B, A]);
  });

  it("returns the input untouched with no scorecard — the bootstrap case", () => {
    const urls = [A, B, C];
    expect(orderByDelivery(urls, undefined, [0])).toBe(urls);
  });
});

describe("createRelayScorecardSource", () => {
  /** A store stub answering `query` from a fixed row set. */
  function storeOf(rows: readonly StoredEvent[], onQuery?: () => void) {
    return {
      query: async (filter: { kinds?: readonly number[] }) => {
        onQuery?.();
        return rows.filter((r) => filter.kinds?.includes(r.event.kind));
      },
    } as never;
  }

  it("returns configured order before the first scan lands, then reorders", async () => {
    const source = createRelayScorecardSource({
      store: storeOf([row(0, [C]), row(0, [C])]),
    });
    // First call: nothing scanned yet — input order, refresh kicked.
    expect(source.order([A, C], [0])).toEqual([A, C]);
    await source.refresh();
    expect(source.order([A, C], [0])).toEqual([C, A]);
  });

  it("coalesces concurrent refreshes and honours the TTL", async () => {
    let queries = 0;
    let clock = 0;
    const source = createRelayScorecardSource({
      store: storeOf([row(0, [C])], () => {
        queries += 1;
      }),
      ttlMs: 1000,
      now: () => clock,
    });
    await Promise.all([source.refresh(), source.refresh()]);
    const afterFirst = queries;
    // Fresh: ordering must not trigger another scan.
    source.order([A, C], [0]);
    expect(queries).toBe(afterFirst);
    // Stale: the next order re-kicks exactly one scan.
    clock = 2000;
    source.order([A, C], [0]);
    await source.refresh();
    expect(queries).toBeGreaterThan(afterFirst);
  });

  it("degrades to configured order when the store throws", async () => {
    const errors: unknown[] = [];
    const source = createRelayScorecardSource({
      store: {
        query: async () => {
          throw new Error("closing");
        },
      } as never,
      onError: (e) => errors.push(e),
    });
    await source.refresh();
    // The failure is reported, and routing is unharmed.
    expect(errors.length).toBeGreaterThan(0);
    expect(source.order([A, B], [0])).toEqual([A, B]);
    expect(source.current()).toBeUndefined();
  });

  it("samples per class, so notes cannot crowd profiles out", () => {
    // The flaw a single newest-N query would have: the store is dominated by
    // kind-1, and one shared cap would sample almost no profiles at all.
    const queries = scorecardQueries();
    const profileQuery = queries.find((q) => q.kinds.includes(0));
    const noteQuery = queries.find((q) => q.kinds.includes(1));
    expect(profileQuery).toBeDefined();
    expect(noteQuery).toBeDefined();
    expect(profileQuery).not.toBe(noteQuery);
    // And together the queries cover every scored kind.
    const covered = new Set(queries.flatMap((q) => [...q.kinds]));
    for (const kind of SCORED_KINDS) expect(covered.has(kind)).toBe(true);
  });
});
