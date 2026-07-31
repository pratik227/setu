/**
 * Matching and ranking over the local index.
 *
 * Pure functions over flat candidates: given the same input they produce the same
 * output, which is the only reason the ordering can be relied on. Everything here
 * describes **the events this device has already fetched and verified** — nothing
 * else. There is no crawler behind Setu and no index of the network, so a result
 * list is a statement about one device's store, and the UI has to say so.
 *
 * Three ranking decisions that are not obvious:
 *
 *  1. **Terms are ANDed.** Two words means both must match. OR'ing them returns
 *     everything matching the commoner word, which for "alice bitcoin" is every
 *     note mentioning bitcoin — a longer query producing more results is the
 *     opposite of what typing another word means.
 *  2. **Where a term matched decides rank, not how many times.** A person whose
 *     name *is* the query outranks one who merely mentions it in their bio, no
 *     matter how often. Counting occurrences instead lets one repetitive bio
 *     outrank the person actually being looked for.
 *  3. **Ties break deterministically, on the key.** A palette re-ranks on every
 *     keystroke against a live store, and ties are the common case in a small
 *     sample. Arbitrary tie order makes the list reshuffle under the reader's
 *     cursor between two keystrokes that changed nothing.
 */

/** A profile from the local store, flattened for matching. */
export interface PersonCandidate {
  readonly pubkey: string;
  /** Bech32 form, precomputed — encoding it per keystroke is wasted work. */
  readonly npub?: string;
  readonly displayName?: string;
  /** The short `name` field, which is the handle-ish one. */
  readonly name?: string;
  readonly nip05?: string;
  readonly about?: string;
}

/** A note from the local store, flattened for matching. */
export interface NoteCandidate {
  readonly id: string;
  readonly pubkey: string;
  readonly createdAt: number;
  readonly content: string;
}

export interface Scored<T> {
  readonly value: T;
  readonly score: number;
}

/*
 * Score tiers.
 *
 * Spaced an order of magnitude apart rather than by one, so a match in a weaker
 * field can never accumulate past a match in a stronger one. With adjacent values
 * a person mentioned in three bios would outrank the person whose name is the
 * query, which is the exact failure this scale exists to prevent.
 */
const EXACT = 1000;
const PREFIX = 300;
/** Matched at a word boundary inside the value: "smith" in "alice smith". */
const WORD = 120;
const SUBSTRING = 40;
/** Bio text. Real evidence, an order weaker than anything about the name. */
const ABOUT = 5;

/**
 * How a term matched one field, ignoring which field it was.
 *
 * Returns 0 for no match so callers can sum without branching. Every input is
 * already lowercase — see `searchTerms` for why the folding happens once, up
 * front, rather than here.
 */
function fieldScore(value: string | undefined, term: string): number {
  if (value === undefined || value.length === 0) return 0;
  const haystack = value.toLowerCase();
  if (haystack === term) return EXACT;
  if (haystack.startsWith(term)) return PREFIX;
  const at = haystack.indexOf(term);
  if (at < 0) return 0;
  // A word boundary is what makes "smith" a hit on "alice smith" but not on
  // "blacksmithing"; both are matches, they are not equally good ones.
  const before = haystack.charCodeAt(at - 1);
  return isBoundary(before) ? WORD : SUBSTRING;
}

/** True for the characters that separate words in a name or a note. */
function isBoundary(code: number): boolean {
  if (Number.isNaN(code)) return true;
  return !(
    (
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) || // 0-9
      code > 127
    ) // anything non-ASCII: assume it is part of a word
  );
}

/**
 * Score one profile against one term.
 *
 * The npub is matched by prefix only. Nobody types the middle of a bech32 string,
 * and a substring match on one would fire on the shared `npub1` prefix of every
 * key in the store — every profile scoring identically on a query of "npub" is a
 * ranking that says nothing.
 */
function personTermScore(person: PersonCandidate, term: string): number {
  let best = Math.max(
    fieldScore(person.displayName, term),
    fieldScore(person.name, term),
    fieldScore(person.nip05, term),
  );
  if (person.npub?.toLowerCase().startsWith(term)) {
    best = Math.max(best, PREFIX);
  }
  if (best > 0) return best;
  // The bio is consulted only when nothing about the identity matched, so it
  // cannot lift a bio mention above a name match on a different term.
  return fieldScore(person.about, term) > 0 ? ABOUT : 0;
}

