import { formatCount } from "@setu/core";
import { encodeNpub, truncateNpub } from "@setu/protocol";
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
  Skeleton,
} from "@setu/ui";
import {
  BadgeCheck,
  Check,
  Copy,
  Flag,
  Link2,
  Loader2,
  MoreHorizontal,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useSession } from "../identity/SessionProvider";
import { MuteDialog } from "../moderation/MuteDialog";
import { ReportDialog } from "../moderation/ReportDialog";
import { useMuteRules } from "../moderation/useMuteList";
import { useRenderedContent } from "../notes/NoteContent";
import { nip05DisplayName } from "../profiles/nip05";
import type { ProfileDetails } from "../profiles/profileContent";
import { useNip05 } from "../profiles/useNip05";
import type { AuthorCounts } from "./useAuthorCounts";
import type { LocalAuthorCounts } from "./useLocalCounts";

/** Copy-to-clipboard, with the "copied" state resetting itself. */
function CopyNpubButton({ npub }: { npub: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    // No clipboard outside a secure context, so the button reports failure
    // rather than pretending: a silent no-op here looks like a copied key.
    void navigator.clipboard
      ?.writeText(npub)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={copy}
      aria-label={copied ? "Public key copied" : "Copy public key"}
      className="font-mono text-2xs text-muted-foreground"
    >
      {copied ? <Check className="text-verified" /> : <Copy />}
      {truncateNpub(npub, 10)}
    </Button>
  );
}

/**
 * One "N label" pair.
 *
 * Takes a pre-formatted string rather than a number, because the *shape* of the
 * figure carries meaning that a number cannot: `400+` is a lower bound from
 * NIP-45, `~400` is a relay's own estimate, and a plain `22` from the local index
 * is a different claim again. Formatting upstream keeps those distinctions from
 * being flattened here.
 */
function CountPill({
  value,
  label,
  title,
}: {
  value: string;
  label: string;
  title?: string;
}) {
  return (
    <span className="text-xs text-muted-foreground" title={title}>
      <span className="font-semibold text-foreground tabular-nums">
        {value}
      </span>{" "}
      {label}
    </span>
  );
}

export interface ProfileHeaderProps {
  pubkey: string;
  details: ProfileDetails;
  loaded: boolean;
  counts: LocalAuthorCounts;
  /** NIP-45 totals, when any relay could answer. */
  relayCounts?: AuthorCounts;
  /** Undefined means the app has not wired following yet, not "not following". */
  following?: boolean;
  /** True when this is the signed-in account's own profile. */
  isSelf?: boolean;
  /** Reason the last follow edit was refused, surfaced under the button. */
  followError?: string;
  /**
   * True while the edit is in flight. A follow re-reads the list from the relays
   * before writing, which takes seconds — without this the button looks inert.
   */
  followBusy?: boolean;
  onToggleFollow?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}

/**
 * Profile header: banner, identity, bio, keys, counts, moderation.
 *
 * The `about` text goes through the same tokenizer as a note body, so a bio's
 * links, hashtags and mentions behave exactly as they do in the timeline. Bios
 * are full of both, and rendering them as inert text is a small lie about what
 * the author wrote.
 *
 * ## Why mute and report live here and not only on a note
 *
 * A profile is where the decision is actually made. Somebody arrives here *because*
 * a note bothered them, and until now the only way to act was to go back and find
 * that note again — so the reader was asked to make an account-level judgement from
 * the one surface that could not express one. It is also the only place the
 * account-only report exists: `ReportDialog` with no `noteId` files the `["p", pk,
 * type]` form, which is a claim about the account rather than about one note.
 *
 * Both are rendered as dialogs rather than fired from the menu, for the reasons those
 * dialogs document: a mute is not a block and a report moderates nothing, and both
 * sentences have to be read before the write, not after it.
 */
