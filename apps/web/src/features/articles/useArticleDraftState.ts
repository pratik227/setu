import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArticleDraft } from "./buildArticle";
import {
  type LocalSaveResult,
  loadLocalDraft,
  saveLocalDraft,
} from "./localArticleStore";

/**
 * Editor state, and the truth about where the text lives.
 *
 * The distinction this hook exists to keep honest: **local and on-relays are two
 * different places, and the editor must never blur them.** Local autosave runs
 * continuously into `localStorage`; a relay draft is an explicit, signed
 * kind-30024. An indicator that says "Saved" without saying which one is a lie
 * the first time the author opens the article on another device.
 *
 * So the state machine has three positions rather than a boolean:
 *
 *  - `unsaved` — the text exists only in this textarea. Closing the tab loses it.
 *  - `local` — autosaved in this browser, and nowhere else. Another device sees
 *    nothing.
 *  - `relays` — a signed event at least one relay accepted. This is the only
 *    position that survives the machine.
 *
 * Autosave is debounced rather than per-keystroke because `localStorage` writes
 * are synchronous and block the main thread; a write on every character makes
 * typing itself stutter in a long article.
 */

/** Autosave idle delay. Long enough to coalesce a sentence of typing. */
const AUTOSAVE_MS = 1200;

export interface ArticleFormState {
  readonly title: string;
  readonly summary: string;
  readonly image: string;
  readonly content: string;
  /** Raw input: comma- or space-separated. Parsed on the way out. */
  readonly hashtags: string;
}

export type ArticleFormField = keyof ArticleFormState;

/** Where the current text actually lives. */
export type ContentLocation = "unsaved" | "local" | "relays";

export interface ArticleDraftSession {
  readonly form: ArticleFormState;
  setField(field: ArticleFormField, value: string): void;
  /** The draft as `buildArticle` wants it, identifier and `publishedAt` intact. */
  readonly draft: ArticleDraft;
  readonly location: ContentLocation;
  /** ms epoch of the last successful local autosave. */
  readonly localSavedAt: number | undefined;
  /** Set when autosave could not write — the UI must stop claiming it did. */
  readonly localSaveError: LocalSaveResult | undefined;
  /**
   * ms epoch of a local autosave that was newer than the relay copy and has
   * been restored over it. The author is told, and can go back.
   */
  readonly restoredFrom: number | undefined;
  /** Throw away the local copy and return to the relay version. */
  discardLocal(): void;
  /** Record that a version reached at least one relay. */
  markOnRelays(draft: ArticleDraft): void;
}