/**
 * People matching every term, best first.
 *
 * Ties break on the display name and then the pubkey. The name comes first
 * because it is what the reader sees: two identical scores ordered by pubkey look
 * random on screen, and alphabetical is at least a rule someone can follow.
 */
export function rankPeople<T extends PersonCandidate>(
  candidates: readonly T[],
  terms: readonly string[],
  limit?: number,
): readonly Scored<T>[] {
  if (terms.length === 0) return [];
  const out: Scored<T>[] = [];
  for (const person of candidates) {
    let total = 0;
    let matchedAll = true;
    for (const term of terms) {
      const score = personTermScore(person, term);
      if (score === 0) {
        matchedAll = false;
        break;
      }
      total += score;
    }
    if (matchedAll) out.push({ value: person, score: total });
  }
  out.sort(comparePeople);
  return limit === undefined ? out : out.slice(0, limit);
}

function comparePeople(
  a: Scored<PersonCandidate>,
  b: Scored<PersonCandidate>,
): number {
  /* Compares only fields on the base shape, so it sorts any refinement of it. */
  if (b.score !== a.score) return b.score - a.score;
  const nameA = a.value.displayName ?? a.value.name ?? "";
  const nameB = b.value.displayName ?? b.value.name ?? "";
  const byName = nameA.localeCompare(nameB);
  return byName !== 0 ? byName : a.value.pubkey.localeCompare(b.value.pubkey);
}

/**
 * Notes matching every term, newest first.
 *
 * Recency is the primary key, not the score, and that is a deliberate departure
 * from the people ranking. A relevance ordering over a few thousand notes this
 * device happens to hold is mostly noise — the sample is not representative of
 * anything, so "most relevant" would be a stronger claim than the data supports.
 * When a note was written is a fact about the note. The match score still breaks
 * ties, which is what puts a note whose first word is the query above one that
 * mentions it in passing at the same second.
 */
export function rankNotes<T extends NoteCandidate>(
  candidates: readonly T[],
  terms: readonly string[],
  limit?: number,
): readonly Scored<T>[] {
  if (terms.length === 0) return [];
  const out: Scored<T>[] = [];
  for (const note of candidates) {
    let total = 0;
    let matchedAll = true;
    for (const term of terms) {
      const score = fieldScore(note.content, term);
      if (score === 0) {
        matchedAll = false;
        break;
      }
      total += score;
    }
    if (matchedAll) out.push({ value: note, score: total });
  }
  out.sort(compareNotes);
  return limit === undefined ? out : out.slice(0, limit);
}

function compareNotes(
  a: Scored<NoteCandidate>,
  b: Scored<NoteCandidate>,
): number {
  if (b.value.createdAt !== a.value.createdAt) {
    return b.value.createdAt - a.value.createdAt;
  }
  if (b.score !== a.score) return b.score - a.score;
  return a.value.id.localeCompare(b.value.id);
}

/** A run of text, flagged when it is one of the search terms. */
export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * Split text into matched and unmatched runs, for highlighting.
 *
 * Done as data rather than by injecting markup, because the alternative is
 * building an HTML string from note content — user-authored text — and handing it
 * to `dangerouslySetInnerHTML`. Overlapping and adjacent matches are merged so a
 * query of "an and" cannot produce nested or duplicated runs over the same
 * characters.
 */
export function highlight(
  text: string,
  terms: readonly string[],
): readonly Segment[] {
  if (text.length === 0) return [];
  const ranges: [number, number][] = [];
  const haystack = text.toLowerCase();
  for (const term of terms) {
    if (term.length === 0) continue;
    let from = haystack.indexOf(term);
    while (from >= 0) {
      ranges.push([from, from + term.length]);
      from = haystack.indexOf(term, from + term.length);
    }
  }
  if (ranges.length === 0) return [{ text, match: false }];

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }

  const out: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor)
      out.push({ text: text.slice(cursor, start), match: false });
    out.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length)
    out.push({ text: text.slice(cursor), match: false });
  return out;
}

/**
 * A window of `content` around the first matching term.
 *
 * A note row shows one line, and the match is routinely three paragraphs down. A
 * fixed head-of-content preview would show text with nothing highlighted in it,
 * which reads as a result that does not match its own query.
 */
export function snippet(
  content: string,
  terms: readonly string[],
  width = 140,
): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;

  const haystack = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = haystack.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  // Leading context, so the match is not flush against the ellipsis.
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(width / 4));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${
    end < flat.length ? "…" : ""
  }`;
}
