import { cn } from "@setu/ui";
import {
  Bookmark,
  Heart,
  Link2,
  Loader2,
  MessageSquare,
  Repeat2,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { countLabel } from "./relativeTime";
import type { NoteView } from "./types";

/**
 * What a note row needs to act on a note.
 *
 * One object rather than a dozen props threaded through the feed: the row is
 * three components deep, and every handler added would otherwise be a change to
 * each layer between. Handlers take the note id because a `NoteView` is a render
 * model — the hook behind this resolves the id back to the event.
 *
 * Capabilities only, and deliberately: this object holds nothing that changes
 * while a row is idle, so it keeps one identity for the life of a surface and a
 * memoised row can compare it by reference. Transient per-row state lives in
 * `NoteRowStatus`, because a shared object carrying "who is spinning right now"
 * changes identity whenever *any* row acts — which made every row's props change
 * and defeated memoisation for the whole feed.
 */
export interface NoteRowActions {
  /**
   * False for a read-only session. Every control that writes to the network
   * renders unavailable rather than absent, so the row does not reflow when an
   * account is unlocked.
   */
  readonly canSign: boolean;
  /** `active` is the current state, so one control toggles both ways. */
  react(noteId: string, active: boolean): void;
  repost(noteId: string, active: boolean): void;
  bookmark(noteId: string): void;
  zap(noteId: string): void;
  share(noteId: string): void;
  isBookmarked(noteId: string): boolean;
  /** True only for a note this account published, with a signer available. */
  canDelete(noteId: string): boolean;
  /** Requests deletion (kind 5). Relays may or may not honour it. */
  deleteNote(noteId: string): void;
  /**
   * True when this note's author is on the reader's mute list, so the menu can
   * offer the un-mute rather than a mute that would refuse itself.
   */
  isAuthorMuted(noteId: string): boolean;
  /**
   * Mute/un-mute confirmation for this note's author (NIP-51 kind 10000).
   *
   * Rendered rather than fired, like the reply composer, for two reasons: muting is
   * the one action here whose *wording* is load-bearing — it is not a block, and the
   * list is public — and the write's in-flight and failure state then belongs to the
   * dialog instead of to the row, which keeps this capability object stable.
   */
  renderMuteDialog(
    noteId: string,
    close: () => void,
    authorName?: string,
  ): ReactNode;
  /** Report dialog (NIP-56 kind 1984). Publishes; moderates nothing. */
  renderReportDialog(
    noteId: string,
    close: () => void,
    authorName?: string,
  ): ReactNode;
  /** Inline reply composer. The row owns whether it is open. */
  renderReplyComposer(
    noteId: string,
    close: () => void,
    authorName?: string,
  ): ReactNode;
}

/**
 * What one row currently has to report about itself.
 *
 * Data rather than three accessors on the shared actions object, and only ever
 * handed to the row it belongs to. Merged here from four independent hooks —
 * reactions, bookmarks, zaps, share — which is what lets a row show exactly one
 * spinner and one message without knowing they are separate subsystems.
 *
 * Absent for a row with nothing in flight, which is nearly every row nearly all
 * the time; that absence is what keeps a memoised row's props reference-equal
 * while a different row acts.
 */
export interface NoteRowStatus {
  /** Which control on this row is mid-flight. */
  readonly pending?: NoteActionControl;
  /** Transient confirmation — "Link copied", "Invoice handed off". */
  readonly notice?: string;
  readonly error?: string;
}

/** The controls in the row, as far as busy/pending state is concerned. */
export type NoteActionControl =
  | "reply"
  | "react"
  | "repost"
  | "bookmark"
  | "zap"
  | "share"
  // Lives in the overflow menu rather than the row, but shares the row's
  // pending/error slot so a delete in flight cannot be started twice.
  | "delete";

const READ_ONLY_REASON =
  "Read-only session — unlock or sign in with a key to do this";

/**
 * One action in the note's action row.
 *
 * Counts are always rendered (not hidden at zero) but dimmed, so the row's width
 * does not shift the moment a note gets its first reply.
 *
 * An unavailable control keeps `aria-disabled` and stays focusable rather than
 * taking the `disabled` attribute: a disabled button is skipped by a screen
 * reader, so the reason for it being unavailable becomes invisible to exactly the
 * reader who most needs it. The hover response is removed and the cursor changes,
 * so it does not merely look dim — it stops behaving like a button.
 */
function NoteAction({
  icon,
  count,
  approximate,
  label,
  active,
  activeClass,
  toggle,
  unavailable,
  busy,
  onClick,
}: {
  icon: ReactNode;
  /** Omitted for controls that have no count, like bookmark and share. */
  count?: number;
  /**
   * True when `count` is a floor. Rendered as "500+", and said out loud in the
   * accessible name — the visible `+` is the only signal a sighted reader gets,
   * and `aria-label` replaces the button's text content for everyone else.
   */
  approximate?: boolean;
  label: string;
  active?: boolean;
  activeClass?: string;
  /**
   * True for a control that really is a two-state toggle. Set separately from
   * `active` because `active` also drives purely visual emphasis — a note with
   * zaps is not a "pressed" zap button, and announcing it as one is a lie.
   */
  toggle?: boolean;
  /** Reason this control cannot be used. Presence disables it. */
  unavailable?: string;
  busy?: boolean;
  onClick?(): void;
}) {
  const disabled = unavailable !== undefined;
  const accessibleName = [
    label,
    approximate === true && count !== undefined
      ? `at least ${count}`
      : undefined,
    disabled ? unavailable : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" — ");
  return (
    <button
      type="button"
      aria-label={accessibleName}
      aria-disabled={disabled || undefined}
      aria-pressed={toggle ? Boolean(active) : undefined}
      title={unavailable}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "group/action flex items-center gap-1.5 rounded-md px-1.5 py-1",
        "setu-mono text-2xs transition-colors duration-(--motion-duration-instant)",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        disabled
          ? "cursor-not-allowed text-muted-foreground/40"
          : cn(
              "hover:bg-accent",
              active
                ? activeClass
                : "text-muted-foreground hover:text-foreground",
            ),
      )}
    >
      {busy ? <Loader2 className="animate-spin" /> : icon}
      {count === undefined ? null : (
        <span className={count === 0 ? "opacity-40" : undefined}>
          {countLabel(count, approximate)}
        </span>
      )}
    </button>
  );
}

