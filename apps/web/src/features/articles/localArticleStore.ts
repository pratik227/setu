/**
 * Local autosave for articles in progress.
 *
 * **This store never touches a relay, and relay drafts never touch this store.**
 * The distinction is the whole point of the module and must not be blurred:
 *
 *  - *Local autosave* is continuous and free. It fires every couple of seconds
 *    while the author types, and it exists so that a closed tab, a reload or a
 *    crash does not cost an afternoon of writing.
 *  - *A relay draft* (kind 30024) is an explicit, deliberate act. It is a signed
 *    event published to every relay the author writes to.
 *
 * Autosaving by publishing a kind-30024 every few seconds would sign and
 * broadcast hundreds of events per article to every relay in the author's write
 * set — a self-inflicted flood that relays would rate-limit or ban for, and that
 * makes the author's own draft history unreadable. So autosave is local, and
 * the UI says which of the two states the text is actually in.
 *
 * ## Key scheme
 *
 * ```
 * setu-article-draft:<pubkey-hex>:<identifier>
 * ```
 *
 * Scoped **per pubkey** because two accounts sharing a browser must not see each
 * other's unpublished writing, and **per identifier** because the identifier is
 * the article's address — the same key across an edit is precisely what makes an
 * autosave resume the right article rather than start a second one. Signing out
 * does not clear these: unpublished writing surviving a sign-out is the point.
 */

import type { ArticleDraft } from "./buildArticle";

const KEY_PREFIX = "setu-article-draft";

/**
 * Largest entry we will write, in characters.
 *
 * `localStorage` is a single origin-wide quota of about 5MB. One runaway article
 * that fills it does not merely fail to save — it makes every *other* write on
 * the origin fail too, including the session record. Refusing early keeps one
 * document from evicting everything else.
 */
export const MAX_LOCAL_DRAFT_CHARS = 256_000;

export interface LocalArticleDraft extends ArticleDraft {
  /** Milliseconds since the epoch of the last local save. */
  readonly savedAt: number;
}

/**
 * The slice of `Storage` this module needs.
 *
 * Injectable so the store is testable without a DOM, and so a caller can scope
 * it elsewhere later without this module learning about it.
 */
export interface LocalDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

/** `localStorage`, or undefined where it is unavailable or blocked. */
export function defaultLocalDraftStorage(): LocalDraftStorage | undefined {
  try {
    // Private-browsing modes and hardened configurations both make the property
    // access itself throw, not just the write.
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The storage key for one author's copy of one article. */
export function localDraftKey(pubkey: string, identifier: string): string {
  return `${KEY_PREFIX}:${pubkey}:${identifier}`;
}

function isLocalDraft(value: unknown): value is LocalArticleDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.identifier === "string" &&
    v.identifier !== "" &&
    typeof v.title === "string" &&
    typeof v.content === "string" &&
    typeof v.savedAt === "number" &&
    Number.isFinite(v.savedAt)
  );
}

/** Drop optional fields that are absent, so a round trip is stable. */
function serialize(draft: ArticleDraft, savedAt: number): string {
  const payload: LocalArticleDraft = {
    identifier: draft.identifier,
    title: draft.title,
    content: draft.content,
    ...(draft.summary !== undefined ? { summary: draft.summary } : {}),
    ...(draft.image !== undefined ? { image: draft.image } : {}),
    ...(draft.hashtags !== undefined && draft.hashtags.length > 0
      ? { hashtags: [...draft.hashtags] }
      : {}),
    ...(draft.publishedAt !== undefined
      ? { publishedAt: draft.publishedAt }
      : {}),
    savedAt,
  };
  return JSON.stringify(payload);
}

/** Why a save did not happen. `"ok"` means it did. */
export type LocalSaveResult = "ok" | "unavailable" | "too-large" | "failed";

/**
 * Write one article to local storage.
 *
 * Never throws: autosave runs on a timer behind the editor, and an exception
 * from a full disk would surface as a crashed editor rather than as the minor
 * degradation it actually is. The result says what happened so the UI can stop
 * claiming the text is saved locally when it is not.
 */
export function saveLocalDraft(
  pubkey: string,
  draft: ArticleDraft,
  savedAt: number = Date.now(),
  storage: LocalDraftStorage | undefined = defaultLocalDraftStorage(),
): LocalSaveResult {
  if (!storage) return "unavailable";
  if (!pubkey || !draft.identifier) return "failed";
  const payload = serialize(draft, savedAt);
  if (payload.length > MAX_LOCAL_DRAFT_CHARS) return "too-large";
  try {
    storage.setItem(localDraftKey(pubkey, draft.identifier), payload);
    return "ok";
  } catch {
    // Quota exceeded, or storage disabled mid-session.
    return "failed";
  }
}

/**
 * Read one article back.
 *
 * A corrupt, truncated, oversized or foreign-shaped entry is treated as absent.
 * The alternative — throwing, or handing back a half-populated object — turns
 * one bad `localStorage` row into an editor that cannot open at all, and the row
 * may well have been written by a different version of this app.
 */
export function loadLocalDraft(
  pubkey: string,
  identifier: string,
  storage: LocalDraftStorage | undefined = defaultLocalDraftStorage(),
): LocalArticleDraft | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(localDraftKey(pubkey, identifier));
    if (raw === null || raw.length > MAX_LOCAL_DRAFT_CHARS) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isLocalDraft(parsed)) return undefined;
    // Trust the key over the payload: a mismatched `identifier` inside the
    // value would otherwise let one entry masquerade as another article.
    return parsed.identifier === identifier ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every locally autosaved article for one author, newest save first. */
export function listLocalDrafts(
  pubkey: string,
  storage: LocalDraftStorage | undefined = defaultLocalDraftStorage(),
): readonly LocalArticleDraft[] {
  if (!storage || !pubkey) return [];
  const prefix = `${KEY_PREFIX}:${pubkey}:`;
  const out: LocalArticleDraft[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || !key.startsWith(prefix)) continue;
      const draft = loadLocalDraft(pubkey, key.slice(prefix.length), storage);
      if (draft) out.push(draft);
    }
  } catch {
    // A storage that throws mid-enumeration yields what was read so far rather
    // than nothing: a partial list is strictly better than a lost draft.
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Forget the local copy.
 *
 * Called once a version of the article is confirmed to be on at least one relay:
 * keeping a local copy after that leaves the editor able to "restore" a stale
 * autosave over newer published text.
 */
export function deleteLocalDraft(
  pubkey: string,
  identifier: string,
  storage: LocalDraftStorage | undefined = defaultLocalDraftStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(localDraftKey(pubkey, identifier));
  } catch {
    // Nothing to do: the in-memory editor state is authoritative for this tab.
  }
}
