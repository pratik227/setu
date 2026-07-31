/**
 * Profile tab definitions — pure, so the rules are testable without a relay.
 *
 * Two of the four tabs cannot be expressed as a NIP-01 filter. "Replies" and
 * "notes only" both depend on NIP-10 `e` tags, and "has media" depends on the
 * note's content; relays filter on kinds, authors, tags and time, not on
 * structure. So each tab carries a kind list *and* an optional row predicate,
 * and the predicate runs over feed rows the shared feed engine already produced.
 *
 * The alternative — a second feed implementation per tab — would duplicate
 * staging, `until` pagination and repost coalescing four times over.
 */

import type { FeedEntry } from "@setu/core";
import {
  classifyUrl,
  getTagged,
  type HasTags,
  isReply,
  Kind,
} from "@setu/protocol";

export type ProfileTabId = "notes" | "replies" | "media" | "reads";

export interface ProfileTabDefinition {
  readonly id: ProfileTabId;
  readonly label: string;
  /** Kinds to ask relays for. */
  readonly kinds: readonly number[];
  /** Row predicate for what a relay filter cannot express. Stable reference. */
  readonly entryFilter?: (entry: FeedEntry) => boolean;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}

/** URLs in note text, loosely. Trailing punctuation is trimmed below. */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * Does this event show an image or a video?
 *
 * NIP-92 `imeta` tags are checked first because they are the author's explicit
 * declaration; a bare URL in the body is the older convention and still by far
 * the most common, so both count. Extension sniffing is what `classifyUrl`
 * already does for the renderer, and using the same function keeps the Media tab
 * from disagreeing with what the note actually renders.
 */
export function hasMedia(
  event: HasTags & { readonly content: string },
): boolean {
  for (const tag of getTagged(event, "imeta")) {
    for (const part of tag) {
      if (!part.startsWith("url ")) continue;
      if (classifyUrl(part.slice(4).trim()) !== "url") return true;
    }
  }
  for (const match of event.content.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (classifyUrl(url) !== "url") return true;
  }
  return false;
}

/**
 * A repost row is always "a note", never "a reply": the kind-6 carries an `e`
 * tag pointing at its target, so a naive reply test would file every repost
 * under Replies and empty the Notes tab.
 */
function isTopLevelRow(entry: FeedEntry): boolean {
  if (entry.kind === "repost") return true;
  return !isReply(entry.event);
}

function isReplyRow(entry: FeedEntry): boolean {
  return entry.kind === "note" && isReply(entry.event);
}

function isMediaRow(entry: FeedEntry): boolean {
  const source =
    entry.kind === "repost" ? (entry.target ?? entry.event) : entry.event;
  return hasMedia(source);
}

export const PROFILE_TABS: readonly ProfileTabDefinition[] = [
  {
    id: "notes",
    label: "Notes",
    // Reposts belong on a profile's main timeline, and the feed engine already
    // coalesces N reposts of one target into a single row.
    kinds: [Kind.ShortTextNote, Kind.Repost],
    entryFilter: isTopLevelRow,
    emptyTitle: "No notes yet",
    emptyDescription:
      "Nothing top-level from this author has reached us. Their write relays may not be in the read set.",
  },
  {
    id: "replies",
    label: "Replies",
    kinds: [Kind.ShortTextNote],
    entryFilter: isReplyRow,
    emptyTitle: "No replies yet",
    emptyDescription: "No replies from this author have reached us.",
  },
  {
    id: "media",
    label: "Media",
    kinds: [Kind.ShortTextNote, Kind.Repost],
    entryFilter: isMediaRow,
    emptyTitle: "No media yet",
    emptyDescription:
      "No notes from this author carry an image or a video. Media is detected from imeta tags and from links in the note body.",
  },
  {
    id: "reads",
    label: "Reads",
    // NIP-23 long-form. No predicate: the kind is the whole definition.
    kinds: [Kind.LongFormArticle],
    emptyTitle: "No long-form posts",
    emptyDescription:
      "This author has published no NIP-23 articles that we hold.",
  },
];

/** Look up a tab by id, falling back to the first so state can never be void. */
export function findProfileTab(id: string): ProfileTabDefinition {
  return (
    PROFILE_TABS.find((tab) => tab.id === id) ??
    (PROFILE_TABS[0] as ProfileTabDefinition)
  );
}