export interface NoteActionRowProps {
  note: NoteView;
  actions?: NoteRowActions;
  /** This row's own in-flight/notice/error state, if it has any. */
  status?: NoteRowStatus;
  /** True while the inline reply composer is open under this note. */
  replyOpen?: boolean;
  onToggleReply?(): void;
}

/**
 * The note's action row.
 *
 * Its own component because the gating rules are the interesting part and they do
 * not belong inside the card's layout: a read-only session must not be offered a
 * write, an author with no lightning address must not be offered a zap, and every
 * refusal must say why rather than presenting a control that can only fail.
 *
 * With no `actions` the counts render as plain text rather than buttons. That is
 * the honest rendering for a surface that has not wired the handlers up: a button
 * that does nothing is worse than no button.
 */
export function NoteActionRow({
  note,
  actions,
  status,
  replyOpen = false,
  onToggleReply,
}: NoteActionRowProps) {
  if (!actions) return <NoteCountRow note={note} />;

  const pending = status?.pending;
  const bookmarked = actions.isBookmarked(note.id);
  const unavailable = actions.canSign ? undefined : READ_ONLY_REASON;

  // A zap needs both a signer and a lightning address on the author's kind-0.
  // Ordered so the reason shown is the one that actually applies: a read-only
  // reader cannot zap anyone, address or not.
  const zapUnavailable =
    unavailable ??
    (note.author.lightning
      ? undefined
      : "This author has not published a lightning address, so they cannot be zapped.");

  return (
    <>
      <div className="-ml-1.5 mt-1.5 flex items-center gap-1">
        <NoteAction
          icon={<MessageSquare />}
          count={note.replyCount}
          approximate={note.countsApproximate}
          label="Reply"
          active={replyOpen}
          activeClass="text-primary"
          toggle
          unavailable={unavailable}
          onClick={onToggleReply}
        />
        <NoteAction
          icon={<Repeat2 />}
          count={note.repostCount}
          approximate={note.countsApproximate}
          label={note.viewerReposted ? "Undo repost" : "Repost"}
          active={note.viewerReposted}
          activeClass="text-repost"
          toggle
          unavailable={unavailable}
          busy={pending === "repost"}
          onClick={() => actions.repost(note.id, note.viewerReposted ?? false)}
        />
        <NoteAction
          icon={
            <Heart
              className={note.viewerReacted ? "fill-current" : undefined}
            />
          }
          count={note.reactionCount}
          approximate={note.countsApproximate}
          label={note.viewerReacted ? "Remove reaction" : "React"}
          active={note.viewerReacted}
          activeClass="text-like"
          toggle
          unavailable={unavailable}
          busy={pending === "react"}
          onClick={() => actions.react(note.id, note.viewerReacted ?? false)}
        />
        <NoteAction
          icon={<Zap />}
          count={note.zapSats}
          approximate={note.countsApproximate}
          label="Zap"
          active={note.zapSats > 0}
          activeClass="text-zap"
          unavailable={zapUnavailable}
          busy={pending === "zap"}
          onClick={() => actions.zap(note.id)}
        />
        <NoteAction
          icon={
            <Bookmark className={bookmarked ? "fill-current" : undefined} />
          }
          label={bookmarked ? "Remove bookmark" : "Bookmark"}
          active={bookmarked}
          activeClass="text-primary"
          toggle
          unavailable={unavailable}
          busy={pending === "bookmark"}
          onClick={() => actions.bookmark(note.id)}
        />
        {/* Share is a read, so it stays available to a read-only session. */}
        <NoteAction
          icon={<Link2 />}
          label="Copy link to note"
          busy={pending === "share"}
          onClick={() => actions.share(note.id)}
        />
      </div>

      {status?.notice ? (
        <p className="mt-1 text-2xs break-all text-muted-foreground">
          {status.notice}
        </p>
      ) : null}
      {status?.error ? (
        <p className="mt-1 text-2xs text-destructive">{status.error}</p>
      ) : null}
    </>
  );
}

/**
 * Counts with no controls, for a surface that has not wired handlers up.
 *
 * Rendered as text rather than as disabled buttons: "unavailable" is a claim about
 * this reader's session, and it would be a false one here — the note is perfectly
 * actionable, this particular view just has nothing hooked up.
 */
function NoteCountRow({ note }: { note: NoteView }) {
  const items: readonly [ReactNode, string, number][] = [
    [<MessageSquare key="r" />, "replies", note.replyCount],
    [<Repeat2 key="b" />, "reposts", note.repostCount],
    [<Heart key="l" />, "reactions", note.reactionCount],
    [<Zap key="z" />, "sats zapped", note.zapSats],
  ];
  return (
    <div className="mt-1.5 flex items-center gap-3 text-2xs text-muted-foreground tabular-nums">
      {items.map(([icon, label, count]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span aria-hidden className="[&_svg]:size-3.5 [&_svg]:shrink-0">
            {icon}
          </span>
          <span className={count === 0 ? "opacity-40" : undefined}>
            {countLabel(count, note.countsApproximate)}
          </span>
          <span className="sr-only">{label}</span>
        </span>
      ))}
    </div>
  );
}