/** Split a hashtag input into normalized, deduped topics. */
export function parseHashtagInput(raw: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[,\s]+/)) {
    const tag = piece.replace(/^#+/, "").trim().toLowerCase();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function formOf(draft: ArticleDraft): ArticleFormState {
  return {
    title: draft.title,
    summary: draft.summary ?? "",
    image: draft.image ?? "",
    content: draft.content,
    hashtags: (draft.hashtags ?? []).map((t) => `#${t}`).join(" "),
  };
}

/**
 * Comparable form of a draft.
 *
 * Compared on *meaning*, not on keystrokes: trailing whitespace in a title and a
 * reordered hashtag list are not changes worth telling the author they have
 * unsaved work over.
 */
function canonical(draft: ArticleDraft): string {
  return JSON.stringify([
    draft.title.trim(),
    draft.summary?.trim() ?? "",
    draft.image?.trim() ?? "",
    draft.content,
    [...(draft.hashtags ?? [])].sort(),
  ]);
}

export interface UseArticleDraftStateOptions {
  readonly pubkey: string | undefined;
  /** The article as loaded, or a freshly minted empty one. */
  readonly initial: ArticleDraft;
  /**
   * ms epoch of the relay event this was loaded from. Absent for a new article,
   * which is what makes every local save on it a strict improvement.
   */
  readonly relaySavedAt?: number;
}

export function useArticleDraftState({
  pubkey,
  initial,
  relaySavedAt,
}: UseArticleDraftStateOptions): ArticleDraftSession {
  // Read the local copy synchronously during the first render rather than in an
  // effect: an effect would paint the relay version first and then replace it,
  // and an author watching their own words get overwritten and restored has no
  // way to know which one won.
  const [initialState] = useState(() => {
    const local =
      pubkey === undefined
        ? undefined
        : loadLocalDraft(pubkey, initial.identifier);
    // Only a *newer* local copy wins. An older one is a stale autosave from
    // before a publish, and restoring it would silently revert the article.
    const newer =
      local !== undefined && local.savedAt > (relaySavedAt ?? 0)
        ? local
        : undefined;
    return {
      form: formOf(newer ?? initial),
      restoredFrom: newer?.savedAt,
      localSavedAt: local?.savedAt,
    };
  });

  const [form, setForm] = useState<ArticleFormState>(initialState.form);
  const [restoredFrom, setRestoredFrom] = useState<number | undefined>(
    initialState.restoredFrom,
  );
  const [localSavedAt, setLocalSavedAt] = useState<number | undefined>(
    initialState.localSavedAt,
  );
  const [localSaveError, setLocalSaveError] = useState<
    LocalSaveResult | undefined
  >(undefined);
  /** Canonical form of the newest version a relay accepted, if any. */
  const [relayBaseline, setRelayBaseline] = useState<string | undefined>(() =>
    relaySavedAt === undefined ? undefined : canonical(initial),
  );

  const setField = useCallback((field: ArticleFormField, value: string) => {
    setForm((prev) =>
      prev[field] === value ? prev : { ...prev, [field]: value },
    );
  }, []);

  const draft = useMemo<ArticleDraft>(() => {
    const hashtags = parseHashtagInput(form.hashtags);
    const summary = form.summary.trim();
    const image = form.image.trim();
    return {
      identifier: initial.identifier,
      title: form.title,
      content: form.content,
      ...(summary ? { summary } : {}),
      ...(image ? { image } : {}),
      ...(hashtags.length > 0 ? { hashtags } : {}),
      ...(initial.publishedAt !== undefined
        ? { publishedAt: initial.publishedAt }
        : {}),
    };
  }, [form, initial.identifier, initial.publishedAt]);

  const currentCanonical = canonical(draft);
  /**
   * Canonical form of what is in `localStorage`. State rather than a ref: the
   * "Saved locally" indicator is derived from it, and a ref mutated inside an
   * effect does not re-render, so the label would lag a keystroke behind the
   * truth it is supposed to be reporting.
   */
  const [savedLocalCanonical, setSavedLocalCanonical] = useState<
    string | undefined
  >(initialState.localSavedAt === undefined ? undefined : currentCanonical);

  const empty = draft.title.trim() === "" && draft.content.trim() === "";

  // Autosave. Debounced, local only, and never for an empty document — an
  // untouched editor must not litter storage with a blank entry per visit.
  useEffect(() => {
    if (pubkey === undefined || empty) return;
    if (savedLocalCanonical === currentCanonical) return;
    const timer = setTimeout(() => {
      const at = Date.now();
      const result = saveLocalDraft(pubkey, draft, at);
      if (result === "ok") {
        setSavedLocalCanonical(currentCanonical);
        setLocalSavedAt(at);
        setLocalSaveError(undefined);
      } else {
        setLocalSaveError(result);
      }
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [pubkey, draft, currentCanonical, savedLocalCanonical, empty]);

  const discardLocal = useCallback(() => {
    setForm(formOf(initial));
    setRestoredFrom(undefined);
    // The local entry is deliberately left in place: `saveLocalDraft` will
    // overwrite it on the next edit, and deleting it here would destroy the
    // author's only copy of text they may still want back.
  }, [initial]);

  const markOnRelays = useCallback((published: ArticleDraft) => {
    setRelayBaseline(canonical(published));
    setRestoredFrom(undefined);
  }, []);

  const location: ContentLocation =
    relayBaseline === currentCanonical
      ? "relays"
      : savedLocalCanonical === currentCanonical
        ? "local"
        : "unsaved";

  return {
    form,
    setField,
    draft,
    location,
    localSavedAt,
    localSaveError,
    restoredFrom,
    discardLocal,
    markOnRelays,
  };
}
