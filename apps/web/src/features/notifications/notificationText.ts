/**
 * The one sentence a notification row is.
 *
 * Pure, and separate from the row component, because the wording is where a
 * notification list either tells the truth or quietly overstates it: "liked your
 * note" about a note we never retrieved, "liked" about a 🔥 reaction, "and 1
 * other" about a row with two actors. Each of those is a string decision, so each
 * is testable as one.
 */

import type { NotificationKind } from "./groupNotifications";

export interface NotificationLineInput {
  readonly kind: NotificationKind;
  /**
   * Display names of the leading actors, newest first. Only the first two are
   * ever read; the rest become "and N others".
   */
  readonly names: readonly string[];
  /** Distinct actors in the row. Never less than `names.length`. */
  readonly actorCount: number;
  /** True only when the target is verified to be the viewer's own note. */
  readonly targetIsMine: boolean;
  /** True when every reaction in the row is a plain like. */
  readonly allLikes: boolean;
}

/** Fallback when a name has not resolved yet — never a guessed identity. */
const UNKNOWN_ACTOR = "Someone";

/**
 * "Alice", "Alice and Bob", "Alice and 4 others".
 *
 * Two actors are named rather than collapsed to "and 1 other": the name is
 * shorter than the phrase and strictly more informative.
 */
export function actorPhrase(
  names: readonly string[],
  actorCount: number,
): string {
  const first = names[0] ?? UNKNOWN_ACTOR;
  if (actorCount <= 1) return first;
  if (actorCount === 2) return `${first} and ${names[1] ?? UNKNOWN_ACTOR}`;
  const others = actorCount - 1;
  return `${first} and ${others} others`;
}

/**
 * How the row refers to what was acted on.
 *
 * "your note" is only used where we hold the target and its author is the viewer.
 * An actor chooses the `p` tag that routed the event here, so being addressed to
 * you is not evidence the target is yours.
 */
function targetPhrase(targetIsMine: boolean): string {
  return targetIsMine ? "your note" : "a note";
}

export function notificationLine(input: NotificationLineInput): string {
  const who = actorPhrase(input.names, input.actorCount);
  const what = targetPhrase(input.targetIsMine);

  switch (input.kind) {
    case "reply":
      return `${who} replied to ${what}`;
    case "mention":
      return `${who} mentioned you`;
    case "reaction":
      // Mixed or emoji reactions are not likes. Saying "liked" about a 💀 is a
      // small lie that changes how the row reads.
      return input.allLikes
        ? `${who} liked ${what}`
        : `${who} reacted to ${what}`;
    case "repost":
      return `${who} reposted ${what}`;
    case "zap":
      return `${who} zapped ${what}`;
    default: {
      // Exhaustiveness guard: a new notification kind must get wording rather
      // than silently rendering an empty line.
      const never: never = input.kind;
      return String(never);
    }
  }
}

/** Accessible label for the kind glyph beside the row. */
export function notificationKindLabel(kind: NotificationKind): string {
  switch (kind) {
    case "reply":
      return "Reply";
    case "mention":
      return "Mention";
    case "reaction":
      return "Reaction";
    case "repost":
      return "Repost";
    case "zap":
      return "Zap";
    default: {
      const never: never = kind;
      return String(never);
    }
  }
}
