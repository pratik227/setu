/**
 * Turning a mute list into something a reader can manage, and refusing the drafts
 * that would ruin their feed.
 *
 * Split out of the dialog because both halves are decisions rather than markup, and
 * both are the kind of decision that is only obviously wrong once a reader has lived
 * with it for a week.
 *
 * ## Why the list is grouped by kind and each group is explained
 *
 * The four NIP-51 entry kinds do not do the same thing, and the differences are the
 * ones people get wrong. A `p` entry hides an account everywhere. A `word` entry
 * scans the text of every note, so it can hide people the reader likes for saying an
 * ordinary word. A `t` entry only catches a hashtag, so it does not hide the same
 * topic written as prose. A `word` mute that once looked reasonable is the entry
 * readers cannot account for later — "why am I not seeing anything from her?" — so
 * each group carries a line saying what its rules actually match.
 *
 * ## Why drafts are checked here rather than let through to the write path
 *
 * `useMuteAction` already refuses an empty target and a no-op edit, but it does so
 * *after* a relay round trip and a signature prompt, and it reports the refusal as
 * an error. Checking first turns three of those into an inline sentence with no
 * signing prompt at all. The interesting check is the short word: muting a
 * one-character word is not a small mistake, it silently empties the timeline
 * (`occursAsWord` matches a standalone `a`, which occurs in most sentences), and the
 * reader has no way to connect the empty feed to the rule that caused it.
 */

import type { MuteRules } from "@setu/core";
import {
  type MuteTarget,
  type MuteTargetKind,
  normalizeMuteTarget,
} from "./muteList";

/** A group of entries of one kind, with the copy that explains the kind. */
export interface MuteSection {
  readonly kind: MuteTargetKind;
  /** Plural heading. */
  readonly title: string;
  /** What rules of this kind match, in one sentence. */
  readonly blurb: string;
  readonly targets: readonly MuteTarget[];
}

const SECTION_COPY: Readonly<
  Record<MuteTargetKind, { readonly title: string; readonly blurb: string }>
> = {
  pubkey: {
    title: "Accounts",
    blurb:
      "Their notes, replies and reposts are hidden, and their replies and reactions stop counting towards other notes' totals.",
  },
  word: {
    title: "Words and phrases",
    blurb:
      "Any note whose text contains one of these as a whole word is hidden — including notes from people you follow. Matched on word boundaries, so “art” does not hide “party”.",
  },
  hashtag: {
    title: "Hashtags",
    blurb:
      "Notes tagging one of these, or writing it as #hashtag in the text, are hidden. The same topic written as ordinary prose is not.",
  },
  thread: {
    title: "Threads",
    blurb:
      "Notes in these conversations are hidden, including new replies arriving later.",
  },
};

/** Fixed order: most-used kind first, so the common case needs no scrolling. */
const SECTION_ORDER: readonly MuteTargetKind[] = [
  "pubkey",
  "word",
  "hashtag",
  "thread",
];

/**
 * Groups the list's entries by kind, in a fixed order, keeping list order inside
 * each group.
 *
 * Every kind is returned even when it holds nothing, so the surface can decide
 * whether an empty group is worth a heading. List order is preserved rather than
 * sorted alphabetically: `editMuteList` appends, so list order is roughly the order
 * the reader muted things in, which is the order they remember them in.
 */
export function groupMuteEntries(
  entries: readonly MuteTarget[],
): readonly MuteSection[] {
  return SECTION_ORDER.map((kind) => ({
    kind,
    ...SECTION_COPY[kind],
    targets: entries.filter((entry) => entry.kind === kind),
  }));
}

/** Why a draft entry was not accepted. */
export type MuteDraftProblem =
  | "empty"
  | "duplicate"
  | "too-short"
  | "too-long"
  | "hashtag-in-word";

export type MuteDraftResult =
  | { readonly ok: true; readonly target: MuteTarget }
  | {
      readonly ok: false;
      readonly problem: MuteDraftProblem;
      readonly message: string;
    };

/**
 * Shortest word rule accepted.
 *
 * Two characters, not one. A single-character word rule matches a standalone
 * letter, which appears in most English sentences, so it hides almost the whole
 * timeline — and it does so silently, from a rule the reader will not think to
 * suspect. Two characters can still be broad (`ok`, `hi`), but they cannot empty a
 * feed by accident.
 */
export const MIN_MUTE_WORD_LENGTH = 2;

/**
 * Longest entry accepted.
 *
 * The list is a replaceable event republished in full on every edit, so its size is
 * paid on every future mute. A phrase long enough to hit this is not a reading
 * preference, it is pasted content.
 */
export const MAX_MUTE_VALUE_LENGTH = 128;

/**
 * Checks a typed word or hashtag before it costs a signature.
 *
 * `existing` is the rule set currently in force, so a duplicate is caught against
 * what is actually being applied rather than against a stale render.
 */
export function checkMuteDraft(
  kind: "word" | "hashtag",
  raw: string,
  existing: MuteRules,
): MuteDraftResult {
  if (kind === "word" && raw.trim().startsWith("#")) {
    // Silently converting it would be worse: a `word` rule and a `t` rule match
    // different notes, and the reader would have got a rule they did not ask for.
    return {
      ok: false,
      problem: "hashtag-in-word",
      message: "That looks like a hashtag. Add it under Hashtags instead.",
    };
  }

  const target = normalizeMuteTarget({ kind, value: raw });
  if (target === undefined) {
    return {
      ok: false,
      problem: "empty",
      message:
        kind === "hashtag"
          ? "Type a hashtag, without the #."
          : "Type a word or phrase to mute.",
    };
  }

  if (target.value.length > MAX_MUTE_VALUE_LENGTH) {
    return {
      ok: false,
      problem: "too-long",
      message: `Keep it under ${MAX_MUTE_VALUE_LENGTH} characters.`,
    };
  }

  if (kind === "word" && target.value.length < MIN_MUTE_WORD_LENGTH) {
    return {
      ok: false,
      problem: "too-short",
      message:
        "A one-character word appears in almost every note, so this would hide nearly your whole timeline.",
    };
  }

  const alreadyMuted =
    target.kind === "hashtag"
      ? existing.hashtags.has(target.value)
      : existing.words.includes(target.value);
  if (alreadyMuted) {
    return {
      ok: false,
      problem: "duplicate",
      message: "That is already muted.",
    };
  }

  return { ok: true, target };
}

/**
 * One sentence for the top of the management surface.
 *
 * `loaded` is separate from "the list is empty" and stays that way here: telling
 * someone they have muted nobody before their list has arrived is a guess, and the
 * guess is wrong for exactly the accounts they most want to check.
 */
export function mutedListSummary(input: {
  readonly entries: readonly MuteTarget[];
  readonly loaded: boolean;
  readonly hasPrivateEntries: boolean;
}): string {
  if (!input.loaded) return "Still reading your mute list from your relays.";
  const total = input.entries.length;
  const counted =
    total === 0
      ? "Your mute list is empty."
      : `${total} ${total === 1 ? "entry" : "entries"}, published to your relays as an ordinary unencrypted event.`;
  if (!input.hasPrivateEntries) return counted;
  // Never presented as being in effect: Setu cannot decrypt them, so it cannot
  // apply them, and a reader who assumes otherwise thinks they are filtered when
  // they are not.
  return `${counted} It also holds private entries Setu cannot read, so they are not applied — they are copied through untouched by every edit made here.`;
}
