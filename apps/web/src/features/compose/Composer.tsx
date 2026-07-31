import type { NostrEvent } from "@setu/protocol";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  cn,
  Tooltip,
} from "@setu/ui";
import {
  AlertTriangle,
  Hash,
  ImagePlus,
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useSession } from "../identity/SessionProvider";
import { useAuthors } from "../profiles/useAuthors";
import { buildNote } from "./buildNote";
import { EmojiPicker } from "./EmojiPicker";
import { insertAt } from "./emoji";
import { imetaTag, type UploadedMedia } from "./nip96";
import { usePublish } from "./usePublish";
import { ACCEPTED_MEDIA, hostLabel, useUpload } from "./useUpload";

/**
 * Notes have no protocol length limit, but relays impose their own and a
 * multi-thousand-character kind-1 is a long-form article in the wrong kind. The
 * counter warns rather than blocks.
 */
const SOFT_LIMIT = 2000;

/** Refuse to publish text containing a secret key, whatever the user intended. */
const NSEC_PATTERN = /\bnsec1[02-9ac-hj-np-z]{20,}/i;

export interface ComposerProps {
  /** Present when this is a reply rather than a new note. */
  reply?: { parent: NostrEvent; authorName?: string };
  onPosted?(event: NostrEvent): void;
  onCancel?(): void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}

