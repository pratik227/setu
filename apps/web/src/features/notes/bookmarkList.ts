/**
 * Editing a bookmark list (NIP-51 kind 10003) without destroying it.
 *
 * A kind-10003 is *replaceable*, exactly like a follow list: publishing one
 * replaces the previous entirely, and there is no "add a bookmark" operation on
 * the network — only "here is my whole list now". So this module is the same
 * discipline as `identity/followList.ts`, applied to a different tag, and for the
 * same reason: every write is a chance to silently delete everything.
 *
 * Three ways to lose the list, all prevented here:
 *
 *  1. **Writing from a stale snapshot.** Anything bookmarked since our copy was
 *     fetched disappears. Mitigated by the caller (`useBookmarks`) re-fetching
 *     before every write; this module's job is to never invent a list from
 *     nothing.
 *  2. **Dropping non-`e` tags.** A kind-10003 legitimately holds `a` tags
 *     (bookmarked articles), `t` tags (hashtags) and `r` tags (URLs). A rebuild
 *     that emits only `e` tags deletes every bookmarked article and link as a
 *     side effect of bookmarking one note.
 *  3. **Dropping `content`.** NIP-51 puts *private* bookmarks in `content` as an
 *     encrypted blob. It looks like an empty field to a client that does not
 *     implement them, and blanking it destroys every private bookmark the user
 *     has — irreversibly, because we cannot read it to put it back.
 */

import type { EventTemplate, Hex32, NostrEvent } from "@setu/protocol";
import { Kind } from "@setu/protocol";

/** Why a bookmark edit was refused. */
export type BookmarkEditRefusal =
  /** No kind-10003 was found and we are not certain none exists. */
  | "unverified-absence"
  /** The note is already in the requested state; nothing to write. */
  | "no-change";

export type BookmarkEditResult =
  | { readonly ok: true; readonly template: EventTemplate }
  | { readonly ok: false; readonly reason: BookmarkEditRefusal };

export interface BookmarkEditInput {
  /** The newest kind-10003 we could find, or undefined if none exists. */
  readonly current: NostrEvent | undefined;
  /**
   * True only when every queried relay answered and none held a kind-10003.
   * Required to create a first list: "nobody returned one" and "we did not
   * finish asking" are indistinguishable from a partial result, and treating the
   * second as the first replaces a real list with a one-entry list.
   */
  readonly absenceConfirmed: boolean;
  readonly target: Hex32;
  readonly action: "add" | "remove";
  /** Relay hint stored alongside a newly added `e` tag, when known. */
  readonly relayHint?: string;
}

/** Does this list's `e` tags include `id`? */
export function isBookmarked(
  event: NostrEvent | undefined,
  id: Hex32,
): boolean {
  if (!event) return false;
  return event.tags.some((tag) => tag[0] === "e" && tag[1] === id);
}

/** Bookmarked event ids, in list order, deduped. */
export function bookmarkedIds(event: NostrEvent | undefined): Hex32[] {
  if (!event) return [];
  const seen = new Set<Hex32>();
  const out: Hex32[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "e") continue;
    const id = tag[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Build the replacement kind-10003 for adding or removing one bookmark.
 *
 * The returned template is the *entire* new list. Everything not explicitly
 * changed is copied through byte-for-byte.
 */
export function editBookmarkList(input: BookmarkEditInput): BookmarkEditResult {
  const { current, absenceConfirmed, target, action, relayHint } = input;

  if (!current && !absenceConfirmed) {
    // Refusing is the whole point. A first bookmark that overwrites a list we
    // failed to fetch is indistinguishable, afterwards, from the user having
    // deleted every bookmark they had.
    return { ok: false, reason: "unverified-absence" };
  }

  const already = isBookmarked(current, target);
  if (action === "add" && already) return { ok: false, reason: "no-change" };
  if (action === "remove" && !already) {
    return { ok: false, reason: "no-change" };
  }

  const existingTags = current?.tags ?? [];
  const tags: string[][] = [];

  if (action === "remove") {
    // Copy every tag except the target's `e` entries. Duplicated entries for the
    // same id are all removed, or the un-bookmark silently does nothing.
    for (const tag of existingTags) {
      if (tag[0] === "e" && tag[1] === target) continue;
      tags.push([...tag]);
    }
  } else {
    for (const tag of existingTags) tags.push([...tag]);
    // Append rather than insert: order in a bookmark list is not meaningful to
    // the protocol, and appending leaves every existing entry at its original
    // index, which keeps diffs between consecutive versions readable.
    tags.push(relayHint ? ["e", target, relayHint] : ["e", target]);
  }

  return {
    ok: true,
    template: {
      kind: Kind.Bookmarks,
      // Carried through verbatim. This field holds encrypted *private*
      // bookmarks; regenerating or blanking it destroys them with no way back.
      content: current?.content ?? "",
      tags,
    },
  };
}

/**
 * Sanity check before publishing: refuse a write that loses an implausible
 * number of bookmarks.
 *
 * A last line of defence against a bug upstream of here. Going from 300
 * bookmarks to 1 is never a user intent expressed through a bookmark button, so
 * it is treated as a defect and blocked rather than published.
 */
export function isPlausibleBookmarkWrite(
  before: NostrEvent | undefined,
  template: EventTemplate,
): boolean {
  const previous = bookmarkedIds(before).length;
  const next = (template.tags ?? []).filter((tag) => tag[0] === "e").length;
  if (Math.abs(next - previous) > 1) return false;
  // The other half of the list lives outside `e` tags. A write that dropped the
  // bookmarked articles and links would pass the count check above, because it
  // moves the note count by exactly one.
  const nonEventTagsBefore = (before?.tags ?? []).filter(
    (tag) => tag[0] !== "e",
  ).length;
  const nonEventTagsAfter = (template.tags ?? []).filter(
    (tag) => tag[0] !== "e",
  ).length;
  if (nonEventTagsAfter < nonEventTagsBefore) return false;
  // And private bookmarks live in `content`; losing it is unrecoverable.
  return !(before && before.content !== "" && template.content === "");
}
