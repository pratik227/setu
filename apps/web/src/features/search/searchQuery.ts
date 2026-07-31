/**
 * What the reader typed, classified before anything is searched.
 *
 * A search box on Nostr is not only a search box. Most of the identifiers people
 * pass around — `npub1…`, `note1…`, `nevent1…`, `nprofile1…`, a bare 64-character
 * hex string, a `nostr:` URI out of a client's share menu — are *exact addresses*
 * for one thing. Running a text search over them is guaranteed to fail: the store
 * holds no note whose body contains that npub, so the single most common thing
 * anyone does with a search box would return "nothing matched" for input that
 * names its target unambiguously. So the input is classified first and resolved
 * directly whenever it can be.
 *
 * Two cases are worth naming because they are easy to get wrong:
 *
 *  - **A bare 64-hex string is ambiguous.** It is a valid pubkey and a valid event
 *    id, and nothing in the string says which. Guessing produces a profile page
 *    for an event id roughly half the time, so this returns the ambiguity and lets
 *    the palette offer both.
 *  - **`nsec1…` is a private key.** People do paste them into the wrong box. It is
 *    classified as its own case so the palette can refuse and say why, rather than
 *    tokenizing a secret into search terms and putting it in the results list.
 *
 * Pure and total: every input maps to exactly one intent, and nothing throws.
 */

import { decodeAny, isHex32, type Nip19Ref } from "@setu/protocol";

/**
 * Terms per query.
 *
 * A bound rather than a guess: matching is O(terms x corpus), the corpus is
 * thousands of events, and the ranking runs on every keystroke. Nobody narrows a
 * local index with a ninth word, but pasting a paragraph into the box is easy to
 * do by accident and would freeze the palette while it scored it.
 */
export const MAX_TERMS = 8;

export type SearchIntent =
  /** Nothing to do. */
  | { readonly kind: "empty" }
  /** An `nsec`. Never searched for, never displayed. */
  | { readonly kind: "secret" }
  /** A decodable NIP-19 entity: resolve it directly. */
  | { readonly kind: "ref"; readonly ref: Nip19Ref }
  /** 64-hex, which is both a plausible pubkey and a plausible event id. */
  | { readonly kind: "hex"; readonly value: string }
  /** `#topic` — a route, not a query. Terms are kept for the local pass too. */
  | {
      readonly kind: "hashtag";
      readonly tag: string;
      readonly terms: readonly string[];
    }
  /** Free text. */
  | { readonly kind: "text"; readonly terms: readonly string[] };

/**
 * Split input into lowercase terms.
 *
 * Case-folded here rather than at each comparison so a field is never lowercased
 * twice per term per candidate — that inner loop runs tens of thousands of times
 * per keystroke. Duplicates are dropped because a repeated term would count twice
 * towards a candidate's score and rank "bob bob" above "bob" for no reason.
 */
export function searchTerms(raw: string): readonly string[] {
  const seen = new Set<string>();
  for (const part of raw.toLowerCase().split(/\s+/)) {
    const term = part.replace(/^#+/, "").trim();
    if (term.length === 0) continue;
    seen.add(term);
    if (seen.size >= MAX_TERMS) break;
  }
  return [...seen];
}

/** A single `#word`, which addresses the hashtag route rather than a query. */
function soleHashtag(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("#")) return undefined;
  const tag = trimmed.slice(1).toLowerCase();
  return /^[\p{L}\p{N}_-]+$/u.test(tag) ? tag : undefined;
}

/** Classify raw input. Never throws; every string produces exactly one intent. */
export function parseSearchInput(raw: string): SearchIntent {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty" };

  // NIP-19 first: an identifier is an address, and a query that happens to look
  // like one is not a case worth supporting at the cost of breaking paste.
  const ref = decodeAny(trimmed);
  if (ref) {
    // The secret never travels further than this branch — not into terms, not
    // into a result row, not into a rendered string.
    return ref.type === "nsec" ? { kind: "secret" } : { kind: "ref", ref };
  }

  const lower = trimmed.toLowerCase();
  if (isHex32(lower)) return { kind: "hex", value: lower };

  const tag = soleHashtag(trimmed);
  const terms = searchTerms(trimmed);
  if (tag !== undefined) return { kind: "hashtag", tag, terms };

  return terms.length === 0 ? { kind: "empty" } : { kind: "text", terms };
}

/** The pubkey an intent addresses, when it addresses one unambiguously. */
export function intentPubkey(intent: SearchIntent): string | undefined {
  if (intent.kind !== "ref") return undefined;
  const { ref } = intent;
  if (ref.type === "npub" || ref.type === "nprofile") return ref.pubkey;
  // `naddr` names an author, but it addresses one of their articles rather than
  // the person, so it is not treated as a profile lookup here.
  return undefined;
}

/** The event id an intent addresses, when it addresses one. */
export function intentEventId(intent: SearchIntent): string | undefined {
  if (intent.kind !== "ref") return undefined;
  const { ref } = intent;
  return ref.type === "note" || ref.type === "nevent" ? ref.id : undefined;
}
