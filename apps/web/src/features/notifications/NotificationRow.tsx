import { Avatar, AvatarFallback, AvatarImage, Badge, cn } from "@setu/ui";
import {
  AtSign,
  Heart,
  HelpCircle,
  MessageSquare,
  Repeat2,
  Zap,
} from "lucide-react";
import {
  absoluteTime,
  compactCount,
  relativeTime,
} from "../notes/relativeTime";
import type { AuthorView } from "../notes/types";
import { fallbackAuthor } from "../profiles/useAuthors";
import type { NotificationItem, NotificationKind } from "./groupNotifications";
import { notificationKindLabel, notificationLine } from "./notificationText";

/** Faces shown before the row falls back to "and N others". */
const FACEPILE_LIMIT = 4;
/** Names spelled out in the sentence. Past two it becomes a count. */
const NAMED_LIMIT = 2;

function KindGlyph({ kind }: { kind: NotificationKind }) {
  const label = notificationKindLabel(kind);
  const className = "size-3.5 shrink-0";
  switch (kind) {
    case "reaction":
      return (
        <Heart aria-label={label} className={cn(className, "text-like")} />
      );
    case "repost":
      return (
        <Repeat2 aria-label={label} className={cn(className, "text-repost")} />
      );
    case "zap":
      return <Zap aria-label={label} className={cn(className, "text-zap")} />;
    case "mention":
      return (
        <AtSign
          aria-label={label}
          className={cn(className, "text-muted-foreground")}
        />
      );
    default:
      return (
        <MessageSquare
          aria-label={label}
          className={cn(className, "text-muted-foreground")}
        />
      );
  }
}

function Face({
  author,
  onOpenProfile,
}: {
  author: AuthorView | undefined;
  onOpenProfile?(pubkey: string): void;
}) {
  // No pubkey means an anonymous zap: NIP-57 allows a receipt that names no
  // sender, and a placeholder face is the honest rendering of "we do not know".
  if (!author) {
    return (
      <Avatar className="size-6 ring-1 ring-card">
        <AvatarFallback aria-label="Anonymous">?</AvatarFallback>
      </Avatar>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenProfile?.(author.pubkey)}
      aria-label={`Open ${author.displayName}'s profile`}
      className="rounded-full focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <Avatar className="size-6 ring-1 ring-card">
        {author.avatarUrl ? (
          <AvatarImage src={author.avatarUrl} alt={author.displayName} />
        ) : null}
        <AvatarFallback className="text-3xs">
          {author.displayName.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
    </button>
  );
}

/** The target note's opening text, or an explicit "we do not hold it" panel. */
function TargetPreview({
  item,
  onOpenThread,
}: {
  item: NotificationItem;
  onOpenThread?(id: string): void;
}) {
  const openId = item.openId;
  const label = item.bodyPreview ? "In reply to" : undefined;

  if (item.targetUnavailable) {
    return (
      <div className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-dashed border-border bg-muted/20 px-2.5 py-2">
        <HelpCircle className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <p className="text-2xs text-muted-foreground">
          The note this points at has not reached this client yet. Open it to
          ask the relays for the thread.
        </p>
      </div>
    );
  }

  if (!item.targetPreview) return null;

  return (
    <button
      type="button"
      onClick={openId ? () => onOpenThread?.(openId) : undefined}
      className={cn(
        "mt-1.5 block w-full rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 text-left",
        "transition-colors duration-(--motion-duration-instant) hover:bg-muted/60",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
      )}
    >
      {label ? (
        <span className="block text-3xs tracking-wide uppercase text-muted-foreground">
          {label}
        </span>
      ) : null}
      <span className="line-clamp-2 text-xs break-words whitespace-pre-wrap text-muted-foreground">
        {item.targetPreview}
      </span>
    </button>
  );
}

export interface NotificationRowProps {
  item: NotificationItem;
  /** Resolved actor metadata. Missing entries fall back to a truncated npub. */
  authors: ReadonlyMap<string, AuthorView>;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
}

/**
 * One notification.
 *
 * The wording comes from `notificationText.ts` and the grouping from
 * `groupNotifications.ts`, so this component only lays out what it was handed —
 * it makes no decision about who did what, and cannot invent a count.
 *
 * The row is a `div`, not a button: it contains avatar buttons and a target
 * button, and a button inside a button is invalid HTML that browsers resolve by
 * dropping one of the two click targets.
 */
export function NotificationRow({
  item,
  authors,
  onOpenThread,
  onOpenProfile,
}: NotificationRowProps) {
  const resolved = item.actors.map((actor) =>
    actor.pubkey
      ? (authors.get(actor.pubkey) ?? fallbackAuthor(actor.pubkey))
      : undefined,
  );

  const names = resolved
    .slice(0, NAMED_LIMIT)
    .map((author) => author?.displayName ?? "Anonymous");

  const line = notificationLine({
    kind: item.kind,
    names,
    actorCount: item.actors.length,
    targetIsMine: item.targetIsMine,
    allLikes: item.allLikes,
  });

  const overflow = item.actors.length - FACEPILE_LIMIT;
  const openId = item.openId;

  return (
    <article className="border-b border-border/50 px-4 py-3">
      <div className="flex items-center gap-2">
        <KindGlyph kind={item.kind} />

        <div className="flex items-center -space-x-1.5">
          {resolved.slice(0, FACEPILE_LIMIT).map((author, index) => (
            <Face
              key={author?.pubkey ?? `anonymous-${index}`}
              author={author}
              onOpenProfile={onOpenProfile}
            />
          ))}
          {overflow > 0 ? (
            <span className="pl-2.5 text-2xs text-muted-foreground tabular-nums">
              +{overflow}
            </span>
          ) : null}
        </div>

        {item.kind === "zap" && item.totalSats ? (
          <Badge variant="zap" className="shrink-0">
            {compactCount(item.totalSats)} sats
          </Badge>
        ) : null}

        <time
          dateTime={new Date(item.createdAt * 1000).toISOString()}
          title={absoluteTime(item.createdAt)}
          className="ml-auto shrink-0 text-xs text-muted-foreground"
        >
          {relativeTime(item.createdAt)}
        </time>
      </div>

      <p className="mt-1.5 text-sm break-words">{line}</p>

      {item.kind === "zap" ? (
        // The sender of a zap is copied out of the receipt by the recipient's
        // LNURL server, so it is a claim relayed to us rather than a signature we
        // checked. Saying so costs one line and stops the row from asserting more
        // than this client knows.
        <p className="mt-0.5 text-3xs text-muted-foreground">
          Sender named by the receipt, not verified by this client.
        </p>
      ) : null}

      {item.bodyPreview ? (
        <button
          type="button"
          onClick={openId ? () => onOpenThread?.(openId) : undefined}
          className="mt-1 block w-full text-left"
        >
          <span className="line-clamp-3 text-sm break-words whitespace-pre-wrap">
            {item.bodyPreview}
          </span>
        </button>
      ) : null}

      <TargetPreview item={item} onOpenThread={onOpenThread} />
    </article>
  );
}
