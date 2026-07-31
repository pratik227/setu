/**
 * NIP-51 mute matching (kind 10000).
 *
 * This lives beside {@link ./tombstones} because it is the same problem wearing a
 * different hat: a rule the reader stated once that every surface has to honour
 * without being asked again. Deletions taught the shape — a view that merely
 * *hides* an event has already paid for it. The event was fetched, verified,
 * stored, counted into some other note's reply total, and given one of the forty
 * slots in whatever bounded metadata window the surface keeps. Hiding it at the
 * last moment saves the pixels and nothing else, and the reader still waits on it.
 *
 * So the matcher is a pure predicate over a raw event, kept in `core` rather than
 * in a component, so the *same* predicate can be applied at every point where
 * muted content would otherwise cost something: when feed rows are assembled,
 * when interaction counts are tallied, and — once the store's ingest path grows a
 * policy hook — before an event is written at all. Nothing here touches React, a
 * store, or a screen.
 *
 * Two things this is deliberately not:
 *
 *  - **Not a block.** A mute list is a reading preference. Publishing one does not
 *    stop the muted account seeing the reader, reaching their relays, or replying
 *    to them. Any surface that offers muting has to say so, because a reader who
 *    believes otherwise is making a safety decision on a false premise.
 *  - **Not authoritative for anyone else.** The list is the reader's own; nothing
 *    here consults another account's mutes, and an event is never dropped because
 *    a third party muted it.
 */

import type { Hex32, NostrEvent } from "@setu/protocol";

/** Which rule matched, so a surface can state *why* it hid something. */
export type MuteReason = "author" | "hashtag" | "word" | "thread";

/**
 * A mute list's public half, parsed once into lookup form.
 *
 * Sets rather than arrays because this is consulted per event per render pass on a
 * live timeline; a linear scan of a few hundred muted pubkeys per row is the kind
 * of cost that only shows up on the accounts with the longest lists.
 */
export interface MuteRules {
  /** Muted authors. */
  readonly pubkeys: ReadonlySet<Hex32>;
  /** Muted hashtags, lowercased and without the leading `#`. */
  readonly hashtags: ReadonlySet<string>;
  /** Muted words, lowercased. Order is preserved only for stable keying. */
  readonly words: readonly string[];
  /** Muted threads, by root or referenced event id. */
  readonly threads: ReadonlySet<Hex32>;
}

/** No mutes at all. A shared constant so callers can compare by reference. */
export const NO_MUTES: MuteRules = {
  pubkeys: new Set(),
  hashtags: new Set(),
  words: [],
  threads: new Set(),
};

/** True when nothing is muted, so callers can skip the whole pass. */
export function isMuteRulesEmpty(rules: MuteRules): boolean {
  return (
    rules.pubkeys.size === 0 &&
    rules.hashtags.size === 0 &&
    rules.words.length === 0 &&
    rules.threads.size === 0
  );
}

