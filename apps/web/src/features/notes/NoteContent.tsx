import type { BodyHandlers, QuoteReference, RenderedContent } from "./noteBody";
import { useRenderedBody } from "./noteBody";
import { QuoteCard } from "./QuoteCard";

/**
 * Note content, rendered.
 *
 * The tokenizer and the token renderer live in `noteBody.tsx`; this module is the
 * seam where the two recursive halves meet. A quoted note's body is note content
 * too, so `QuoteCard` needs the renderer and the renderer needs `QuoteCard` —
 * wiring them here, through the `renderQuote` callback, keeps that from being an
 * import cycle.
 */

export type { RenderedContent };

/**
 * A `nostr:note…`/`nostr:nevent…` reference becomes the note it names.
 *
 * Module-level so it is reference-stable across renders: it is a dependency of the
 * tokenizing memo, and a closure rebuilt per render would re-tokenize every note
 * on screen on every render.
 */
function renderQuote(
  reference: QuoteReference,
  handlers: BodyHandlers,
): React.ReactNode {
  return <QuoteCard reference={reference} {...handlers} />;
}

export interface NoteContentProps extends BodyHandlers {
  content: string;
  tags?: readonly (readonly string[])[];
}

/** Tokenize once, then render. Returns the body and the hoisted media list. */
export function useRenderedContent({
  content,
  tags,
  onOpenHashtag,
  onOpenMention,
}: NoteContentProps): RenderedContent {
  return useRenderedBody({
    content,
    ...(tags ? { tags } : {}),
    ...(onOpenHashtag ? { onOpenHashtag } : {}),
    ...(onOpenMention ? { onOpenMention } : {}),
    renderQuote,
  });
}
