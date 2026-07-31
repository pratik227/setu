/**
 * Sharing a note as a reference other clients can actually resolve.
 *
 * A bare event id is not shareable. Nostr has no global index, so "note
 * abc123…" is only findable by someone already connected to a relay that happens
 * to hold it. `nevent1…` carries the author pubkey and a relay hint alongside the
 * id, which is what lets a different client on a different relay set find the
 * note instead of showing an "unavailable" placeholder. Emitting `note1…` (id
 * only) is the common shortcut, and it is why shared links so often resolve to
 * nothing.
 *
 * The `nostr:` scheme prefix is part of the reference, not decoration: it is what
 * makes the string a link a client can intercept (NIP-21).
 */

import { encodeNevent } from "@setu/protocol";

export interface NoteReferenceInput {
  readonly id: string;
  /** The note's author. Included so a resolver knows whose relays to ask. */
  readonly author?: string;
  readonly kind?: number;
  /** A relay we actually saw this note on. */
  readonly relayHint?: string;
}

/**
 * `nostr:nevent1…` for a note, or undefined when the id is not a valid event id.
 *
 * Undefined rather than a best-effort string: handing out a reference that
 * cannot be decoded is worse than declining to, because it fails silently in
 * whatever client the reader pastes it into.
 */
export function noteReference(input: NoteReferenceInput): string | undefined {
  const encoded = encodeNevent({
    id: input.id,
    ...(input.author ? { author: input.author } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.relayHint ? { relays: [input.relayHint] } : {}),
  });
  return encoded ? `nostr:${encoded}` : undefined;
}

/** Why a copy did not happen, when it did not. */
export type CopyRefusal =
  /** No Clipboard API — an insecure origin, or an old or embedded browser. */
  | "unsupported"
  /** The API exists but the write was refused (permission, or no user gesture). */
  | "denied";

export type CopyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: CopyRefusal;
      /**
       * The text we failed to copy, handed back so the caller can show it for
       * manual selection. A failed copy that shows nothing leaves the reader with
       * no way to share the note at all, which is the worse outcome.
       */
      readonly text: string;
    };

/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` is absent on insecure origins and can reject even where
 * it exists, so both are real paths rather than edge cases. Neither is treated as
 * an error to log and forget: the caller gets the text back to display.
 */
export async function copyText(text: string): Promise<CopyResult> {
  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) {
    return { ok: false, reason: "unsupported", text };
  }
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false, reason: "denied", text };
  }
}

/** One line for the UI, whatever happened. */
export function copyMessage(result: CopyResult): string {
  if (result.ok) return "Link copied";
  return result.reason === "unsupported"
    ? "This browser will not let Setu use the clipboard. The link is below — copy it manually."
    : "The clipboard write was refused. The link is below — copy it manually.";
}