/** `#Politics` and `politics` are the same mute. */
function normalizeHashtag(value: string): string {
  return value.trim().replace(/^#+/, "").toLowerCase();
}

/**
 * Parses the entry tags of a kind-10000 into lookup form.
 *
 * Unrecognized tags are ignored rather than guessed at — but note that ignoring
 * them here says nothing about *writing*: a list edit must copy every tag it does
 * not understand through verbatim, or the edit deletes entries this version of the
 * client happens not to know about.
 */
export function muteRulesFrom(tags: readonly (readonly string[])[]): MuteRules {
  const pubkeys = new Set<Hex32>();
  const hashtags = new Set<string>();
  const threads = new Set<Hex32>();
  const words: string[] = [];
  const seenWords = new Set<string>();

  for (const tag of tags) {
    const value = tag[1];
    if (value === undefined || value === "") continue;
    switch (tag[0]) {
      case "p":
        pubkeys.add(value);
        break;
      case "t": {
        const hashtag = normalizeHashtag(value);
        if (hashtag !== "") hashtags.add(hashtag);
        break;
      }
      case "word": {
        const word = value.trim().toLowerCase();
        if (word !== "" && !seenWords.has(word)) {
          seenWords.add(word);
          words.push(word);
        }
        break;
      }
      case "e":
        threads.add(value);
        break;
      default:
        break;
    }
  }

  return { pubkeys, hashtags, words, threads };
}

/**
 * A deterministic identity for a rule set.
 *
 * Exists for memoisation, not for storage. A mute predicate has to be a *stable
 * reference* for the surfaces that hold it (a feed's row filter is memoised on it,
 * and a filter with a new identity every render recomputes the feed's bounded
 * metadata window every render). Rules are re-parsed whenever the store re-emits
 * the list — several times a second on a busy feed — so reference equality is
 * useless and value equality needs a key.
 */
export function muteRulesKey(rules: MuteRules): string {
  return [
    [...rules.pubkeys].sort().join(","),
    [...rules.hashtags].sort().join(","),
    [...rules.words].sort().join(","),
    [...rules.threads].sort().join(","),
  ].join("|");
}

/** Letters, digits and `_` — what counts as "inside a word" for boundaries. */
const WORDISH = /[\p{L}\p{N}_]/u;

function isWordish(char: string | undefined): boolean {
  return char !== undefined && WORDISH.test(char);
}

/**
 * Does `needle` occur in `haystack` as a standalone run rather than inside a
 * longer word? Both must already be lowercased.
 *
 * A plain `includes` is what NIP-51's "word" reads like and it is wrong in
 * practice: muting `art` would hide every note mentioning `party`, `start` or
 * `Bart`, and a feed that swallows unrelated notes is indistinguishable from a
 * broken one. Boundaries are checked on the characters either side of the match,
 * so multi-word phrases and punctuation-adjacent hits still work, and a needle
 * that begins with punctuation (`#tag`) is matched exactly as given.
 *
 * Scanned rather than compiled into a `RegExp`: the needle is user input, and
 * building a pattern out of it invites both escaping bugs and a pathological
 * pattern that hangs the render.
 */
export function occursAsWord(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? undefined : haystack[at - 1];
    const after = haystack[at + needle.length];
    if (!isWordish(before) && !isWordish(after)) return true;
    from = at + 1;
  }
}

/**
 * Why this event is muted, or `undefined` if it is not.
 *
 * Author first because it is a set lookup and by far the most common rule; the
 * content scan runs last and only when a word or hashtag rule exists at all.
 *
 * Hashtags are matched against the event's own `t` tags *and* against `#tag`
 * occurrences in the text. Tags-only would be the cleaner rule but it does not
 * match how the network is actually written — most notes carry their hashtags
 * inline and tag nothing — so a hashtag mute that only read `t` tags would look
 * like it silently did not work.
 */
export function mutedReason(
  event: NostrEvent,
  rules: MuteRules,
): MuteReason | undefined {
  if (rules.pubkeys.has(event.pubkey)) return "author";

  if (rules.threads.size > 0) {
    if (rules.threads.has(event.id)) return "thread";
    for (const tag of event.tags) {
      if (tag[0] !== "e") continue;
      const id = tag[1];
      if (id !== undefined && rules.threads.has(id)) return "thread";
    }
  }

  if (rules.hashtags.size > 0) {
    for (const tag of event.tags) {
      if (tag[0] !== "t") continue;
      const value = tag[1];
      if (value !== undefined && rules.hashtags.has(normalizeHashtag(value))) {
        return "hashtag";
      }
    }
  }

  if (rules.hashtags.size === 0 && rules.words.length === 0) return undefined;

  // One lowercase copy for both remaining rules; `content` on a long-form post is
  // large enough that doing it per word would be the expensive part of the pass.
  const text = event.content.toLowerCase();
  for (const hashtag of rules.hashtags) {
    if (occursAsWord(text, `#${hashtag}`)) return "hashtag";
  }
  for (const word of rules.words) {
    if (occursAsWord(text, word)) return "word";
  }
  return undefined;
}

/** True when any mute rule covers this event. */
export function isMuted(event: NostrEvent, rules: MuteRules): boolean {
  return mutedReason(event, rules) !== undefined;
}
