import { describe, expect, it } from "vitest";
import {
  MAX_QUOTE_DEPTH,
  nestedFrame,
  quoteRenderMode,
  ROOT_QUOTE_FRAME,
} from "./quoteDepth";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("quoteRenderMode", () => {
  it("expands a reference in a note's own body", () => {
    expect(quoteRenderMode(A, ROOT_QUOTE_FRAME)).toBe("card");
  });

  it("stops at the depth cap", () => {
    let frame = ROOT_QUOTE_FRAME;
    const ids = [A, B, C, "d".repeat(64), "e".repeat(64)];
    const modes = ids.map((id) => {
      const mode = quoteRenderMode(id, frame);
      frame = nestedFrame(id, frame);
      return mode;
    });
    // Exactly MAX_QUOTE_DEPTH cards, then references forever after — a chain of
    // distinct notes is legal and unbounded, so the cap is what terminates it.
    expect(modes.slice(0, MAX_QUOTE_DEPTH)).toEqual(
      Array(MAX_QUOTE_DEPTH).fill("card"),
    );
    expect(modes.slice(MAX_QUOTE_DEPTH)).toEqual(
      Array(ids.length - MAX_QUOTE_DEPTH).fill("reference"),
    );
  });

  it("refuses to render a note inside itself", () => {
    // A quotes B, B quotes A. Both events are real and signed; nothing on the
    // network prevents the pair, and the cycle is reachable before the depth cap.
    const inB = nestedFrame(B, ROOT_QUOTE_FRAME);
    expect(quoteRenderMode(B, inB)).toBe("reference");
  });

  it("stops a longer cycle at the id that closes it", () => {
    const inA = nestedFrame(A, ROOT_QUOTE_FRAME);
    expect(quoteRenderMode(B, inA)).toBe("card");
    const inB = nestedFrame(B, inA);
    expect(quoteRenderMode(A, inB)).toBe("reference");
  });

  it("keeps unrelated siblings expandable at the same depth", () => {
    // The ancestor set is the render *path*, not everything seen: two different
    // quotes side by side inside one card must both expand.
    const inA = nestedFrame(A, ROOT_QUOTE_FRAME);
    expect(quoteRenderMode(B, inA)).toBe("card");
    expect(quoteRenderMode(C, inA)).toBe("card");
  });
});

describe("nestedFrame", () => {
  it("records the path without mutating the frame it descends from", () => {
    const inA = nestedFrame(A, ROOT_QUOTE_FRAME);
    expect(ROOT_QUOTE_FRAME.ancestors).toEqual([]);
    expect(inA).toEqual({ depth: 1, ancestors: [A] });
    expect(nestedFrame(B, inA)).toEqual({ depth: 2, ancestors: [A, B] });
  });
});
