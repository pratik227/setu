import { describe, expect, it } from "vitest";
import { EMOJI_GROUPS, insertAt } from "./emoji";

describe("insertAt", () => {
  it("inserts at the caret rather than appending", () => {
    // The bug this locks: every emoji landing at position 0 or at the end,
    // because the caret was read after a modal had already taken focus.
    expect(insertAt("hello world", 5, 5, "!")).toEqual({
      value: "hello! world",
      caret: 6,
    });
  });

  it("replaces a selection", () => {
    expect(insertAt("hello world", 0, 5, "bye")).toEqual({
      value: "bye world",
      caret: 3,
    });
  });

  it("appends when the caret is at the end", () => {
    expect(insertAt("hi", 2, 2, "!")).toEqual({ value: "hi!", caret: 3 });
  });

  it("handles an empty field", () => {
    expect(insertAt("", 0, 0, "😀")).toEqual({ value: "😀", caret: 2 });
  });

  it("clamps a stale selection past the end instead of corrupting the text", () => {
    // A selection captured before a re-render can point past the new value.
    // Slicing with it unclamped silently produces the wrong string.
    expect(insertAt("abc", 99, 120, "X")).toEqual({ value: "abcX", caret: 4 });
  });

  it("clamps a reversed range", () => {
    expect(insertAt("abcdef", 4, 1, "-")).toEqual({
      value: "abcd-ef",
      caret: 5,
    });
  });

  it("clamps a negative start", () => {
    expect(insertAt("abc", -5, 1, "X")).toEqual({ value: "Xbc", caret: 1 });
  });
});

describe("EMOJI_GROUPS", () => {
  it("has no duplicate emoji within a group", () => {
    for (const group of EMOJI_GROUPS) {
      expect(new Set(group.emoji).size, `${group.name} repeats an emoji`).toBe(
        group.emoji.length,
      );
    }
  });

  it("uses each group name once, since the name is the React key", () => {
    const names = EMOJI_GROUPS.map((group) => group.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has no empty group", () => {
    for (const group of EMOJI_GROUPS) {
      expect(group.emoji.length, `${group.name} is empty`).toBeGreaterThan(0);
    }
  });
});
