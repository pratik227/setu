import type { MuteReason } from "@setu/core";
import { encodeNote, truncateNpub } from "@setu/protocol";
import { Button, cn } from "@setu/ui";
import { CornerDownRight, EyeOff, HelpCircle } from "lucide-react";
import { useState } from "react";
import { useSession } from "../identity/SessionProvider";
import type { NoteRowActions, NoteRowStatus } from "../notes/NoteActionRow";
import { NoteCard } from "../notes/NoteCard";
import { useRenderedContent } from "../notes/NoteContent";
import { ReactionRow } from "../notes/ReactionRow";
import type { NoteView } from "../notes/types";
import { useNoteReactions } from "../notes/useNoteReactions";

/**
 * Indentation per nesting level, capped by the tree builder.
 *
 * A lookup rather than arithmetic so the classes are literal and Tailwind can
 * see them. The panel is ~380px wide: past three steps the text column would be
 * narrower than the avatar beside it, which is why depth is clamped upstream
 * instead of being allowed to grow here.
 */
const INDENT_CLASS = ["", "pl-3", "pl-6", "pl-9"] as const;

function indentClass(depth: number): string {
  const clamped = Math.max(0, Math.min(depth, INDENT_CLASS.length - 1));
  return INDENT_CLASS[clamped] as string;
}

export interface ThreadRowProps {
  note: NoteView;
  /** Interaction wiring; absent renders counts without controls. */
  actions?: NoteRowActions;
  /** This row's own in-flight/notice/error state, if it has any. */
  status?: NoteRowStatus;
  /** 0 for the focused note and its ancestors, 1+ for nested replies. */
  depth?: number;
  /** The note the thread is opened on: emphasized, and not a link to itself. */
  focused?: boolean;
  /** Parent was never retrieved, so the row says so instead of implying depth. */
  orphaned?: boolean;
  /**
   * Which mute rule covers this note, when one does. Renders collapsed.
   *
   * The row is still *here* — see `ThreadReply.mutedReason` for why removing it would
   * orphan the replies below — and can still be expanded, because a mute is a reading
   * preference and not a seal.
   */
  mutedReason?: MuteReason;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}

/**
 * One note in a thread.
 *
 * A component rather than a `.map` body because `useRenderedContent` is a hook:
 * tokenization has to be memoized per note, and a loop cannot hold hooks.
 */
export function ThreadRow({
  note,
  actions,
  status,
  depth = 0,
  focused = false,
  orphaned = false,
  mutedReason,
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
}: ThreadRowProps) {
  /*
   * Revealed per row, and reset when the row stops being muted.
   *
   * `useState` keyed on nothing is deliberate: revealing is a decision about *this*
   * reading of the thread, not a preference. Editing the mute list rebuilds the tree
   * and the row unmounts, which is the correct forgetting.
   */
  const [revealed, setRevealed] = useState(false);
  const hidden = mutedReason !== undefined && !revealed;
  // Tags, not just content: without them a deprecated `#[2]` mention renders as
  // those literal characters, and a quote repost carrying only a `q` tag has
  // nothing for the renderer to embed. Same gap the feed row had.
  const { body, media } = useRenderedContent({
    content: note.content,
    tags: note.tags,
    onOpenHashtag,
  });

  // Media parsed out of the content stands in for imeta tags until the store
  // supplies them; explicit media on the view model always wins.
  const withMedia = note.media ? note : { ...note, media };

  /*
   * The per-emoji breakdown, on the focused note only.
   *
   * Not on every row, and the reason is a cost rather than a design preference:
   * `useNoteReactions` installs a store observer per note, so a thread with forty
   * replies would install forty of them and each one is another callback the store
   * fans out to on every write. The focused note is the one a reader is actually
   * looking at, and it is always inside the interaction tracker's window — so the
   * kind-7s are already in the store and this costs no relay traffic at all.
   *
   * The empty string is what makes the hook a no-op for an unfocused row; the hook
   * still runs, because hook order cannot be conditional.
   */
  const { session } = useSession();
  const reactions = useNoteReactions(focused ? note.id : "", session?.pubkey);

  return (
    <div
      className={cn(
        depth > 0 && "border-l border-border/50",
        indentClass(depth),
      )}
    >
      {orphaned ? (
        <p className="flex items-center gap-1.5 px-4 pt-2 text-2xs text-muted-foreground">
          <CornerDownRight className="size-3 shrink-0" />
          Replies to a note we could not retrieve
        </p>
      ) : null}
      {hidden ? (
        <MutedRowPlaceholder
          reason={mutedReason as MuteReason}
          author={note.author.displayName}
          onReveal={() => setRevealed(true)}
        />
      ) : (
        <>
          {mutedReason !== undefined ? (
            <p className="flex items-center gap-1.5 px-4 pt-2 text-2xs text-muted-foreground">
              <EyeOff aria-hidden className="size-3 shrink-0" />
              {mutedLabel(mutedReason)} — shown because you asked
            </p>
          ) : null}
          <NoteCard
            note={withMedia}
            body={body}
            {...(focused
              ? { reactions: <ReactionRow reactions={reactions} /> }
              : {})}
            {...(actions ? { actions } : {})}
            {...(status ? { status } : {})}
            onOpenProfile={onOpenProfile}
            {...(focused ? {} : { onOpenThread })}
            className={cn(
              focused &&
                "bg-muted/40 border-l-2 border-l-primary/70 hover:bg-muted/40",
            )}
          />
        </>
      )}
    </div>
  );
}

