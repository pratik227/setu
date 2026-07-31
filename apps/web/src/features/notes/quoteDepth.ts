/**
 * How deep a chain of quoted notes may render, and why it always terminates.
 *
 * A quote card renders a note whose content may itself quote a note, so the
 * renderer is recursive over data an author controls. "A quotes B, B quotes A" is
 * not a hypothetical — nothing about a signed event stops anyone publishing it,
 * and two events can be published minutes apart with no coordination at all. A
 * renderer that follows references until it runs out of them recurses until the
 * tab dies.
 *
 * Two independent guards, for the same reason `threadTree.ts` has two:
 *
 *  1. **A depth cap.** At most {@link MAX_QUOTE_DEPTH} nested cards, so a chain of
 *     distinct notes — legal, and unbounded — stops as well. This alone is what
 *     guarantees termination.
 *  2. **An ancestor set.** A reference back to a note already on the render path
 *     stops immediately rather than at the cap, because rendering a note inside
 *     itself is confusing even when it is cheap.
 *
 * Past either guard the reference is still shown, as a reference. Silently
 * dropping it would delete the fact that the author quoted something.
 */

import { createContext, useContext } from "react";

/**
 * Nested quote cards a note may render.
 *
 * Two: a quote, and the quote that quote makes. A third is a card inside a card
 * inside a card inside a feed row, which is roughly 24 pixels of usable text
 * column, and no reader has ever needed it.
 */
export const MAX_QUOTE_DEPTH = 2;

/** Where in the quote chain the content currently being rendered sits. */
export interface QuoteFrame {
  /** 0 for a note's own body, 1 inside its first quote card, and so on. */
  readonly depth: number;
  /** Quoted ids already on the render path, outermost first. */
  readonly ancestors: readonly string[];
}

/** A note's own body: nothing above it, nothing quoted yet. */
export const ROOT_QUOTE_FRAME: QuoteFrame = { depth: 0, ancestors: [] };

/**
 * How a `nostr:note…`/`nostr:nevent…` reference should render here.
 *
 * `reference` is not a failure state — it is the honest rendering for a reference
 * we decline to expand, and it still says which note was quoted.
 */
export function quoteRenderMode(
  id: string,
  frame: QuoteFrame,
): "card" | "reference" {
  if (frame.depth >= MAX_QUOTE_DEPTH) return "reference";
  if (frame.ancestors.includes(id)) return "reference";
  return "card";
}

/** The frame the content *inside* a card for `id` renders under. */
export function nestedFrame(id: string, frame: QuoteFrame): QuoteFrame {
  return { depth: frame.depth + 1, ancestors: [...frame.ancestors, id] };
}

/**
 * Carried by context rather than threaded through props.
 *
 * The path from a feed row to a quote card runs through `NoteCard`, which knows
 * nothing about quoting and should not have to — and the default is the root
 * frame, so any surface that renders note content gets the guard without opting
 * in. A surface that forgot to pass a prop would render unguarded recursion.
 */
export const QuoteFrameContext = createContext<QuoteFrame>(ROOT_QUOTE_FRAME);

export function useQuoteFrame(): QuoteFrame {
  return useContext(QuoteFrameContext);
}
