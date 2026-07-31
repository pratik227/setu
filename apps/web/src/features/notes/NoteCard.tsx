import { emojiTagMap, encodeNpub, getTagValue, Kind } from "@setu/protocol";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@setu/ui";
import {
  BadgeCheck,
  Copy,
  Flag,
  Hash,
  Link2,
  MoreHorizontal,
  Repeat2,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { EmojiText } from "./CustomEmoji";
import {
  NoteActionRow,
  type NoteRowActions,
  type NoteRowStatus,
} from "./NoteActionRow";
import { NoteMedia } from "./NoteMedia";
import { isMediaFirstKind, isTitledKind } from "./noteKinds";
import { copyText } from "./noteLink";
import { PollCard } from "./PollCard";
import { ProvenanceChip } from "./ProvenanceChip";
import { absoluteTime, relativeTime } from "./relativeTime";
import type { NoteView } from "./types";

/** Media grid. One image goes full width; several tile into a 2-column grid. */

export interface NoteCardProps {
  note: NoteView;
  /** Relays that served this note, from the store's provenance record. */
  provenanceRelays?: readonly string[];
  /** Rendered body. Passed in so tokenization stays out of the row component. */
  body?: ReactNode;
  /**
   * The per-emoji reaction breakdown, when the surface has one.
   *
   * Passed in rather than read here, for the same reason `body` is: reading it
   * needs a store observer, and one per card would put eighty observers behind a
   * feed page. A surface that can afford it — the thread's focused note, which is
   * always inside the interaction tracker's window — supplies it; every other row
   * renders the aggregate count in the action row and nothing more.
   */
  reactions?: ReactNode;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  /**
   * Everything the action row needs, as one object.
   *
   * Absent means this surface has not wired interactions up, and the row renders
   * counts as plain text rather than controls that do nothing.
   */
  actions?: NoteRowActions;
  /**
   * This row's own in-flight/notice/error state.
   *
   * Separate from `actions` so the capability object can stay reference-stable:
   * one object carrying both meant a spinner on any row changed every row's
   * props. Absent means this row has nothing in flight.
   */
  status?: NoteRowStatus;
  className?: string;
}

/**
 * Notes longer than this collapse behind "Show more".
 *
 * Long-form posts published as kind 1 are common, and one of them can occupy an
 * entire screen — which turns a timeline into a single-post page. The threshold
 * is on rendered length rather than line count so a wall of text with no
 * newlines is caught too.
 */
const CLAMP_CHARS = 560;

export function NoteCard({
  note,
  provenanceRelays,
  body,
  reactions,
  onOpenThread,
  onOpenProfile,
  actions,
  status,
  className,
}: NoteCardProps) {
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Owned here rather than by the caller: a feed would otherwise need a
  // "which row is replying" state, and two rows could open at once.
  const [replying, setReplying] = useState(false);
  // Same reasoning for the moderation dialogs, and one slot rather than two
  // booleans so mute and report cannot both be open over the same note.
  const [dialog, setDialog] = useState<"mute" | "report" | undefined>();
  const closeDialog = () => setDialog(undefined);
  const muted = actions?.isAuthorMuted(note.id) ?? false;
  const hidden = Boolean(note.contentWarning) && !revealed;
  const clampable = note.content.length > CLAMP_CHARS;
  const clamped = clampable && !expanded;

  /*
   * Media-first kinds, and why the ordering is not a preference.
   *
   * A kind-1 with an image URL in it reads text-first: the sentence introduces the
   * picture. A NIP-68 picture post and a NIP-71 video put the media in `imeta` tags
   * and use the content as a *caption* — so kind-1 ordering puts the caption above
   * the thing it describes, and for a video event with empty content it puts an
   * empty paragraph above the player.
   */
  const mediaFirst = isMediaFirstKind(note.kind);
  const isPoll = note.kind === Kind.Poll;
  // NIP-68/NIP-71 both carry the headline in a `title` tag rather than in content.
  // Gated on the kind, not merely on the tag's presence — see `isTitledKind`.
  const title = isTitledKind(note.kind)
    ? getTagValue(note, "title")
    : undefined;
  // NIP-30 shortcodes appear in a title and in a poll question too, not only in the
  // body the tokenizer handles.
  const emoji = useMemo(() => emojiTagMap({ tags: note.tags }), [note.tags]);

  return (
    <article
      className={cn(
        "cv-auto-note group/note border-b border-border/50 px-4 py-3",
        "transition-colors duration-(--motion-duration-instant) hover:bg-muted/30",
        note.justArrived && "motion-enter-note",
        className,
      )}
    >
      {note.repostedBy && note.repostedBy.length > 0 ? (
        <div className="mb-1.5 flex items-center gap-1.5 pl-11 text-2xs text-muted-foreground">
          <Repeat2 className="size-3 text-repost" />
          <span className="truncate">
            {note.repostedBy[0]!.displayName}
            {note.repostedBy.length > 1
              ? ` and ${note.repostedBy.length - 1} other${
                  note.repostedBy.length > 2 ? "s" : ""
                }`
              : ""}{" "}
            reposted
          </span>
        </div>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => onOpenProfile?.(note.author.pubkey)}
          aria-label={`Open ${note.author.displayName}'s profile`}
          className="shrink-0 self-start rounded-full focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          <Avatar>
            {note.author.avatarUrl ? (
              <AvatarImage
                src={note.author.avatarUrl}
                alt={note.author.displayName}
              />
            ) : null}
            <AvatarFallback>
              {note.author.displayName.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            {/* Until the kind-0 arrives we show a placeholder, not the npub.
                Rendering a truncated key and then swapping in a real name a
                second later makes every row in the feed flicker and reads as the
                client having first got it wrong — the pubkey is not a worse name,
                it is not a name at all. */}
            {note.author.resolved ? (
              <>
                <button
                  type="button"
                  onClick={() => onOpenProfile?.(note.author.pubkey)}
                  className="truncate text-base font-semibold hover:underline"
                >
                  {note.author.displayName}
                </button>
                {note.author.verified ? (
                  <BadgeCheck
                    className="size-3.5 shrink-0 self-center text-verified"
                    aria-label="NIP-05 verified"
                  />
                ) : null}
                <span className="setu-mono truncate text-xs text-muted-foreground">
                  {note.author.handle}
                </span>
                <span className="text-xs text-muted-foreground/60">·</span>
              </>
            ) : (
              <>
                {/* Sized to a plausible name so the row does not resize when the
                    real one lands. */}
                <span className="sr-only">Loading author</span>
                <span
                  aria-hidden
                  className="motion-shimmer h-3.5 w-28 shrink-0 self-center rounded bg-foreground/[0.07]"
                />
                <span className="text-xs text-muted-foreground/60">·</span>
              </>
            )}
            <time
              dateTime={new Date(note.createdAt * 1000).toISOString()}
              title={absoluteTime(note.createdAt)}
              className="shrink-0 text-xs text-muted-foreground"
            >
              {relativeTime(note.createdAt)}
            </time>
            {/* Only actions that actually work are listed. This menu was once a
                dead affordance that appeared on hover and did nothing, and the
                rule that replaced it still holds: an item ships when the write
                behind it exists, and never before. Mute and report are here
                because kinds 10000 and 1984 are now wired end to end; both are
                gated on a signer, because both publish. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="More actions"
                  className="ml-auto opacity-0 transition-opacity group-hover/note:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {actions ? (
                  <DropdownMenuItem onSelect={() => actions.share(note.id)}>
                    <Link2 />
                    Copy link to note
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => void copyText(note.id)}>
                  <Hash />
                  Copy note ID
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    void copyText(
                      encodeNpub(note.author.pubkey) ?? note.author.pubkey,
                    )
                  }
                >
                  <Copy />
                  Copy author key
                </DropdownMenuItem>
                {actions?.canSign ? (
                  <>
                    <DropdownMenuSeparator />
                    {/* "Mute", not "Block": nothing here stops this account
                        reaching the reader or their relays. The dialog is where
                        that gets said in full — which is why the item opens one
                        rather than writing straight away. */}
                    <DropdownMenuItem onSelect={() => setDialog("mute")}>
                      {muted ? <Volume2 /> : <VolumeX />}
                      {muted ? "Unmute" : "Mute"} {note.author.displayName}
                    </DropdownMenuItem>
                    {/* Trailing ellipsis because it opens a form, and because a
                        bare "Report" reads as something having been reported. */}
                    <DropdownMenuItem onSelect={() => setDialog("report")}>
                      <Flag />
                      Report note…
                    </DropdownMenuItem>
                  </>
                ) : null}
                {actions?.canDelete(note.id) ? (
                  <>
                    <DropdownMenuSeparator />
                    {/* "Request deletion", not "Delete". A kind-5 asks relays to
                        stop serving the note; relays that ignore NIP-09, and
                        anyone who already has a copy, keep it. Labelling that
                        "Delete" promises something no Nostr client can do. */}
                    <DropdownMenuItem
                      destructive
                      onSelect={() => actions.deleteNote(note.id)}
                    >
                      <Trash2 />
                      Request deletion
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {note.replyingTo ? (
            <p className="text-xs text-muted-foreground">
              replying to {note.replyingTo.author}
            </p>
          ) : null}

          {hidden ? (
            <div className="mt-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-4 text-center">
              <p className="text-xs text-muted-foreground">
                {note.contentWarning}
              </p>
              <Button
                variant="outline"
                size="xs"
                className="mt-2"
                onClick={() => setRevealed(true)}
              >
                Show anyway
              </Button>
            </div>
          ) : (
            <>
              {/* Media above the text for the kinds whose media *is* the post.
                  See `mediaFirst` above for why this is not a style choice. */}
              {mediaFirst && note.media ? (
                <NoteMedia media={note.media} className="mt-1.5" />
              ) : null}

              {title ? (
                <p className="mt-1.5 text-base font-semibold break-words">
                  <EmojiText text={title} emoji={emoji} />
                </p>
              ) : null}

              {/* A poll renders a ballot *instead of* the body. A kind-1068's
                  content is the question, so rendering both would print it
                  twice — and the thread overlay below must not cover the option
                  buttons, or every vote would open the thread instead. */}
              {isPoll ? <PollCard note={note} emoji={emoji} /> : null}

              {isPoll ? null : (
                <>
                  {/*
                   * The "open this thread" target is a positioned sibling of the
                   * text, not a button wrapped around it.
                   *
                   * Wrapping was invalid markup and genuinely broken: note content
                   * renders hashtags, mentions and links as their own buttons, and a
                   * button inside a button has no defined behaviour — browsers pick
                   * one, so tapping a hashtag could open the thread instead. Nesting
                   * also collapsed the whole note into one accessibility node,
                   * hiding every inline link from a screen reader.
                   *
                   * Overlaying it instead keeps the row clickable while leaving the
                   * inline controls on top (`relative` beats a static sibling at the
                   * same z-index) and individually reachable.
                   */}
                  <div className="relative mt-0.5">
                    <button
                      type="button"
                      aria-label="Open thread"
                      onClick={() => onOpenThread?.(note.id)}
                      className="absolute inset-0 cursor-pointer focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
                    />
                    <div
                      className={cn(
                        "pointer-events-none relative text-base leading-relaxed break-words whitespace-pre-wrap",
                        // Inline controls opt back in; the prose around them stays
                        // transparent to clicks so the overlay receives them.
                        "[&_a]:pointer-events-auto [&_button]:pointer-events-auto",
                        clamped && "max-h-64 overflow-hidden",
                      )}
                    >
                      {body ?? note.content}
                      {clamped ? (
                        // Fade the cut edge so it reads as truncation rather than a
                        // sentence that happens to stop.
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-card"
                        />
                      ) : null}
                    </div>
                  </div>
                  {clampable ? (
                    <button
                      type="button"
                      onClick={() => setExpanded((v) => !v)}
                      className="mt-1 text-xs font-medium text-primary hover:underline"
                    >
                      {expanded ? "Show less" : "Show more"}
                    </button>
                  ) : null}
                </>
              )}
              {/* Attachment position — under the text, for a note whose text came
                  first. The media-first kinds rendered theirs above already, and
                  rendering it twice is what an unconditional call here would do. */}
              {!mediaFirst && note.media ? (
                <NoteMedia media={note.media} />
              ) : null}
            </>
          )}

          {/* Above the action row, not inside it: the chips are a statement about
              the note, and the row below them is a set of controls. */}
          {reactions}

          <div className="flex items-center gap-2">
            <NoteActionRow
              note={note}
              {...(actions ? { actions } : {})}
              {...(status ? { status } : {})}
              replyOpen={replying}
              onToggleReply={() => setReplying((open) => !open)}
            />
            {/* Provenance sits at the far end of the action row: it is about the
                note rather than something to do with it, so it reads last. */}
            {provenanceRelays ? (
              <ProvenanceChip relays={provenanceRelays} className="ml-auto" />
            ) : null}
          </div>

          {replying && actions ? (
            <div className="mt-1 -ml-11 border-t border-border/40">
              {actions.renderReplyComposer(
                note.id,
                () => setReplying(false),
                note.author.displayName,
              )}
            </div>
          ) : null}

          {/* Mounted only while open, so a feed of eighty rows is not eighty
              dormant dialogs, and each one starts from a clean form. */}
          {dialog === "mute" && actions
            ? actions.renderMuteDialog(
                note.id,
                closeDialog,
                note.author.displayName,
              )
            : null}
          {dialog === "report" && actions
            ? actions.renderReportDialog(
                note.id,
                closeDialog,
                note.author.displayName,
              )
            : null}
        </div>
      </div>
    </article>
  );
}
