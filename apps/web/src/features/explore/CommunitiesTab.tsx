import type { Community } from "@setu/protocol";
import { Button, EmptyState, Skeleton } from "@setu/ui";
import { ShieldCheck, Users } from "lucide-react";
import { useCommunities } from "../communities/useCommunities";

/**
 * Browsing NIP-72 communities carried by the configured relays.
 *
 * Unranked and newest-first, with the caption saying so — the same position the
 * follow-pack tab takes, and for the same reason: ordering by anything other than
 * recency would be a recommendation Setu has no basis to make.
 *
 * The moderator count is shown on the card because it is the one number that says
 * what kind of place a community is. A community with one moderator and a community
 * with twelve are different propositions, and it is the only thing visible before
 * opening that is a fact rather than the author's own copy.
 */

function CommunityCard({
  community,
  onOpen,
}: {
  community: Community;
  onOpen(address: string): void;
}) {
  return (
    <li className="rounded-lg border border-border/60 p-3">
      <div className="flex items-start gap-3">
        {community.image ? (
          // Decorative: the name beside it is the accessible label, and alt text
          // from a stranger's tag would be unverifiable anyway.
          <img
            src={community.image}
            alt=""
            loading="lazy"
            className="size-10 shrink-0 rounded-md object-cover"
          />
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <Users className="size-4 text-muted-foreground" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{community.name}</p>
          {community.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {community.description}
            </p>
          ) : null}
          <p className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground">
            <ShieldCheck className="size-3" />
            {community.moderators.length}{" "}
            {community.moderators.length === 1 ? "moderator" : "moderators"}
          </p>
        </div>

        <Button
          size="xs"
          variant="outline"
          onClick={() => onOpen(community.address)}
        >
          Open
        </Button>
      </div>
    </li>
  );
}

export interface CommunitiesTabProps {
  onOpenCommunity(address: string): void;
}

export function CommunitiesTab({ onOpenCommunity }: CommunitiesTabProps) {
  const { communities, loaded } = useCommunities();

  if (!loaded) {
    return (
      <div className="flex flex-col gap-2 px-4 py-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  if (communities.length === 0) {
    return (
      <EmptyState
        icon={<Users className="size-6" />}
        title="No communities on your relays"
        description="A community (NIP-72) is a moderated space: anyone may post to it, and a moderator decides what appears. None of the relays you read carry one — communities live on the relays their moderators chose."
      />
    );
  }

  return (
    <div className="flex flex-col">
      <p className="px-4 pt-2.5 text-xs text-muted-foreground">
        Moderated spaces. Anyone can post; only what a moderator approves
        appears. These are the ones your relays carry, newest first — not a
        ranking.
      </p>
      <ul className="flex flex-col gap-2 px-4 py-3">
        {communities.map((community) => (
          <CommunityCard
            key={community.address}
            community={community}
            onOpen={onOpenCommunity}
          />
        ))}
      </ul>
    </div>
  );
}
