import {
  Button,
  ContentHeader,
  EmptyState,
  ScrollArea,
  Skeleton,
} from "@setu/ui";
import { Compass, ShieldAlert, ShieldCheck, Users } from "lucide-react";
import { useSession } from "../identity/SessionProvider";
import { useCommunities } from "./useCommunities";
import { useCommunityMembership } from "./useCommunityMembership";

/**
 * The communities this account has joined.
 *
 * Distinct from the Explore tab on purpose, and the split is the same one Wallet
 * got: **Explore is for discovering things you are not in; the sidebar is for the
 * ones you are.** A sidebar row that opened the same browse list would be a second
 * door to one room, which is what the Wallet-in-Settings arrangement was.
 *
 * ## A joined community whose definition is missing is still listed
 *
 * The membership list holds addresses; the definitions come from relays and may not
 * arrive — a community can live on relays this account does not read. Dropping
 * those rows would silently shrink a list the user curated, so an unresolved
 * membership is shown as its address with a note. It is a real membership either
 * way, and leaving it is the one action that still works without the definition.
 */
export interface CommunitiesScreenProps {
  onOpenCommunity(address: string): void;
  onBrowse(): void;
}

export function CommunitiesScreen({
  onOpenCommunity,
  onBrowse,
}: CommunitiesScreenProps) {
  const { session } = useSession();
  const membership = useCommunityMembership();
  const { communities, loaded: catalogLoaded } = useCommunities();

  if (!session) {
    return (
      <EmptyState
        icon={<Users className="size-6" />}
        title="Sign in to keep a list of communities"
        description="Your communities are a list published under your key (NIP-51), so there is nothing to load until this client has one. Browsing communities needs no account."
      />
    );
  }

  const byAddress = new Map(communities.map((c) => [c.address, c]));
  const busy =
    membership.state.status === "working"
      ? membership.state.address
      : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContentHeader>
        <h2 className="text-sm font-semibold">Communities</h2>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          onClick={onBrowse}
        >
          <Compass />
          Browse all
        </Button>
      </ContentHeader>

      <ScrollArea>
        {membership.state.status === "error" ? (
          <p className="mx-4 mt-3 flex items-start gap-1.5 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1">{membership.state.message}</span>
            <button
              type="button"
              onClick={membership.dismissError}
              className="shrink-0 underline hover:no-underline"
            >
              Dismiss
            </button>
          </p>
        ) : null}

        {!membership.loaded && !catalogLoaded ? (
          <div className="flex flex-col gap-2 px-4 py-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : membership.joined.length === 0 ? (
          <EmptyState
            icon={<Users className="size-6" />}
            title="You have not joined any communities"
            description="A community is a moderated space: anyone can post, and a moderator decides what appears. Joining publishes a public list under your key — it is closer to a follow than to a membership."
            action={
              <Button size="sm" onClick={onBrowse}>
                <Compass />
                Browse communities
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2 px-4 py-3">
            {membership.joined.map((address) => {
              const community = byAddress.get(address);
              return (
                <li
                  key={address}
                  className="rounded-lg border border-border/60 p-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      {community ? (
                        <>
                          <button
                            type="button"
                            onClick={() => onOpenCommunity(address)}
                            className="truncate text-sm font-medium hover:underline"
                          >
                            {community.name}
                          </button>
                          <p className="mt-0.5 flex items-center gap-1 text-2xs text-muted-foreground">
                            <ShieldCheck className="size-3" />
                            {community.moderators.length}{" "}
                            {community.moderators.length === 1
                              ? "moderator"
                              : "moderators"}
                          </p>
                        </>
                      ) : (
                        <>
                          {/* Listed rather than dropped — see the module doc. */}
                          <p className="setu-mono truncate text-xs">
                            {address.split(":")[2] ?? address}
                          </p>
                          <p className="mt-0.5 text-2xs text-muted-foreground">
                            No relay you read carries this community's
                            definition, so its posts cannot be shown here.
                          </p>
                        </>
                      )}
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== undefined}
                      onClick={() => void membership.toggle(address)}
                    >
                      Leave
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