/** How to name the rule that hid a row, in the reader's terms. */
function mutedLabel(reason: MuteReason): string {
  switch (reason) {
    case "author":
      return "Muted account";
    case "hashtag":
      return "Muted hashtag";
    case "word":
      return "Muted word";
    case "thread":
      return "Muted thread";
  }
}

/**
 * A muted reply, collapsed but present.
 *
 * Present because the tree needs it: removing the node reparents every reply below it
 * (see `ThreadReply.mutedReason`). Expandable because a mute is a reading preference
 * the reader set, not a restriction placed on them — and in a thread they are often
 * reading precisely to follow who said what.
 *
 * The rule is named rather than just "hidden": "muted word" tells the reader which of
 * their own settings did this and therefore what to change, while "hidden" invites
 * them to file a bug.
 */
function MutedRowPlaceholder({
  reason,
  author,
  onReveal,
}: {
  reason: MuteReason;
  author: string;
  onReveal(): void;
}) {
  return (
    <div className="border-b border-border/50 px-4 py-2.5">
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2">
        <EyeOff
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <p className="min-w-0 flex-1 text-2xs text-muted-foreground">
          <span className="font-medium">{mutedLabel(reason)}</span>
          {reason === "author" ? ` — ${author}` : null}
        </p>
        <Button variant="ghost" size="xs" onClick={onReveal}>
          Show
        </Button>
      </div>
    </div>
  );
}

/**
 * Stand-in for an ancestor we know exists but do not hold.
 *
 * Rendered explicitly rather than skipped. A thread with a silent gap reads as
 * if the reply below it answered the note above it, which is a different
 * conversation — and every relay we asked genuinely may not have the event, so
 * saying "not retrieved" is the only honest option.
 */
export function MissingNoteRow({
  id,
  depth = 0,
}: {
  id: string;
  depth?: number;
}) {
  const encoded = encodeNote(id);
  const label = encoded ? truncateNpub(encoded, 8) : `${id.slice(0, 12)}…`;

  return (
    <div
      className={cn(
        depth > 0 && "border-l border-border/50",
        indentClass(depth),
      )}
    >
      <div className="border-b border-border/50 px-4 py-3">
        <div className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2.5">
          <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs font-medium">Note unavailable</p>
            <p className="text-2xs text-muted-foreground">
              No relay we asked returned{" "}
              <span className="font-mono break-all">{label}</span>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
