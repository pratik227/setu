/**
 * NIP-71 video events — kind 21 (normal) and kind 22 (short, portrait).
 *
 * Media-first in the same way NIP-68 pictures are: the video lives in `imeta`
 * tags and the content is a description. A renderer that scans the body for a
 * `.mp4` finds nothing and shows a paragraph of text where a video should be.
 *
 * The kind split is a *presentation* hint, not a different format. Kind 22 is
 * short portrait video, so a client can give it a taller frame; both parse
 * identically, which is why one function handles them and reports which it was
 * rather than making the caller check the number twice.
 *
 * Several `imeta` rows on one video event are usually the same video at different
 * resolutions, not several videos. That is the one place this differs from a
 * picture post, and it is why {@link VideoPost} names a `primary` variant: playing
 * all of them would stack four copies of one film in a timeline row.
 */

import { Kind } from "./kinds";
import { type ImetaEntry, parseImeta } from "./nip92";
import { getTagValue } from "./tags";
import type { NostrEvent } from "./types";

/** A decoded kind-21 or kind-22. */
export interface VideoPost {
  /** True for kind 22 — short, portrait, taller frame. */
  readonly short: boolean;
  readonly title?: string;
  /** The event's content: a description, not the media. */
  readonly description: string;
  /**
   * The variant to play. The first usable `imeta` row, which is the author's own
   * ordering and the only ranking available — nothing in the tag says which
   * resolution is preferred.
   */
  readonly primary: ImetaEntry;
  /** Every declared variant, in tag order, `primary` included. */
  readonly variants: readonly ImetaEntry[];
  /** `duration` in whole seconds, when the author declared a usable one. */
  readonly durationSeconds?: number;
}

/**
 * Whole seconds from a `duration` tag, or `undefined` when unusable.
 *
 * Strict for the same reason `parseDim` is: the value ends up formatted into a
 * label, and `Number("2 min")` is `NaN`, which renders as the literal string
 * "NaN:NaN" next to the play button. A missing duration is a state the UI already
 * handles by showing nothing.
 */
function parseDuration(raw: string): number | undefined {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

/** True for the two kinds this module decodes. */
export function isVideoKind(kind: number): boolean {
  return kind === Kind.Video || kind === Kind.ShortVideo;
}

/**
 * Decode a video event, or `undefined` when the event is not one.
 *
 * A video event with no usable `imeta` row is rejected rather than returned with
 * an empty variant list: there is no video to play, and a row rendering a title
 * over a dead player is indistinguishable from one whose network request failed.
 */
export function parseVideo(event: NostrEvent): VideoPost | undefined {
  if (!isVideoKind(event.kind)) return undefined;
  const variants = parseImeta(event);
  const primary = variants[0];
  if (primary === undefined) return undefined;

  const rawDuration = getTagValue(event, "duration");
  const durationSeconds =
    rawDuration === undefined ? undefined : parseDuration(rawDuration);
  const title = getTagValue(event, "title");

  return {
    short: event.kind === Kind.ShortVideo,
    ...(title ? { title } : {}),
    description: event.content,
    primary,
    variants,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}
