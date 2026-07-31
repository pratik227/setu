import { describe, expect, it } from "vitest";
import { parseDim, parseImeta, parseImetaTag } from "./nip92";

describe("parseDim", () => {
  it("reads a well-formed dimension", () => {
    expect(parseDim("3024x4032")).toEqual({ width: 3024, height: 4032 });
    expect(parseDim("1x1")).toEqual({ width: 1, height: 1 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDim(" 800x600 ")).toEqual({ width: 800, height: 600 });
  });

  // `dim` is a stranger's string. Every one of these has to mean "reserve
  // nothing" rather than "reserve something absurd": a zero axis makes the aspect
  // ratio 0 or Infinity, and a value with no digits makes it NaN — all three land
  // in a `style` attribute and produce a box the reader cannot scroll past.
  it.each([
    "0x0",
    "0x100",
    "100x0",
    "abcxdef",
    "-1x2",
    "1x-2",
    "1.5x2",
    "1x",
    "x1",
    "1x2x3",
    "1 x 2",
    "1X2",
    "100000x1",
    "1x100000",
    "",
    "NaNxNaN",
    "1e3x1e3",
    "٣x٤",
  ])("rejects %o", (raw) => {
    expect(parseDim(raw)).toBeUndefined();
  });

  it("accepts the extremes it does allow, leaving the clamp to the renderer", () => {
    // Parsing says "this is a number pair"; deciding that 99999:1 is not a box
    // worth reserving is a layout question, answered where the box is built.
    expect(parseDim("99999x1")).toEqual({ width: 99999, height: 1 });
    expect(parseDim("1x99999")).toEqual({ width: 1, height: 99999 });
  });
});

describe("parseImetaTag", () => {
  it("decodes url, mime type, dimensions, alt and blurhash", () => {
    const entry = parseImetaTag([
      "imeta",
      "url https://media.example.com/a.webp",
      "m image/webp",
      "dim 1200x800",
      "alt a cat asleep on a keyboard",
      "blurhash LEHV6nWB2yk8pyo0adR*",
    ]);
    expect(entry).toEqual({
      url: "https://media.example.com/a.webp",
      mimeType: "image/webp",
      dim: { width: 1200, height: 800 },
      alt: "a cat asleep on a keyboard",
      blurhash: "LEHV6nWB2yk8pyo0adR*",
    });
  });

  it("keeps the spaces inside an alt description", () => {
    // Splitting on every space rather than the first one truncates the caption to
    // its first word, which is worse than having no caption at all.
    const entry = parseImetaTag([
      "imeta",
      "url https://x.test/a.png",
      "alt a b c",
    ]);
    expect(entry?.alt).toBe("a b c");
  });

  it("drops a row that names no url", () => {
    expect(parseImetaTag(["imeta", "dim 100x100"])).toBeUndefined();
    expect(parseImetaTag(["imeta"])).toBeUndefined();
    expect(parseImetaTag(["imeta", "url "])).toBeUndefined();
  });

  it("ignores elements that are not key/value pairs", () => {
    const entry = parseImetaTag([
      "imeta",
      "nonsense",
      " leadingspace",
      "url https://x.test/a.png",
    ]);
    expect(entry).toEqual({ url: "https://x.test/a.png" });
  });

  it("keeps the first value when a key repeats", () => {
    const entry = parseImetaTag([
      "imeta",
      "url https://x.test/first.png",
      "url https://x.test/second.png",
    ]);
    expect(entry?.url).toBe("https://x.test/first.png");
  });

  it("omits an unusable dimension rather than reporting a broken one", () => {
    const entry = parseImetaTag([
      "imeta",
      "url https://x.test/a.png",
      "dim 0x0",
    ]);
    expect(entry).toEqual({ url: "https://x.test/a.png" });
  });
});

describe("parseImeta", () => {
  it("returns every usable row, in tag order", () => {
    const entries = parseImeta({
      tags: [
        ["imeta", "url https://x.test/1.png", "dim 10x20"],
        ["p", "a".repeat(64)],
        ["imeta", "dim 30x40"],
        ["imeta", "url https://x.test/2.png"],
      ],
    });
    expect(entries.map((entry) => entry.url)).toEqual([
      "https://x.test/1.png",
      "https://x.test/2.png",
    ]);
    expect(entries[0]?.dim).toEqual({ width: 10, height: 20 });
  });

  it("is empty for an event with no imeta tags", () => {
    expect(parseImeta({ tags: [["t", "nostr"]] })).toEqual([]);
  });
});
