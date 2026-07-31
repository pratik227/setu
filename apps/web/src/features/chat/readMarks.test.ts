import { describe, expect, it } from "vitest";
import { loadReadMarks, readMarksKey, saveReadMarks } from "./readMarks";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

/** Minimal in-memory Storage, so the tests do not depend on a DOM. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("read mark persistence", () => {
  it("round-trips marks so they survive a reload", () => {
    // The bug this locks: marks lived in React state only, so every conversation
    // reappeared unread on every visit — not just after a reload, but after
    // navigating away and back, since the hook was re-created empty.
    const storage = memoryStorage();
    saveReadMarks(ALICE, new Map([["conv-1", 100]]), storage);
    expect(loadReadMarks(ALICE, storage)).toEqual(new Map([["conv-1", 100]]));
  });

  it("keeps accounts apart", () => {
    // Switching accounts must never mark a stranger's conversations read.
    const storage = memoryStorage();
    saveReadMarks(ALICE, new Map([["conv-1", 100]]), storage);
    expect(loadReadMarks(BOB, storage).size).toBe(0);
    expect(readMarksKey(ALICE)).not.toBe(readMarksKey(BOB));
  });

  it("reads as empty for an account with nothing stored", () => {
    expect(loadReadMarks(ALICE, memoryStorage()).size).toBe(0);
  });

  it("reads as empty with no account", () => {
    const storage = memoryStorage({ [readMarksKey(ALICE)]: '{"c":1}' });
    expect(loadReadMarks(undefined, storage).size).toBe(0);
  });

  it("survives corrupt storage rather than throwing", () => {
    for (const raw of ["not json", "[]", "null", '"a string"', "42"]) {
      const storage = memoryStorage({ [readMarksKey(ALICE)]: raw });
      expect(loadReadMarks(ALICE, storage)).toEqual(new Map());
    }
  });

  it("drops non-numeric values instead of coercing them", () => {
    // A coerced value becomes NaN, and `NaN > 0` is false — which would mark the
    // conversation permanently unread, the exact bug being fixed.
    const storage = memoryStorage({
      [readMarksKey(ALICE)]: JSON.stringify({
        good: 10,
        bad: "20",
        alsoBad: null,
        infinite: Number.POSITIVE_INFINITY,
      }),
    });
    expect(loadReadMarks(ALICE, storage)).toEqual(new Map([["good", 10]]));
  });

  it("does not throw when storage refuses to write", () => {
    const failing = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as Storage;
    expect(() =>
      saveReadMarks(ALICE, new Map([["c", 1]]), failing),
    ).not.toThrow();
  });

  it("does nothing when there is no storage at all", () => {
    expect(() =>
      saveReadMarks(ALICE, new Map([["c", 1]]), undefined),
    ).not.toThrow();
    expect(loadReadMarks(ALICE, undefined)).toEqual(new Map());
  });
});
