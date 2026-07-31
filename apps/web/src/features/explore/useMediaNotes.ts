import type { NostrEvent } from "@setu/protocol";
import { Kind, tokenizeContent } from "@setu/protocol";
import { useMemo } from "react";
import { useStoreEvents } from "../discover/useStoreEvents";
import type { MediaView } from "../notes/types";

export interface MediaNote {
  readonly id: string;
  readonly pubkey: string;
  readonly createdAt: number;
  readonly content: string;
  /** Media hoisted out of the body by the tokenizer. Never empty. */
  readonly media: readonly MediaView[];
  /** NIP-36: presence means the tile renders blurred until revealed. */
  readonly contentWarning?: string;
}

/**
 * Notes in the local store that carry media.
 *
 * There is no relay filter for "has an image": media is a property of the note's
 * text, so it can only be found after the fact. That is why this is a *local*
 * query — we tokenize what we already hold rather than asking a relay a question
 * it cannot answer.
 *
 * Tokenization is the same function the renderer uses (`tokenizeContent`), so a
 * tile appears here exactly when `NoteContent` would have hoisted media out of
 * that note's body. A separate URL regex here would drift from that immediately.
 */
export function useMediaNotes(sampleSize = 300): {
  readonly notes: readonly MediaNote[];
  readonly sampleSize: number;
  readonly loading: boolean;
} {
  const filter = useMemo(
    () => ({ kinds: [Kind.ShortTextNote], limit: sampleSize }),
    [sampleSize],
  );
  const events = useStoreEvents(filter, { subscribe: true });

  const notes = useMemo(() => {
    const out: MediaNote[] = [];
    for (const { event } of events) {
      const media = mediaOf(event);
      if (media.length === 0) continue;
      const warning = contentWarningOf(event);
      out.push({
        id: event.id,
        pubkey: event.pubkey,
        createdAt: event.created_at,
        content: event.content,
        media,
        ...(warning !== undefined ? { contentWarning: warning } : {}),
      });
    }
    return out;
  }, [events]);

  return { notes, sampleSize: events.length, loading: events.length === 0 };
}

function mediaOf(event: NostrEvent): readonly MediaView[] {
  const out: MediaView[] = [];
  const seen = new Set<string>();
  for (const token of tokenizeContent(event.content, event.tags)) {
    if (token.type !== "image" && token.type !== "video") continue;
    if (seen.has(token.url)) continue;
    seen.add(token.url);
    out.push({ url: token.url, kind: token.type });
  }
  return out;
}

/**
 * NIP-36 reason, or `undefined` when the note is not marked.
 *
 * Presence of the tag is what matters, not its value: a bare
 * `["content-warning"]` still has to blur, so an empty string is a real answer
 * here and `undefined` means "no tag at all".
 */
function contentWarningOf(event: NostrEvent): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === "content-warning") {
      return tag[1] || "Marked sensitive by the author";
    }
  }
  return undefined;
}
