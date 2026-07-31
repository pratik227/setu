import type { NostrEvent } from "@setu/protocol";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  cn,
  EmptyState,
  Skeleton,
} from "@setu/ui";
import { ArrowRight, Zap } from "lucide-react";
import { useMemo } from "react";
import { compactCount, relativeTime } from "../notes/relativeTime";
import type { AuthorView } from "../notes/types";
import { fallbackAuthor, useAuthors } from "../profiles/useAuthors";
import { useZapReceipts, type ZapReceiptView } from "./useZapReceipts";

function TinyAvatar({ author }: { author: AuthorView }) {
  return (
    <Avatar className="size-5">
      {author.avatarUrl ? (
        <AvatarImage src={author.avatarUrl} alt={author.displayName} />
      ) : null}
      <AvatarFallback className="text-3xs">
        {author.displayName.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function Party({
  author,
  onOpenProfile,
}: {
  author: AuthorView;
  onOpenProfile?(pubkey: string): void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenProfile?.(author.pubkey)}
      className="flex min-w-0 items-center gap-1.5 rounded-md hover:underline focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <TinyAvatar author={author} />
      <span className="truncate text-xs font-medium">{author.displayName}</span>
    </button>
  );
}

function ZapRow({
  receipt,
  authors,
  target,
  onOpenThread,
  onOpenProfile,
}: {
  receipt: ZapReceiptView;
  authors: ReadonlyMap<string, AuthorView>;
  target: NostrEvent | undefined;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
}) {
  const recipient =
    authors.get(receipt.recipient) ?? fallbackAuthor(receipt.recipient);
  const sender = receipt.sender
    ? (authors.get(receipt.sender) ?? fallbackAuthor(receipt.sender))
    : undefined;
  const targetId = receipt.targetId;

  return (
    <article className="border-b border-border/50 px-4 py-3">
      <div className="flex items-center gap-2">
        <Zap className="size-3.5 shrink-0 text-zap" />
        <span className="shrink-0 text-sm font-semibold text-zap tabular-nums">
          {compactCount(receipt.sats)} sats
        </span>
        <time
          dateTime={new Date(receipt.createdAt * 1000).toISOString()}
          className="ml-auto shrink-0 text-xs text-muted-foreground"
        >
          {relativeTime(receipt.createdAt)}
        </time>
      </div>

      <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
        {sender ? (
          <Party author={sender} onOpenProfile={onOpenProfile} />
        ) : (
          // NIP-57 allows an anonymous zap; showing a guessed name would be
          // worse than saying we do not know.
          <span className="text-xs text-muted-foreground">Anonymous</span>
        )}
        <ArrowRight
          className="size-3 shrink-0 text-muted-foreground/60"
          aria-label="zapped"
        />
        <Party author={recipient} onOpenProfile={onOpenProfile} />
      </div>

      {receipt.comment ? (
        <p className="mt-1.5 line-clamp-2 text-xs break-words text-muted-foreground italic">
          “{receipt.comment}”
        </p>
      ) : null}

      {targetId ? (
        <button
          type="button"
          onClick={() => onOpenThread?.(targetId)}
          className={cn(
            "mt-2 block w-full rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 text-left",
            "transition-colors duration-(--motion-duration-instant) hover:bg-muted/60",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
          )}
        >
          {target ? (
            <span className="line-clamp-2 text-xs break-words whitespace-pre-wrap">
              {target.content}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Zapped note not in your index yet — open it to fetch the thread.
            </span>
          )}
        </button>
      ) : (
        <p className="mt-1.5 text-2xs text-muted-foreground">
          Profile zap — the receipt names no event.
        </p>
      )}
    </article>
  );
}

export interface ZapsTabProps {
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
}

export function ZapsTab({ onOpenThread, onOpenProfile }: ZapsTabProps) {
  const { receipts, targets, loading } = useZapReceipts(40);

  const pubkeys = useMemo(() => {
    const set = new Set<string>();
    for (const receipt of receipts) {
      set.add(receipt.recipient);
      if (receipt.sender) set.add(receipt.sender);
    }
    return [...set];
  }, [receipts]);
  const authors = useAuthors(pubkeys);

  if (loading) {
    return (
      <div className="flex flex-col">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="border-b border-border/50 px-4 py-3">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-2 h-3 w-52" />
          </div>
        ))}
      </div>
    );
  }

  if (receipts.length === 0) {
    return (
      <EmptyState
        icon={<Zap className="size-6" />}
        title="No zap receipts in your index"
        description="Zap receipts (kind 9735) are published by the recipient's Lightning server. None has reached this client — the relays may not carry them, may still be answering, or may be unreachable. This screen never estimates zap totals; it shows only receipts held locally."
      />
    );
  }

  return (
    <div className="flex flex-col">
      <p className="px-4 py-2.5 text-xs text-muted-foreground">
        {receipts.length} zap {receipts.length === 1 ? "receipt" : "receipts"}{" "}
        held locally, newest first. Amounts are read from each invoice, so they
        are what was paid, not what a sender asked for.
      </p>
      {receipts.map((receipt) => (
        <ZapRow
          key={receipt.id}
          receipt={receipt}
          authors={authors}
          target={receipt.targetId ? targets.get(receipt.targetId) : undefined}
          onOpenThread={onOpenThread}
          onOpenProfile={onOpenProfile}
        />
      ))}
    </div>
  );
}
