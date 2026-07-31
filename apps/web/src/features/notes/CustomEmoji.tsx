/**
 * NIP-30 custom emoji, rendered.
 *
 * A `:shortcode:` with a matching `emoji` tag becomes the image the author named.
 * Two rules make that safe and non-destructive, and both are about what happens
 * when it *cannot* be done:
 *
 *  - **An unresolvable shortcode is literal text.** `emojiSegments` only tokenizes
 *    codes it was told about, so a `:word:` with no tag never reaches this module.
 *    A code that *is* tagged but whose URL fails the allowlist falls back to the
 *    same literal text here — never to a broken-image icon in mid-sentence.
 *  - **Every URL passes `sanitizeImageUrl` first.** The value comes off a
 *    stranger's tag and lands directly in an `src`, which is precisely the position
 *    a `javascript:` or `data:image/svg+xml` payload wants to occupy.
 *
 * Sized in `em` rather than in a fixed height so an emoji tracks the text it sits
 * in: a 20px glyph beside 14px text overlaps the line above it, and beside a
 * reader's zoomed-in text it looks like a typo.
 */

import { type EmojiSegment, emojiSegments } from "@setu/protocol";
import { Fragment } from "react";
import { sanitizeImageUrl } from "../articles/markdownUrl";

/**
 * One custom emoji.
 *
 * `label` is the literal `:shortcode:` the author typed: it is the alt text, the
 * tooltip, *and* the fallback, so a reader who cannot load the image still sees
 * exactly what a client without custom-emoji support would show them.
 */
export function CustomEmoji({ url, label }: { url: string; label: string }) {
  const safe = sanitizeImageUrl(url);
  if (safe === undefined) return <>{label}</>;
  return (
    <img
      src={safe}
      alt={label}
      title={label}
      loading="lazy"
      decoding="async"
      // `max-w` bounds a "custom emoji" that is really a wide banner image, which
      // would otherwise reflow the note it sits in.
      className="inline-block h-[1.25em] max-w-[6em] w-auto object-contain align-text-bottom"
    />
  );
}

/**
 * Text with its custom emoji resolved.
 *
 * Returns the plain string when nothing matched, so the overwhelmingly common case
 * — a note with no `emoji` tags at all — costs one map lookup and allocates no
 * elements.
 */
export function EmojiText({
  text,
  emoji,
}: {
  text: string;
  emoji: ReadonlyMap<string, string>;
}) {
  if (emoji.size === 0) return <>{text}</>;
  const segments = emojiSegments(text, new Set(emoji.keys()));
  if (segments.length === 1 && segments[0]?.type === "text") {
    return <>{text}</>;
  }
  return (
    <>
      {segments.map((segment, index) => (
        // Segments are a pure function of immutable content and never reorder, so
        // there is no stable id to key on and none is needed.
        // biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder
        <Fragment key={`${segment.type}-${index}`}>
          <SegmentView segment={segment} emoji={emoji} />
        </Fragment>
      ))}
    </>
  );
}

function SegmentView({
  segment,
  emoji,
}: {
  segment: EmojiSegment;
  emoji: ReadonlyMap<string, string>;
}) {
  if (segment.type === "text") return <>{segment.value}</>;
  const url = emoji.get(segment.shortcode);
  // A tokenized shortcode always has a URL — `emojiSegments` was given this map's
  // own keys — but falling back to the literal text keeps that an invariant rather
  // than an assumption the renderer would crash on.
  if (url === undefined) return <>{segment.value}</>;
  return <CustomEmoji url={url} label={segment.value} />;
}
