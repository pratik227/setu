/**
 * Row view models for the articles list.
 *
 * Kept pure and out of the components for the usual reason — a list row must not
 * decide anything while rendering — plus one specific to this screen: **a row
 * must never be blank.** An article with no `title` tag is legal and common
 * (every autosaved first draft is one), and a list that renders it as an empty
 * line gives the author a clickable void where their work should be. So the
 * fallbacks are decided here, once, where they can be tested.
 */

import type { NostrEvent } from "@setu/protocol";
import { getTagValue } from "@setu/protocol";
import { ARTICLE_DRAFT_KIND, readingMinutes } from "./buildArticle";
import { markdownToPlainText } from "./markdown";

/** Shown in place of a missing title. Never an empty string. */
export const UNTITLED = "Untitled";

/** Longest excerpt we build; the row clamps to one line well before this. */
const EXCERPT_CHARS = 180;

export interface ArticleRow {
  /** Event id, for React keys and selection. */
  readonly id: string;
  /** The `d` identifier — the article's stable address across every edit. */
  readonly identifier: string;
  readonly draft: boolean;
  readonly title: string;
  /** True when `title` is the fallback rather than the author's own words. */
  readonly untitled: boolean;
  readonly excerpt: string;
  readonly image?: string;
  /** `published_at` when present, else the event's own timestamp. */
  readonly timestamp: number;
  readonly readingMinutes: number;
  readonly event: NostrEvent;
}

/** The author's title, trimmed, or `undefined` when there is none. */
export function articleTitle(event: NostrEvent): string | undefined {
  const title = getTagValue(event, "title")?.trim();
  return title ? title : undefined;
}

/**
 * One-line excerpt.
 *
 * Prefers the author's own `summary` tag — it is the summary they wrote, and no
 * derived text beats it. Falls back to the body's opening prose, taken through
 * the Markdown parser so that headings, fences and link syntax do not leak into
 * a list row as raw punctuation.
 */
export function articleExcerpt(event: NostrEvent): string {
  const summary = getTagValue(event, "summary")?.trim();
  if (summary) return summary.slice(0, EXCERPT_CHARS);
  return markdownToPlainText(event.content, EXCERPT_CHARS);
}

/**
 * Publication date for display.
 *
 * A published article carries `published_at`, which is the date it claims and the
 * date readers sort by. Drafts carry none, so they fall back to when the event
 * was signed — which for a draft is the last time it was saved, and is what the
 * author wants to see.
 */
export function articleTimestamp(event: NostrEvent): number {
  const raw = getTagValue(event, "published_at");
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : event.created_at;
}

export function toArticleRow(event: NostrEvent): ArticleRow {
  const title = articleTitle(event);
  const image = getTagValue(event, "image")?.trim();
  return {
    id: event.id,
    identifier: getTagValue(event, "d") ?? "",
    draft: event.kind === ARTICLE_DRAFT_KIND,
    title: title ?? UNTITLED,
    untitled: title === undefined,
    excerpt: articleExcerpt(event),
    ...(image ? { image } : {}),
    timestamp: articleTimestamp(event),
    readingMinutes: readingMinutes(event.content),
    event,
  };
}

/**
 * Rows for a list of events, newest first.
 *
 * Deduplicated by `d` identifier: the store already enforces addressable
 * last-write-wins, but events can arrive from a one-off query and a live
 * subscription within the same tick, and one article appearing twice in the
 * author's own list reads as data loss.
 */
export function toArticleRows(
  events: readonly NostrEvent[],
): readonly ArticleRow[] {
  const byAddress = new Map<string, NostrEvent>();
  for (const event of events) {
    const key = `${event.kind}:${getTagValue(event, "d") ?? event.id}`;
    const existing = byAddress.get(key);
    if (!existing || event.created_at > existing.created_at) {
      byAddress.set(key, event);
    }
  }
  return [...byAddress.values()]
    .map(toArticleRow)
    .sort((a, b) => b.timestamp - a.timestamp);
}
