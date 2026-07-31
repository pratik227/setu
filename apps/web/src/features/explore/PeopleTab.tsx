import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  cn,
  EmptyState,
  Skeleton,
} from "@setu/ui";
import { BadgeCheck, Users } from "lucide-react";
import type { ActiveAuthor } from "../discover/useActiveAuthors";
import { useActiveAuthors } from "../discover/useActiveAuthors";

function PersonRow({
  entry,
  onOpenProfile,
}: {
  entry: ActiveAuthor;
  onOpenProfile?(pubkey: string): void;
}) {
  const { author, count } = entry;
  return (
    <button
      type="button"
      onClick={() => onOpenProfile?.(author.pubkey)}
      className={cn(
        "flex w-full items-center gap-3 border-b border-border/50 px-4 py-2.5 text-left",
        "transition-colors duration-(--motion-duration-instant) hover:bg-muted/30",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
      )}
    >
      <Avatar>
        {author.avatarUrl ? (
          <AvatarImage src={author.avatarUrl} alt={author.displayName} />
        ) : null}
        <AvatarFallback>
          {author.displayName.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-base font-semibold">
            {author.displayName}
          </span>
          {author.verified ? (
            <BadgeCheck
              className="size-3.5 shrink-0 text-verified"
              aria-label="NIP-05 verified"
            />
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {author.handle}
        </p>
      </div>

      {/* Notes we hold, not a follower count. A follower count needs an index of
          every kind-3 on the network; this is a count of rows in our store. */}
      <Badge variant="muted" className="shrink-0">
        {count} {count === 1 ? "note" : "notes"}
      </Badge>
    </button>
  );
}

export interface PeopleTabProps {
  onOpenProfile?(pubkey: string): void;
}

export function PeopleTab({ onOpenProfile }: PeopleTabProps) {
  const { authors, sampleSize, loading } = useActiveAuthors({
    sampleSize: 500,
    limit: 60,
    subscribe: true,
  });

  if (loading) {
    return (
      <div className="flex flex-col">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-border/50 px-4 py-2.5"
          >
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (authors.length === 0) {
    return (
      <EmptyState
        icon={<Users className="size-6" />}
        title="Nobody in your local index yet"
        description="This ranks the authors of notes this client has already received. Nothing has arrived — either the relays have not answered yet, or none of them is reachable. Check relay status in the panel beside the feed."
      />
    );
  }

  return (
    <div className="flex flex-col">
      <p className="px-4 py-2.5 text-xs text-muted-foreground">
        People whose notes reached this client, ranked by how often they appear
        in the newest {sampleSize} notes of your local index. Not a network-wide
        ranking — Setu runs no crawler.
      </p>
      {authors.map((entry) => (
        <PersonRow
          key={entry.author.pubkey}
          entry={entry}
          onOpenProfile={onOpenProfile}
        />
      ))}
    </div>
  );
}
