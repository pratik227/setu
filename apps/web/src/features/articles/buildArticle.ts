/**
 * Long-form articles (NIP-23).
 *
 * Two kinds, one document: **30023** is a published article and **30024** is a
 * draft of one. Both are *addressable*, keyed by a `d` identifier, so editing
 * republishes the same address rather than creating a second article — which is
 * why the `d` tag must survive every edit, and why publishing a draft reuses the
 * draft's identifier instead of minting a new one. Get that wrong and a
 * publish-after-edit leaves the old copy live alongside the new one forever.
 *
 * Content is Markdown by spec. Notably *not* HTML, and not the `nostr:`-riddled
 * plaintext of a kind-1 — though inline `nostr:` references are still legal and
 * we tokenize them on render.
 */

import {
  type EventTemplate,
  getTagValue,
  type NostrEvent,
  tokenizeContent,
} from "@setu/protocol";

/** Published long-form article. */
export const ARTICLE_KIND = 30023;
/** Draft of a long-form article. */
export const ARTICLE_DRAFT_KIND = 30024;

export interface ArticleDraft {
  /**
   * Stable address identifier. Generated once when the article is created and
   * never changed — it is the article's identity across every edit and across
   * the draft→published transition.
   */
  readonly identifier: string;
  readonly title: string;
  /** Markdown body. */
  readonly content: string;
  readonly summary?: string;
  /** Cover image URL. */
  readonly image?: string;
  readonly hashtags?: readonly string[];
  /**
   * Unix seconds of first publication. Preserved across later edits so an
   * updated article does not appear newly written every time it is corrected.
   */
  readonly publishedAt?: number;
}

/** Mint an identifier for a new article. */
export function newArticleIdentifier(
  title: string,
  randomSuffix: string,
): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    // Strip anything that is not a letter, number, or separator, so the
    // identifier stays URL-safe for `naddr` consumers.
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  // The suffix is what keeps two articles with the same title from colliding on
  // one address. It is supplied rather than generated so this stays pure.
  return slug ? `${slug}-${randomSuffix}` : randomSuffix;
}

/** Hashtags mentioned in the body, lowercased and deduped. */
function bodyHashtags(content: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenizeContent(content)) {
    if (token.type === "hashtag") seen.add(token.tag.toLowerCase());
  }
  return [...seen];
}

export interface BuildArticleOptions {
  /** Emit a draft (30024) rather than a published article (30023). */
  readonly asDraft?: boolean;
  /** Unix seconds; used for `published_at` when the draft carries none. */
  readonly now?: number;
}

/**
 * Build the event template for an article.
 *
 * `published_at` is only set on a *published* article: stamping a draft with a
 * publication date claims something untrue, and readers sort by it.
 */
export function buildArticle(
  draft: ArticleDraft,
  options: BuildArticleOptions = {},
): EventTemplate {
  const asDraft = options.asDraft ?? false;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const tags: string[][] = [["d", draft.identifier]];

  const title = draft.title.trim();
  if (title) tags.push(["title", title]);

  const summary = draft.summary?.trim();
  if (summary) tags.push(["summary", summary]);

  const image = draft.image?.trim();
  if (image) tags.push(["image", image]);

  if (!asDraft) {
    // Preserve the original date on re-publish; only a first publish stamps now.
    tags.push(["published_at", String(draft.publishedAt ?? now)]);
  }

  // Explicit tags win, but body hashtags are folded in so `#topic` in the text
  // is discoverable the same way it is in a note.
  const topics = new Set<string>();
  for (const tag of draft.hashtags ?? []) {
    const normalized = tag.toLowerCase().replace(/^#/, "").trim();
    if (normalized) topics.add(normalized);
  }
  for (const tag of bodyHashtags(draft.content)) topics.add(tag);
  for (const tag of topics) tags.push(["t", tag]);

  return {
    kind: asDraft ? ARTICLE_DRAFT_KIND : ARTICLE_KIND,
    content: draft.content,
    tags,
  };
}

/** Read an article event back into the editable draft shape. */
export function parseArticle(event: NostrEvent): ArticleDraft {
  const publishedAtRaw = getTagValue(event, "published_at");
  const publishedAt = publishedAtRaw ? Number(publishedAtRaw) : undefined;
  const hashtags: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === "t" && tag[1]) hashtags.push(tag[1]);
  }
  return {
    identifier: getTagValue(event, "d") ?? "",
    title: getTagValue(event, "title") ?? "",
    content: event.content,
    ...(getTagValue(event, "summary")
      ? { summary: getTagValue(event, "summary") }
      : {}),
    ...(getTagValue(event, "image")
      ? { image: getTagValue(event, "image") }
      : {}),
    ...(hashtags.length > 0 ? { hashtags } : {}),
    ...(publishedAt !== undefined && Number.isFinite(publishedAt)
      ? { publishedAt }
      : {}),
  };
}

/**
 * Word count for the editor.
 *
 * Counts words, not Markdown: fences, URLs and image syntax are dropped first so
 * a code-heavy draft does not report a wildly inflated number.
 */
export function wordCount(markdown: string): number {
  const prose = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const words = prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

/** Reading time in minutes, rounded up, floored at 1 for any content at all. */
export function readingMinutes(markdown: string): number {
  const words = wordCount(markdown);
  if (words === 0) return 0;
  return Math.max(1, Math.ceil(words / 225));
}
