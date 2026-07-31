/**
 * Flattening results into the one list the keyboard walks.
 *
 * The palette renders three groups, and the arrow keys must not know that. Two
 * lists with two selection indices means Down at the bottom of the first one does
 * nothing, or worse, moves a selection the reader cannot see; a group-aware
 * traversal is a state machine that has to be right for every combination of
 * groups being empty. So the groups are a rendering detail over a single ordered
 * array, and "selected" is one integer into it.
 *
 * Kept pure and separate from the palette for the same reason the ranking is: the
 * ordering and the identity of each row are the parts that can be wrong in a way
 * nobody notices, and both are testable here.
 */

import { truncateNpub } from "@setu/protocol";
import type { NoteCandidate, PersonCandidate } from "./localMatch";
import { rankNotes, rankPeople } from "./localMatch";
import type { SearchIntent } from "./searchQuery";
import type { SearchPerson } from "./useSearchCorpus";

/**
 * People shown at once.
 *
 * Small on purpose: the palette is for going somewhere, not for browsing. Anyone
 * who cannot see the person they meant in eight rows is better served by typing
 * another word than by arrowing through forty.
 */
export const PEOPLE_LIMIT = 8;

/** Notes shown at once. Larger than people: text matches are less decisive. */
export const NOTES_LIMIT = 12;

export type SearchAction =
  | { readonly kind: "profile"; readonly pubkey: string }
  | { readonly kind: "note"; readonly id: string }
  | { readonly kind: "hashtag"; readonly tag: string };

/** Which labelled block a row is rendered under. */
export type SearchGroup = "jump" | "people" | "notes";

interface ItemBase {
  /** Unique, stable row identity. Feeds React keys and `aria-activedescendant`. */
  readonly key: string;
  readonly group: SearchGroup;
  readonly action: SearchAction;
}

export interface PersonItem extends ItemBase {
  readonly kind: "person";
  readonly person: SearchPerson;
}

export interface NoteItem extends ItemBase {
  readonly kind: "note";
  readonly note: NoteCandidate;
  /** Undefined when this device holds the note but not its author's profile. */
  readonly author?: SearchPerson;
}

/** A row that names a destination rather than a piece of content. */
export interface CommandItem extends ItemBase {
  readonly kind: "command";
  readonly label: string;
  /** Second line: says what the destination is, or why it is a guess. */
  readonly hint: string;
}

export type SearchItem = PersonItem | NoteItem | CommandItem;

export interface BuildItemsInput {
  readonly intent: SearchIntent;
  readonly people: readonly SearchPerson[];
  readonly notes: readonly NoteCandidate[];
  readonly byPubkey: ReadonlyMap<string, SearchPerson>;
  readonly peopleLimit?: number;
  readonly notesLimit?: number;
}

function shortNpub(person: PersonCandidate): string {
  return person.npub
    ? truncateNpub(person.npub, 10)
    : `${person.pubkey.slice(0, 12)}…`;
}

/**
 * The rows for one intent, in the order the keyboard will walk them.
 *
 * Direct addresses come first and always. Someone who pasted an `npub` has already
 * told the client exactly what they want, so burying that row under text matches
 * for the same string — which is what ranking by score would do, since the pasted
 * key also prefix-matches its own owner's profile — would mean the most certain
 * result is not the one Enter opens.
 */
export function buildSearchItems(
  input: BuildItemsInput,
): readonly SearchItem[] {
  const { intent, byPubkey } = input;
  const items: SearchItem[] = [];

  if (intent.kind === "empty" || intent.kind === "secret") return items;

  if (intent.kind === "ref") {
    const { ref } = intent;
    if (ref.type === "npub" || ref.type === "nprofile") {
      items.push(profileJump(ref.pubkey, byPubkey));
    } else if (ref.type === "note" || ref.type === "nevent") {
      items.push({
        kind: "command",
        key: `jump:note:${ref.id}`,
        group: "jump",
        action: { kind: "note", id: ref.id },
        label: "Open this note",
        // Whether we hold it is not checked here: the thread view fetches by id
        // and is the only thing that can honestly say "no relay had it".
        hint: `${ref.id.slice(0, 12)}…`,
      });
    }
    // `naddr` addresses one article by coordinate, and there is no route that
    // takes one yet. Emitting a row that goes nowhere would be worse than the
    // palette saying it cannot open this kind of link.
    return items;
  }

  if (intent.kind === "hex") {
    // Both readings are offered because both are valid and the string does not
    // say which. Profile first: a pubkey is the form people copy far more often.
    items.push(profileJump(intent.value, byPubkey));
    items.push({
      kind: "command",
      key: `jump:note:${intent.value}`,
      group: "jump",
      action: { kind: "note", id: intent.value },
      label: "Open as a note",
      hint: "64-character hex is also a valid event id",
    });
    return items;
  }

  if (intent.kind === "hashtag") {
    items.push({
      kind: "command",
      key: `jump:hashtag:${intent.tag}`,
      group: "jump",
      action: { kind: "hashtag", tag: intent.tag },
      label: `#${intent.tag}`,
      hint: "Open the hashtag feed",
    });
  }

  const terms = intent.terms;
  for (const { value } of rankPeople(
    input.people,
    terms,
    input.peopleLimit ?? PEOPLE_LIMIT,
  )) {
    items.push({
      kind: "person",
      key: `person:${value.pubkey}`,
      group: "people",
      action: { kind: "profile", pubkey: value.pubkey },
      person: value,
    });
  }

  for (const { value } of rankNotes(
    input.notes,
    terms,
    input.notesLimit ?? NOTES_LIMIT,
  )) {
    const author = byPubkey.get(value.pubkey);
    items.push({
      kind: "note",
      key: `note:${value.id}`,
      group: "notes",
      action: { kind: "note", id: value.id },
      note: value,
      ...(author ? { author } : {}),
    });
  }

  return items;
}

/**
 * A "go to this profile" row, using the stored profile when there is one.
 *
 * The name is worth the lookup: "Open profile — npub1abc…wxyz" gives the reader no
 * way to tell whether they pasted the key they meant to, and a pasted key is
 * exactly the case where they cannot check by eye.
 */
function profileJump(
  pubkey: string,
  byPubkey: ReadonlyMap<string, SearchPerson>,
): SearchItem {
  const known = byPubkey.get(pubkey);
  if (known) {
    return {
      kind: "person",
      key: `jump:profile:${pubkey}`,
      group: "jump",
      action: { kind: "profile", pubkey },
      person: known,
    };
  }
  return {
    kind: "command",
    key: `jump:profile:${pubkey}`,
    group: "jump",
    action: { kind: "profile", pubkey },
    label: "Open this profile",
    hint: shortNpub({ pubkey }),
  };
}

/** The groups present, in render order, with their rows. */
export function groupItems(items: readonly SearchItem[]): readonly {
  readonly group: SearchGroup;
  readonly items: readonly SearchItem[];
}[] {
  const order: readonly SearchGroup[] = ["jump", "people", "notes"];
  const out: { group: SearchGroup; items: SearchItem[] }[] = [];
  for (const group of order) {
    const rows = items.filter((item) => item.group === group);
    if (rows.length > 0) out.push({ group, items: rows });
  }
  return out;
}
