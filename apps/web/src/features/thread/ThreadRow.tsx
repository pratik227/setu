import { encodeNote, truncateNpub } from "@setu/protocol";
import { cn } from "@setu/ui";
import { CornerDownRight, HelpCircle } from "lucide-react";
import type { NoteRowActions } from "../notes/NoteActionRow";
import { NoteCard } from "../notes/NoteCard";
import { useRenderedContent } from "../notes/NoteContent";
import type { NoteView } from "../notes/types";

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
  /** 0 for the focused note and its ancestors, 1+ for nested replies. */
  depth?: number;
  /** The note the thread is opened on: emphasized, and not a link to itself. */
  focused?: boolean;
  /** Parent was never retrieved, so the row says so instead of implying depth. */
  orphaned?: boolean;
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
  depth = 0,
  focused = false,
  orphaned = false,
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
}: ThreadRowProps) {
  const { body, media } = useRenderedContent({
    content: note.content,
    onOpenHashtag,
  });

  // Media parsed out of the content stands in for imeta tags until the store
  // supplies them; explicit media on the view model always wins.
  const withMedia = note.media ? note : { ...note, media };

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
      <NoteCard
        note={withMedia}
        body={body}
        {...(actions ? { actions } : {})}
        onOpenProfile={onOpenProfile}
        {...(focused ? {} : { onOpenThread })}
        className={cn(
          focused &&
            "bg-muted/40 border-l-2 border-l-primary/70 hover:bg-muted/40",
        )}
      />
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
