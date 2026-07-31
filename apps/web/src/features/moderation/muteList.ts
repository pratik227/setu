/**
 * Editing a mute list (NIP-51 kind 10000) without destroying it.
 *
 * Same hazard as the follow list, the bookmark list and the relay list, and for the
 * same reason: kind 10000 is *replaceable*, so publishing one replaces the previous
 * entirely. There is no "mute one more person" operation on the network — only
 * "here is my whole list now" — which makes every mute a chance to silently un-mute
 * everyone else.
 *
 * The way it goes wrong here is quieter than for follows, and that is what makes it
 * worse. Nobody notices a shortened mute list on the day it happens; they notice
 * weeks later when someone they muted long ago is back in the timeline, with no
 * event to blame and nothing to restore from. So the same protections as
 * `identity/followList.ts`:
 *
 *  1. **Never invent a list from nothing.** `absenceConfirmed` has to be true
 *     before a first list is created, because "no relay returned one" and "we did
 *     not finish asking" are indistinguishable, and treating the second as the
 *     first replaces a real list with a one-entry list.
 *  2. **Preserve tags we do not understand.** NIP-51 keeps four entry kinds in a
 *     mute list (`p`, `t`, `word`, `e`) and may grow more; a rebuild that emits
 *     only the ones this version knows deletes the rest.
 *  3. **Preserve `content`.** This is the load-bearing one for a mute list — see
 *     below.
 *
 * ## Private entries
 *
 * NIP-51 allows a second, *private* half of the list: the same tag array, JSON
 * encoded, NIP-44 encrypted to the author's own key, and stored in `content`.
 *
 * Setu does not read or write that half yet. It cannot decrypt it (the read path
 * would need the signer's `nip44Decrypt` on every list read), so it cannot show it,
 * and offering to *write* one entry into a blob whose other entries we cannot see
 * would be the destructive bug in this file's opening paragraph with encryption on
 * top. What it does instead is copy `content` through byte-for-byte on every write,
 * so a private list created in another client survives being edited here. That is
 * the whole of the support: private entries are preserved, never parsed, and never
 * claimed to the reader as being in effect.
 */

import type { MuteRules } from "@setu/core";
import { type EventTemplate, Kind, type NostrEvent } from "@setu/protocol";

/** What a mute list entry can be about. */
export type MuteTargetKind = "pubkey" | "hashtag" | "word" | "thread";

/** One entry, normalized. `value` is already in the form the tag will carry. */
export interface MuteTarget {
  readonly kind: MuteTargetKind;
  readonly value: string;
}

/** The NIP-51 tag name each entry kind is written under. */
export const MUTE_TAG_NAME: Readonly<Record<MuteTargetKind, string>> = {
  pubkey: "p",
  hashtag: "t",
  word: "word",
  thread: "e",
};

const KIND_BY_TAG: Readonly<Record<string, MuteTargetKind>> = {
  p: "pubkey",
  t: "hashtag",
  word: "word",
  e: "thread",
};

export type MuteEditRefusal =
  /** No kind-10000 was found and we are not certain none exists. */
  | "unverified-absence"
  /** The entry is already in the requested state; nothing to write. */
  | "no-change"
  /** The target normalized to nothing — an empty word, a bare `#`. */
  | "empty-target";

export type MuteEditResult =
  | { readonly ok: true; readonly template: EventTemplate }
  | { readonly ok: false; readonly reason: MuteEditRefusal };

export interface MuteEditInput {
  /** The newest kind-10000 we could find, or undefined if none exists. */
  readonly current: NostrEvent | undefined;
  /**
   * True only when every queried relay answered and none held a kind-10000.
   * Required to create a first list, for the reason in the module doc.
   */
  readonly absenceConfirmed: boolean;
  readonly target: MuteTarget;
  readonly action: "mute" | "unmute";
}

/**
 * Puts a target in the form the list stores it in.
 *
 * Hashtags and words are lowercased so `#Politics` and `#politics` cannot both sit
 * in the list as separate entries that each hide half the notes. Pubkeys and event
 * ids are lowercased too: hex is case-insensitive on the wire, and a mixed-case
 * duplicate would compare unequal to the one already there, so un-muting would
 * silently do nothing.
 */