export function Composer({
  reply,
  onPosted,
  onCancel,
  autoFocus = false,
  placeholder,
  className,
}: ComposerProps) {
  const { session } = useSession();
  const { state, publish } = usePublish();
  const [content, setContent] = useState("");
  const [warning, setWarning] = useState<string | undefined>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /*
   * Where the caret is, tracked rather than read on demand.
   *
   * Reading `selectionStart` at insert time looked right and was not: opening the
   * picker is opening a *modal* menu, which moves focus and re-renders, and by
   * the time the handler ran the textarea reported 0. Every emoji landed at the
   * start of the note instead of where the reader was typing.
   *
   * `select` fires on any selection change — clicks, arrow keys, typing, and
   * `setSelectionRange` — so this ref is current the moment focus leaves, which
   * is exactly when it is needed.
   */
  const caret = useRef({ start: 0, end: 0 });

  /** Snapshot the live selection. Called before anything can steal focus. */
  const rememberCaret = useCallback(() => {
    const el = textarea.current;
    if (!el) return;
    caret.current = { start: el.selectionStart, end: el.selectionEnd };
  }, []);
  const upload = useUpload();

  // `imeta` tags for what has been attached, kept alongside the URLs already in
  // the body. Held separately because the tag carries dimensions the body cannot.
  const [attached, setAttached] = useState<readonly UploadedMedia[]>([]);

  /**
   * Insert text at the caret rather than appending.
   *
   * A textarea keeps `selectionStart` while unfocused, which is what makes this
   * work from a dropdown that has taken focus: the caret is read from the DOM at
   * insert time, not tracked in state where it would go stale.
   */
  const insert = useCallback((text: string) => {
    setContent((current) => {
      // The live DOM when the textarea still has focus (typing, the hashtag
      // button); the tracked position when something else does (the picker).
      const el = textarea.current;
      const focused = el !== null && document.activeElement === el;
      const start = focused ? el.selectionStart : caret.current.start;
      const end = focused ? el.selectionEnd : caret.current.end;
      const next = insertAt(current, start, end, text);
      // After React commits the new value the caret would sit at the end, so put
      // it back on the next frame.
      caret.current = { start: next.caret, end: next.caret };
      requestAnimationFrame(() => {
        const node = textarea.current;
        if (!node) return;
        node.setSelectionRange(next.caret, next.caret);
      });
      return next.value;
    });
  }, []);

  const attach = useCallback(
    async (file: File) => {
      const media = await upload.upload(file);
      if (!media) return;
      setAttached((previous) => [...previous, media]);
      // The URL goes in the body because that is what every client renders. The
      // `imeta` tag is metadata *about* it, not a substitute for it.
      insert(
        `${content.endsWith(" ") || content === "" ? "" : " "}${media.url} `,
      );
    },
    [upload, insert, content],
  );

  const authors = useAuthors(session ? [session.pubkey] : []);
  const me = session ? authors.get(session.pubkey) : undefined;

  const busy = state.status === "signing" || state.status === "publishing";
  const leaksKey = NSEC_PATTERN.test(content);
  const tooLong = content.length > SOFT_LIMIT;
  const canPost =
    Boolean(session?.canSign) &&
    content.trim().length > 0 &&
    !busy &&
    !leaksKey;

  const submit = useCallback(async () => {
    if (!canPost) return;
    try {
      const outcome = await publish(
        buildNote({
          content,
          ...(reply ? { reply: { parent: reply.parent } } : {}),
          ...(warning !== undefined ? { contentWarning: warning } : {}),
          // Only for media still referenced in the body: removing the URL from
          // the text and leaving its `imeta` behind would describe an attachment
          // the note does not have.
          ...(attached.length > 0
            ? {
                extraTags: attached
                  .filter((media) => content.includes(media.url))
                  .map((media) => imetaTag(media)),
              }
            : {}),
        }),
      );
      // Clear only on acceptance. If every relay rejected, the text stays in the
      // box — silently discarding a note the network never received is the worst
      // outcome available here.
      if (outcome.accepted) {
        setContent("");
        setWarning(undefined);
        setAttached([]);
        onPosted?.(outcome.event);
      }
    } catch {
      // `state` already carries the failure reason for display.
    }
  }, [canPost, content, publish, reply, warning, attached, onPosted]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Cmd/Ctrl+Enter posts. Plain Enter must insert a newline: notes are
      // multi-line far more often than chat messages are.
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
      if (e.key === "Escape" && onCancel) onCancel();
    },
    [submit, onCancel],
  );

  if (!session) return null;

  if (!session.canSign) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border/50 px-4 py-3",
          "text-xs text-muted-foreground",
          className,
        )}
      >
        <ShieldAlert className="size-4 shrink-0" />
        <span>
          This is a read-only session. Unlock or sign in with a key to post.
        </span>
      </div>
    );
  }

  const remaining = SOFT_LIMIT - content.length;

  return (
    <div className={cn("border-b border-border/50 px-4 py-3", className)}>
      {reply ? (
        <p className="mb-1.5 pl-11 text-xs text-muted-foreground">
          Replying to {reply.authorName ?? "this note"}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Avatar className="shrink-0 self-start">
          {me?.avatarUrl ? <AvatarImage src={me.avatarUrl} alt="" /> : null}
          <AvatarFallback>
            {(me?.displayName ?? "?").slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <textarea
            ref={textarea}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              caret.current = {
                start: e.target.selectionStart,
                end: e.target.selectionEnd,
              };
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              caret.current = {
                start: el.selectionStart,
                end: el.selectionEnd,
              };
            }}
            onKeyDown={onKeyDown}
            // biome-ignore lint/a11y/noAutofocus: focus is the point of opening a composer
            autoFocus={autoFocus}
            rows={reply ? 2 : 3}
            placeholder={
              placeholder ?? (reply ? "Post your reply" : "What's happening?")
            }
            className={cn(
              "w-full resize-none bg-transparent text-base leading-relaxed",
              "placeholder:text-muted-foreground focus:outline-hidden",
            )}
          />

          {warning !== undefined ? (
            <div className="mt-1 flex items-center gap-2 rounded-md bg-warning-bg px-2 py-1">
              <AlertTriangle className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={warning}
                onChange={(e) => setWarning(e.target.value)}
                placeholder="Reason (optional)"
                className="min-w-0 flex-1 bg-transparent text-xs focus:outline-hidden"
              />
              <button
                type="button"
                aria-label="Remove content warning"
                onClick={() => setWarning(undefined)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}

          {leaksKey ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
              <ShieldAlert className="size-3.5 shrink-0" />
              That looks like a secret key. Posting is blocked.
            </p>
          ) : null}

          {state.status === "failed" ? (
            <p className="mt-1 text-xs text-destructive">{state.error}</p>
          ) : null}

          {state.status === "sent" ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Sent to {state.results.filter((r) => r.ok).length} of{" "}
              {state.results.length} relays.
            </p>
          ) : null}

          {upload.state.status === "uploading" ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Uploading {upload.state.name} to {hostLabel(upload.host)}…
            </p>
          ) : null}
          {upload.state.status === "error" ? (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              <span className="flex-1">{upload.state.message}</span>
              <button
                type="button"
                onClick={upload.reset}
                className="shrink-0 underline hover:no-underline"
              >
                Dismiss
              </button>
            </p>
          ) : null}

          <div className="mt-1.5 flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Add content warning"
              aria-pressed={warning !== undefined}
              onClick={() =>
                setWarning((w) => (w === undefined ? "" : undefined))
              }
              className={warning !== undefined ? "text-warning" : undefined}
            >
              <AlertTriangle />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Insert hashtag"
              onClick={() => insert("#")}
            >
              <Hash />
            </Button>

            <EmojiPicker onPick={insert} onBeforeOpen={rememberCaret} />

            {/* A real file input, kept off screen and driven by the button.
                `accept` includes GIF explicitly — posting a GIF is the request
                this exists to answer. */}
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPTED_MEDIA}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so picking the same file twice still fires a change.
                event.target.value = "";
                if (file) void attach(file);
              }}
            />
            <Tooltip label="Attach image, GIF or video">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Attach image, GIF or video"
                disabled={upload.state.status === "uploading"}
                onClick={() => fileInput.current?.click()}
              >
                {upload.state.status === "uploading" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <ImagePlus />
                )}
              </Button>
            </Tooltip>

            <span
              className={cn(
                "ml-auto text-2xs tabular-nums",
                tooLong ? "text-destructive" : "text-muted-foreground",
                // Only show the counter once it is informative.
                content.length < SOFT_LIMIT * 0.75 && "invisible",
              )}
            >
              {remaining}
            </span>

            {onCancel ? (
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
            <Button size="sm" disabled={!canPost} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {reply ? "Reply" : "Post"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
