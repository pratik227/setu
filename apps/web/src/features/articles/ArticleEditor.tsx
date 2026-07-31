import type { PublishResult } from "@setu/core";
import type { NostrEvent } from "@setu/protocol";
import { Badge, Button, cn } from "@setu/ui";
import {
  CloudOff,
  Eye,
  HardDriveDownload,
  Loader2,
  Pencil,
  Send,
  ShieldAlert,
  X,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { usePublish } from "../compose/usePublish";
import { relativeTime } from "../notes/relativeTime";
import { ArticleEditorFields } from "./ArticleEditorFields";
import {
  type ArticleDraft,
  buildArticle,
  readingMinutes,
  wordCount,
} from "./buildArticle";
import { EditorToolbar, runToolbarAction } from "./EditorToolbar";
import { Markdown } from "./MarkdownView";
import { useArticleDraftState } from "./useArticleDraftState";

/**
 * The article editor.
 *
 * Two things here are worth stating because both are easy to get subtly wrong and
 * neither shows up in a screenshot:
 *
 * 1. **Publishing reuses the loaded draft's `d` identifier and preserves
 *    `published_at`.** The identifier is the article's address, so minting a
 *    fresh one on publish leaves the old draft live forever beside the new
 *    article, at a different address, with no way to reconcile them. This
 *    component therefore threads the loaded `ArticleDraft` through to
 *    `buildArticle` rather than constructing one; `buildArticle` owns the tag
 *    rules and needs the identifier to already be right.
 *
 * 2. **Relay outcomes are reported per relay and never collapsed to "saved".** A
 *    publish that four relays rejected is a failure even though the button was
 *    pressed, and the author has to know before they close the tab believing
 *    their work is on the network.
 *
 * Autosave is local-only; see `localArticleStore` for why publishing a kind-30024
 * every few seconds is not an option.
 */

export interface ArticleEditorProps {
  /** The article being edited: loaded from an event, or freshly minted. */
  initial: ArticleDraft;
  /** Signed-in author. Absent means read-only rendering. */
  pubkey: string | undefined;
  canSign: boolean;
  /** ms epoch of the relay event this was loaded from; absent for a new article. */
  relaySavedAt?: number;
  /** True when the article being edited already exists as a published 30023. */
  alreadyPublished?: boolean;
  onPublished?(event: NostrEvent): void;
  onClose?(): void;
}

type PendingAction = "draft" | "publish";

/** Per-relay verdicts, so a partial success reads as one. */
function RelayOutcome({
  results,
  action,
}: {
  results: readonly PublishResult[];
  action: PendingAction;
}) {
  const accepted = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);
  const noun = action === "draft" ? "Draft" : "Article";

  return (
    <div className="space-y-1">
      <p
        className={cn(
          "text-xs",
          accepted.length === 0 ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {accepted.length === 0
          ? `${noun} was rejected by all ${results.length} relays.`
          : `${noun} sent to ${accepted.length} of ${results.length} relays.`}
      </p>
      {rejected.length > 0 ? (
        <ul className="space-y-0.5">
          {rejected.map((result) => (
            <li key={result.relay} className="text-2xs text-muted-foreground">
              <span className="font-medium">{result.relay}</span>
              {": "}
              {/* The relay's own words. Swallowing them leaves the author with
                  nothing to act on. */}
              {result.message ?? "rejected without a reason"}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Where the text lives right now, said plainly. */
function LocationBadge({
  location,
  localSavedAt,
  failed,
}: {
  location: "unsaved" | "local" | "relays";
  localSavedAt: number | undefined;
  failed: boolean;
}) {
  if (failed) {
    return (
      <span className="flex items-center gap-1.5 text-2xs text-destructive">
        <CloudOff className="size-3" />
        Could not autosave in this browser
      </span>
    );
  }
  if (location === "relays") {
    return (
      <span className="text-2xs text-muted-foreground">
        Saved on your relays
      </span>
    );
  }
  if (location === "local") {
    return (
      <span className="text-2xs text-muted-foreground">
        Saved in this browser only
        {localSavedAt !== undefined
          ? ` · ${relativeTime(Math.floor(localSavedAt / 1000))}`
          : ""}
        {" · not on any relay"}
      </span>
    );
  }
  return <span className="text-2xs text-warning">Unsaved changes</span>;
}

export function ArticleEditor({
  initial,
  pubkey,
  canSign,
  relaySavedAt,
  alreadyPublished = false,
  onPublished,
  onClose,
}: ArticleEditorProps) {
  const session = useArticleDraftState({
    pubkey,
    initial,
    ...(relaySavedAt !== undefined ? { relaySavedAt } : {}),
  });
  const { state, publish, reset } = usePublish();
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState<PendingAction | undefined>();
  const [lastAction, setLastAction] = useState<PendingAction | undefined>();
  const textarea = useRef<HTMLTextAreaElement>(null);

  const { form, setField, draft, location } = session;
  const words = wordCount(form.content);
  const minutes = readingMinutes(form.content);
  const busy = state.status === "signing" || state.status === "publishing";
  const hasContent = form.title.trim() !== "" || form.content.trim() !== "";

  const send = useCallback(
    async (action: PendingAction) => {
      if (!canSign || !hasContent) return;
      setPending(action);
      setLastAction(action);
      reset();
      try {
        // `buildArticle` receives the draft as loaded — identifier and
        // `published_at` already correct — so a publish updates the article's
        // existing address instead of creating a second one.
        const outcome = await publish(
          buildArticle(draft, { asDraft: action === "draft" }),
        );
        // Only acceptance moves the "where does this live" needle. Reporting
        // success on a rejected publish is the failure this whole screen is
        // arranged to avoid.
        if (outcome.accepted) {
          session.markOnRelays(draft);
          onPublished?.(outcome.event);
        }
      } catch {
        // `state` carries the reason; signing was declined or failed.
      } finally {
        setPending(undefined);
      }
    },
    [canSign, hasContent, publish, reset, draft, session, onPublished],
  );

  const onBodyKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const action =
        key === "b"
          ? "bold"
          : key === "i"
            ? "italic"
            : key === "k"
              ? "link"
              : undefined;
      if (!action) return;
      event.preventDefault();
      // The same path the buttons take, so the caret behaves identically.
      runToolbarAction(textarea.current, form.content, action, (next) =>
        setField("content", next),
      );
    },
    [form.content, setField],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
        <Badge variant={alreadyPublished ? "secondary" : "outline"}>
          {alreadyPublished ? "Published" : "Draft"}
        </Badge>
        <LocationBadge
          location={location}
          localSavedAt={session.localSavedAt}
          failed={session.localSaveError !== undefined}
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={preview}
            onClick={() => setPreview((v) => !v)}
          >
            {preview ? <Pencil /> : <Eye />}
            {preview ? "Edit" : "Preview"}
          </Button>
          {onClose ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close editor"
              onClick={onClose}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </div>

      {session.restoredFrom !== undefined ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-warning-bg px-4 py-2">
          <p className="text-xs text-muted-foreground">
            Restored newer changes autosaved in this browser{" "}
            {relativeTime(Math.floor(session.restoredFrom / 1000))} — they were
            never sent to a relay.
          </p>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={session.discardLocal}
          >
            Use the relay version
          </Button>
        </div>
      ) : null}

      {!canSign ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
          <ShieldAlert className="size-4 shrink-0" />
          This is a read-only session. You can write and autosave locally, but
          nothing can be signed or published.
        </div>
      ) : null}

      <div className="setu-scroll min-h-0 flex-1 px-4 py-4">
        <div className="setu-feed-column space-y-4">
          {preview ? (
            // Rendered through the same component a reader gets, so the preview
            // cannot flatter the article.
            <Markdown source={form.content} />
          ) : (
            <>
              <ArticleEditorFields form={form} onChange={setField} />

              <div className="overflow-hidden rounded-lg border border-input/40">
                <EditorToolbar
                  textarea={textarea}
                  value={form.content}
                  onChange={(next) => setField("content", next)}
                />
                <textarea
                  ref={textarea}
                  value={form.content}
                  onChange={(e) => setField("content", e.target.value)}
                  onKeyDown={onBodyKeyDown}
                  rows={20}
                  spellCheck
                  placeholder="Write in Markdown…"
                  className={cn(
                    "w-full resize-y bg-background px-3 py-3",
                    "font-mono text-sm leading-relaxed",
                    "placeholder:text-muted-foreground focus:outline-hidden",
                  )}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 space-y-2 border-t border-border/60 px-4 py-3">
        {state.status === "failed" ? (
          <p className="text-xs text-destructive">{state.error}</p>
        ) : null}
        {state.status === "sent" && lastAction ? (
          <RelayOutcome results={state.results} action={lastAction} />
        ) : null}

        <div className="flex items-center gap-3">
          <span className="text-2xs tabular-nums text-muted-foreground">
            {words} {words === 1 ? "word" : "words"}
            {minutes > 0 ? ` · ${minutes} min read` : ""}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canSign || !hasContent || busy}
              onClick={() => void send("draft")}
            >
              {pending === "draft" && busy ? (
                <Loader2 className="animate-spin" />
              ) : (
                <HardDriveDownload />
              )}
              Save draft
            </Button>
            <Button
              size="sm"
              disabled={!canSign || !hasContent || busy}
              onClick={() => void send("publish")}
            >
              {pending === "publish" && busy ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Send />
              )}
              {alreadyPublished ? "Update" : "Publish"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