export function normalizeMuteTarget(
  target: MuteTarget,
): MuteTarget | undefined {
  const raw = target.value.trim();
  if (raw === "") return undefined;
  switch (target.kind) {
    case "hashtag": {
      const value = raw.replace(/^#+/, "").toLowerCase();
      return value === "" ? undefined : { kind: "hashtag", value };
    }
    case "word":
      return { kind: "word", value: raw.toLowerCase() };
    default:
      return { kind: target.kind, value: raw.toLowerCase() };
  }
}

/** The public entries of a mute list, in list order, deduped. */
export function publicMuteEntries(
  event: NostrEvent | undefined,
): readonly MuteTarget[] {
  if (!event) return [];
  const out: MuteTarget[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    const kind = KIND_BY_TAG[tag[0] ?? ""];
    const raw = tag[1];
    if (kind === undefined || raw === undefined) continue;
    const target = normalizeMuteTarget({ kind, value: raw });
    if (target === undefined) continue;
    const dedupeKey = `${target.kind}:${target.value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(target);
  }
  return out;
}

/**
 * True when this list carries an encrypted private half.
 *
 * Surfaced to the reader rather than kept quiet: a list that says "you have muted
 * 4 accounts" while `content` holds twelve more is lying, and the honest version of
 * that sentence has to admit there is a part this client cannot read.
 */
export function hasPrivateMuteEntries(event: NostrEvent | undefined): boolean {
  return event !== undefined && event.content.trim() !== "";
}

/** Is this exact target already a public entry of the list? */
export function isMuteTarget(
  event: NostrEvent | undefined,
  target: MuteTarget,
): boolean {
  const wanted = normalizeMuteTarget(target);
  if (!event || wanted === undefined) return false;
  const tagName = MUTE_TAG_NAME[wanted.kind];
  return event.tags.some((tag) => {
    if (tag[0] !== tagName || tag[1] === undefined) return false;
    const entry = normalizeMuteTarget({ kind: wanted.kind, value: tag[1] });
    return entry?.value === wanted.value;
  });
}

/**
 * Is this target already covered by rules parsed out of a list?
 *
 * The same question as {@link isMuteTarget} asked of the parsed form rather than the
 * event, for the surfaces that hold rules and not the list event — a note row
 * deciding whether its menu should say "Mute" or "Unmute".
 */
export function muteRulesInclude(
  rules: MuteRules,
  target: MuteTarget,
): boolean {
  const wanted = normalizeMuteTarget(target);
  if (wanted === undefined) return false;
  switch (wanted.kind) {
    case "pubkey":
      return rules.pubkeys.has(wanted.value);
    case "hashtag":
      return rules.hashtags.has(wanted.value);
    case "word":
      return rules.words.includes(wanted.value);
    case "thread":
      return rules.threads.has(wanted.value);
  }
}

/** Count of entries a rebuild is allowed to move, for the plausibility check. */
function entryTagCount(tags: readonly (readonly string[])[]): number {
  return tags.filter((tag) => KIND_BY_TAG[tag[0] ?? ""] !== undefined).length;
}

/**
 * Build the replacement kind-10000 for muting or un-muting one target.
 *
 * The returned template is the *entire* new list. Everything not explicitly
 * changed is copied through byte-for-byte.
 */
export function editMuteList(input: MuteEditInput): MuteEditResult {
  const { current, absenceConfirmed, action } = input;
  const target = normalizeMuteTarget(input.target);
  if (target === undefined) return { ok: false, reason: "empty-target" };

  if (!current && !absenceConfirmed) {
    // Refusing is the whole point. A first mute that overwrites a list we failed
    // to fetch is indistinguishable, afterwards, from the user having un-muted
    // everyone they ever muted.
    return { ok: false, reason: "unverified-absence" };
  }

  const already = isMuteTarget(current, target);
  if (action === "mute" && already) return { ok: false, reason: "no-change" };
  if (action === "unmute" && !already)
    return { ok: false, reason: "no-change" };

  const tagName = MUTE_TAG_NAME[target.kind];
  const existingTags = current?.tags ?? [];
  const tags: string[][] = [];

  if (action === "unmute") {
    // Every entry for this target goes, not just the first: a list that acquired
    // the same pubkey twice (two clients appending) would otherwise stay muted
    // after an un-mute that appeared to succeed.
    for (const tag of existingTags) {
      const same =
        tag[0] === tagName &&
        tag[1] !== undefined &&
        normalizeMuteTarget({ kind: target.kind, value: tag[1] })?.value ===
          target.value;
      if (same) continue;
      tags.push([...tag]);
    }
  } else {
    for (const tag of existingTags) tags.push([...tag]);
    // Appended, so every existing entry keeps its index and consecutive versions
    // of the list diff readably.
    tags.push([tagName, target.value]);
  }

  return {
    ok: true,
    template: {
      kind: Kind.MuteList,
      // Carried through verbatim: this holds the NIP-44 encrypted *private*
      // entries, which we cannot read and therefore cannot rebuild. Blanking it
      // destroys them with no way back — see the module doc.
      content: current?.content ?? "",
      tags,
    },
  };
}

/**
 * Sanity check before publishing: refuse a write that loses an implausible amount
 * of the list.
 *
 * A last line of defence against a bug upstream of here. Going from 200 muted
 * accounts to 1 is never a user intent expressed through a mute button, so it is
 * treated as a defect and blocked rather than published.
 */
export function isPlausibleMuteWrite(
  before: NostrEvent | undefined,
  template: EventTemplate,
): boolean {
  const nextTags = template.tags ?? [];
  // A single mute/unmute moves the entry count by exactly one.
  if (
    Math.abs(entryTagCount(nextTags) - entryTagCount(before?.tags ?? [])) > 1
  ) {
    return false;
  }
  // Tags this version does not recognize are part of the list too. Dropping them
  // passes the count check above, because it moves the entries we *do* recognize
  // by exactly one.
  const unknownBefore = (before?.tags ?? []).filter(
    (tag) => KIND_BY_TAG[tag[0] ?? ""] === undefined,
  ).length;
  const unknownAfter = nextTags.filter(
    (tag) => KIND_BY_TAG[tag[0] ?? ""] === undefined,
  ).length;
  if (unknownAfter < unknownBefore) return false;
  // And the private half lives in `content`; losing it is unrecoverable.
  return !(before && before.content !== "" && template.content === "");
}