export function ProfileHeader({
  pubkey,
  details,
  loaded,
  counts,
  relayCounts,
  following,
  isSelf = false,
  followError,
  followBusy = false,
  onToggleFollow,
  onOpenHashtag,
}: ProfileHeaderProps) {
  // Relay totals when available, the local sample otherwise. Never a blend:
  // mixing an exact local count with a relay lower bound in one row would make
  // two numbers that mean different things look comparable.
  const fromRelays =
    relayCounts !== undefined &&
    !relayCounts.notes.unavailable &&
    relayCounts.supported;
  const notesLabel = fromRelays
    ? (formatCount(relayCounts.notes) ?? String(counts.notes))
    : String(counts.notes);
  const readsLabel = fromRelays
    ? (formatCount(relayCounts.reads) ?? String(counts.reads))
    : String(counts.reads);
  const relayCountHint = fromRelays
    ? `Highest figure reported by ${relayCounts.notes.answered} of ${relayCounts.notes.asked} relays that support counting. The true total may be higher.`
    : undefined;
  const [bioOpen, setBioOpen] = useState(false);
  const [dialog, setDialog] = useState<"mute" | "report" | undefined>();
  const { session } = useSession();
  const { rules } = useMuteRules();
  // Both items publish, so both need a signer. Absent rather than disabled on a
  // read-only session: a greyed-out "Mute" invites a click that can only fail.
  const canModerate = !isSelf && Boolean(session?.canSign);
  const muted = rules.pubkeys.has(pubkey);
  const npub = encodeNpub(pubkey);
  const nip05Status = useNip05(pubkey, details.nip05);
  const verified = nip05Status === "verified";

  // Rough threshold on characters rather than measuring rendered lines: a
  // measurement would need a layout pass on every profile switch, and the only
  // decision here is whether to offer a toggle at all.
  const longBio = (details.about?.length ?? 0) > 160;

  const displayName =
    details.displayName ??
    details.name ??
    (npub ? truncateNpub(npub, 8) : pubkey.slice(0, 12));

  const { body: about } = useRenderedContent({
    content: details.about ?? "",
    ...(onOpenHashtag ? { onOpenHashtag } : {}),
  });

  return (
    <header className="border-b border-border/60">
      {/* A fixed ratio keeps the avatar's overlap from shifting as the image
          loads. 4:1 rather than the 3:1 banners are usually authored at: the
          header does not scroll away, so every pixel it takes is a pixel of
          timeline, and a banner is decoration. */}
      <div className="relative aspect-[4/1] w-full overflow-hidden bg-muted">
        {details.banner ? (
          <img
            src={details.banner}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
          />
        ) : (
          <div className="size-full bg-gradient-to-br from-primary/20 via-muted to-muted" />
        )}
      </div>

      <div className="px-4 pb-4">
        {/* The pull-up belongs to the avatar, not the row.
            On the row it dragged the follow button up with it, leaving the
            button pressed against the bottom edge of the banner with no
            breathing room at all. With the offset on the avatar the row keeps
            its normal top edge, and `items-end` still lines the button up with
            the bottom of the avatar. */}
        <div className="flex items-end justify-between gap-3 pt-3">
          <Avatar className="-mt-11 size-16 border-2 border-background shadow-sm">
            {details.picture ? (
              <AvatarImage src={details.picture} alt={displayName} />
            ) : null}
            <AvatarFallback className="text-base">
              {displayName.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>

          <div className="flex items-center gap-1.5">
            {canModerate ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    // `icon` is h-8, the same height as the `sm` follow button
                    // beside it, so the two sit on one baseline.
                    size="icon"
                    aria-label={`More actions for ${displayName}`}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* "Mute", not "Block". Nothing here stops this account reaching
                      the reader; the dialog is where that gets said in full, which
                      is why the item opens one instead of writing. */}
                  <DropdownMenuItem onSelect={() => setDialog("mute")}>
                    {muted ? <Volume2 /> : <VolumeX />}
                    {muted ? "Unmute" : "Mute"} this account
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Trailing ellipsis because it opens a form, and because a bare
                      "Report" reads as something having been reported. */}
                  <DropdownMenuItem onSelect={() => setDialog("report")}>
                    <Flag />
                    Report this account…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {/* You cannot follow yourself, so the control is absent rather than
                disabled — a greyed-out "Unfollow" on your own profile describes a
                relationship that cannot exist. */}
            {isSelf ? null : (
              <Button
                variant={following ? "outline" : "default"}
                size="sm"
                // Rendered but inert until the identity layer owns kind-3 writes. A
                // follow write must merge into the newest list on the network, and a
                // button built from a stale snapshot silently unfollows everyone
                // added since — so the capability arrives with the code that can do
                // it safely, not before.
                disabled={!onToggleFollow || followBusy}
                onClick={() => onToggleFollow?.(pubkey)}
                title={
                  onToggleFollow
                    ? undefined
                    : "Following requires a signed-in account"
                }
              >
                {followBusy ? <Loader2 className="animate-spin" /> : null}
                {followBusy
                  ? "Checking your list"
                  : following
                    ? "Unfollow"
                    : "Follow"}
              </Button>
            )}
          </div>
        </div>

        {followError ? (
          <p className="mt-2 text-xs text-destructive">{followError}</p>
        ) : null}

        <div className="mt-3 min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <h1 className="truncate text-base font-semibold">
              {loaded || details.displayName ? (
                displayName
              ) : (
                <Skeleton className="h-4 w-40" />
              )}
            </h1>
            {verified ? (
              <BadgeCheck
                className="size-4 shrink-0 text-verified"
                aria-label="NIP-05 verified"
              />
            ) : null}
          </div>

          {details.nip05 ? (
            <p
              className={cn(
                "truncate text-xs",
                verified ? "text-muted-foreground" : "text-muted-foreground/70",
              )}
              // The claim is always shown; the badge above is what asserts it was
              // checked. Spelling the state out in the tooltip keeps "we are
              // still asking" from reading as "this failed".
              title={
                verified
                  ? `Verified against ${details.nip05}`
                  : nip05Status === "verifying"
                    ? "Checking this identifier's domain…"
                    : nip05Status === "failed"
                      ? "This identifier's domain did not confirm this key"
                      : undefined
              }
            >
              {nip05DisplayName(details.nip05)}
            </p>
          ) : null}

          {details.about ? (
            <>
              <div
                className={cn(
                  "mt-2 text-sm leading-relaxed break-words whitespace-pre-wrap",
                  // Bios can run to hundreds of words, and this header holds its
                  // place above the timeline. Clamped by default, expandable —
                  // never truncated with no way back to the full text.
                  !bioOpen && "setu-clamp-3",
                )}
              >
                {about}
              </div>
              {longBio ? (
                <button
                  type="button"
                  onClick={() => setBioOpen((open) => !open)}
                  className="mt-0.5 text-xs font-medium text-primary hover:underline"
                >
                  {bioOpen ? "Show less" : "Show more"}
                </button>
              ) : null}
            </>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {details.website ? (
              <a
                href={details.website}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
              >
                <Link2 className="size-3" />
                {details.website.replace(/^https?:\/\//, "")}
              </a>
            ) : null}
            {details.lightning ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Zap className="size-3 text-zap" />
                <span className="truncate font-mono">{details.lightning}</span>
              </span>
            ) : null}
          </div>

          <div className="mt-2 -ml-2">
            {npub ? <CopyNpubButton npub={npub} /> : null}
          </div>

          {/*
           * Two sources, and the label says which one is in use.
           *
           * When a relay implements NIP-45 the figure is a real total (a lower
           * bound across relays — see `countAggregate`). When none does, it falls
           * back to counting what this device holds, which for a busy author is a
           * single page of history and wildly low. Showing the local number
           * unlabelled was the bug: 22 where the truth was 388.
           */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <CountPill
              value={notesLabel}
              label="notes"
              {...(fromRelays ? { title: relayCountHint } : {})}
            />
            {/*
             * Replies are omitted in relay mode, not filled in from the local
             * index. A reply is a kind-1 carrying an `e` tag, and NIP-01 has no
             * "has an `e` tag" filter — so no relay can answer this question and
             * COUNT cannot be asked it. Showing the local figure here would put a
             * number that came from this device under a label that says the
             * relays counted it, which is the one thing this row must not do.
             */}
            {fromRelays ? null : (
              <CountPill value={String(counts.replies)} label="replies" />
            )}
            <CountPill
              value={readsLabel}
              label="reads"
              {...(fromRelays ? { title: relayCountHint } : {})}
            />
            <span className="text-2xs text-muted-foreground/80">
              {fromRelays ? "counted by your relays" : "held locally"}
            </span>
          </div>
        </div>
      </div>

      {dialog === "mute" ? (
        <MuteDialog
          target={{ kind: "pubkey", value: pubkey }}
          name={displayName}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {/* `noteId` omitted on purpose: that is what makes this the account-only
          `["p", pubkey, type]` report rather than a claim about one note. */}
      {dialog === "report" ? (
        <ReportDialog
          pubkey={pubkey}
          name={displayName}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </header>
  );
}
