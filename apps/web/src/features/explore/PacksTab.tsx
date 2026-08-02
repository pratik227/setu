import { type FollowPack, newMembers } from "@setu/protocol";
import { Button, EmptyState, Skeleton } from "@setu/ui";
import { ShieldAlert, UserPlus, Users } from "lucide-react";
import { useSession } from "../identity/SessionProvider";
import { useFollows } from "../identity/useFollows";
import { useApplyFollowPack } from "./useApplyFollowPack";
import { useFollowPacks } from "./useFollowPacks";

/**
 * Follow packs: somebody's curated list of people, applied in one action.
 *
 * This exists for the first five minutes. A new account follows nobody, so its
 * feed is empty, and an empty feed is indistinguishable from a broken client —
 * every other remedy needs a name the newcomer does not have yet.
 *
 * ## What the button promises is what it does
 *
 * The count is of people **not already followed**, recomputed against the live
 * follow list. "Follow 24 people" on a pack where 21 are already followed is a
 * false statement about what pressing it changes, and the second pack a user
 * applies is exactly where that shows up.
 *
 * ## No ranking, and the tab says so
 *
 * There is no authority on which packs are good — that needs an indexer and a
 * notion of reputation Setu does not have. So these are "packs your relays happen
 * to carry", newest first, and the caption states that rather than implying a
 * recommendation. A pack is a stranger's opinion; the title, description and image
 * are their words, and the member count is the only number here Setu computed.
 */

function PackCard({
  pack,
  following,
  onApply,
  busy,
  canSign,
}: {
  pack: FollowPack;
  following: ReadonlySet<string>;
  onApply(pack: FollowPack): void;
  busy: boolean;
  canSign: boolean;
}) {
  const fresh = newMembers(pack, following);
  const allFollowed = fresh.length === 0;

  return (
    <li className="rounded-lg border border-border/60 p-3">
      <div className="flex items-start gap-3">
        {pack.image ? (
          // Decorative: the title beside it is the accessible name, and alt text
          // taken from a stranger's tag would be unverifiable either way.
          <img
            src={pack.image}
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
          <p className="truncate text-sm font-medium">{pack.title}</p>
          {pack.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {pack.description}
            </p>
          ) : null}
          <p className="mt-1 text-2xs text-muted-foreground">
            {pack.pubkeys.length}{" "}
            {pack.pubkeys.length === 1 ? "person" : "people"}
            {allFollowed ? " — you already follow all of them" : null}
          </p>
        </div>

        <Button
          size="xs"
          variant={allFollowed ? "outline" : "default"}
          disabled={busy || allFollowed || !canSign}
          onClick={() => onApply(pack)}
          title={
            canSign
              ? undefined
              : "Read-only session — sign in with a key to follow people"
          }
        >
          <UserPlus />
          {/* The honest count: what pressing this actually changes. */}
          {allFollowed ? "Followed" : `Follow ${fresh.length}`}
        </Button>
      </div>
    </li>
  );
}

export interface PacksTabProps {
  onOpenProfile?(pubkey: string): void;
}

export function PacksTab(_props: PacksTabProps) {
  const { packs, loaded } = useFollowPacks();
  const follows = useFollows();
  const { session } = useSession();
  const { state, apply } = useApplyFollowPack();

  const following = new Set(follows.authors);
  const busyAddress = state.status === "working" ? state.address : undefined;

  if (!loaded) {
    return (
      <div className="flex flex-col gap-2 px-4 py-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  if (packs.length === 0) {
    return (
      <EmptyState
        icon={<Users className="size-6" />}
        title="No follow packs on your relays"
        description="A follow pack is a list of people someone published for others to follow (NIP-51). None of the relays you read carry one right now — they cannot be searched for, only received."
      />
    );
  }

  return (
    <div className="flex flex-col">
      <p className="px-4 pt-2.5 text-xs text-muted-foreground">
        Lists of people, published by other users for others to follow. These
        are the ones your relays carry, newest first — not a ranking, and not a
        recommendation from Setu.
      </p>

      {state.status === "error" ? (
        <p className="mx-4 mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{state.message}</span>
        </p>
      ) : null}
      {state.status === "done" ? (
        <p className="mx-4 mt-2 text-xs text-muted-foreground">
          {state.added > 0
            ? `Followed ${state.added} ${state.added === 1 ? "person" : "people"}. Their notes will start arriving in Home.`
            : "You already followed everyone in that pack."}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2 px-4 py-3">
        {packs.map((pack) => (
          <PackCard
            key={pack.address}
            pack={pack}
            following={following}
            onApply={(p) => void apply(p)}
            busy={busyAddress === pack.address}
            canSign={session?.canSign === true}
          />
        ))}
      </ul>
    </div>
  );
}
