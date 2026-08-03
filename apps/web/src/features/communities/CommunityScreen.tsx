import type { Community } from "@setu/protocol";
import {
  Badge,
  Button,
  ContentHeader,
  EmptyState,
  ScrollArea,
  Skeleton,
} from "@setu/ui";
import { ShieldCheck, Users } from "lucide-react";
import { useMemo, useRef } from "react";
import { useSession } from "../identity/SessionProvider";
import { useInteractions } from "../notes/useInteractions";
import { useNoteRowActions } from "../notes/useNoteRowActions";
import { useAuthors } from "../profiles/useAuthors";
import { ThreadRow } from "../thread/ThreadRow";
import { threadNoteViews } from "../thread/threadViews";
import { CommunitySubmit } from "./CommunitySubmit";
import { ModerationQueue } from "./ModerationQueue";
import { useCommunity } from "./useCommunities";
import { useCommunityFeed } from "./useCommunityFeed";
import { useCommunityMembership } from "./useCommunityMembership";
import { useCommunityWrites } from "./useCommunityWrites";

/**
 * One community: its approved posts, and an honest account of what is missing.
 *
 * Three numbers can be true at once here and they mean different things, so the
 * header states them separately rather than collapsing them into one count:
 *
 *  - **approved posts** — what moderators admitted, verified. The list.
 *  - **awaiting moderation** — posts claiming the community with no valid
 *    approval. Counted, never listed: showing them would be exactly the failure
 *    this feature exists to avoid, and a reader cannot tell a pending post from an
 *    admitted one once it is in the same list.
 *  - **approved but unavailable** — a moderator admitted a post and no copy of it
 *    can be shown. That is not un-moderated content; it is missing content, and
 *    silently dropping it would understate what the community holds.
 *
 * Rows reuse `ThreadRow` rather than the feed's virtualised list: a community's
 * approved set is bounded by the approval subscription, so there is nothing to
 * virtualise, and reimplementing a note row to get one is how two note renderers
 * drift apart.
 */
export interface CommunityScreenProps {
  address: string;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}

export function CommunityScreen({
  address,
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
}: CommunityScreenProps) {
  const community = useCommunity(address);
  const feed = useCommunityFeed(community);
  const writes = useCommunityWrites(community);
  const membership = useCommunityMembership();
  const { session } = useSession();

  // Rows newer than the moment the screen opened get the arrival motion.
  const mountedAt = useRef(Math.floor(Date.now() / 1000));

  const pubkeys = useMemo(
    () => [
      ...new Set([
        ...feed.posts.map((post) => post.pubkey),
        ...feed.pendingPosts.map((post) => post.pubkey),
        ...(community?.moderators ?? []),
      ]),
    ],
    [feed.posts, feed.pendingPosts, community],
  );
  const authors = useAuthors(pubkeys);
  const noteIds = useMemo(
    () => feed.posts.map((post) => post.id),
    [feed.posts],
  );
  const interactions = useInteractions(noteIds, session?.pubkey);

  const views = useMemo(
    () => threadNoteViews(feed.posts, authors, interactions, mountedAt.current),
    [feed.posts, authors, interactions],
  );

  const eventsById = useMemo(
    () => new Map(feed.posts.map((post) => [post.id, post])),
    [feed.posts],
  );
  const { actions, statuses } = useNoteRowActions(eventsById);

  if (community === undefined) {
    return (
      <EmptyState
        icon={<Users className="size-6" />}
        title="Community not found"
        description="No relay you read is carrying a definition for this community. It may exist elsewhere — a community lives on the relays its moderators chose."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContentHeader>
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {community.name}
        </h2>
        <Badge variant="secondary" className="text-2xs">
          <ShieldCheck className="size-3" />
          {community.moderators.length}{" "}
          {community.moderators.length === 1 ? "moderator" : "moderators"}
        </Badge>
        {session?.canSign ? (
          <Button
            size="xs"
            variant={membership.isJoined(address) ? "outline" : "default"}
            className="ml-auto"
            disabled={membership.state.status === "working"}
            onClick={() =>
              void membership.toggle(
                address,
                community.relays.all[0] ?? community.relays.author[0],
              )
            }
            // Said on the control itself: "join" usually implies a private
            // membership record on a server, and this is a public list anyone
            // reading your relays can see.
            title={
              membership.isJoined(address)
                ? "Remove this community from your public list"
                : "Adds this community to a public list published under your key"
            }
          >
            {membership.isJoined(address) ? "Joined" : "Join"}
          </Button>
        ) : null}
      </ContentHeader>

      <ScrollArea>
        {community.description ? (
          <p className="border-b border-border/50 px-4 py-3 text-xs text-muted-foreground">
            {community.description}
          </p>
        ) : null}

        <CommunitySubmit community={community} writes={writes} />

        {/* Moderators see the queue itself; everyone else sees only the count
            below. Same data, and the difference is deliberate: a reader cannot
            act on a pending post, and showing it beside approved ones is exactly
            what this feature refuses to do. */}
        {writes.canModerate ? (
          <ModerationQueue
            posts={feed.pendingPosts}
            authors={authors}
            writes={writes}
            {...(onOpenProfile ? { onOpenProfile } : {})}
          />
        ) : null}

        {/* Stated, not listed — see the module doc. */}
        {(feed.pending > 0 && !writes.canModerate) || feed.unresolved > 0 ? (
          <p className="border-b border-border/50 px-4 py-2 text-2xs text-muted-foreground">
            {feed.pending > 0 && !writes.canModerate
              ? `${feed.pending} ${feed.pending === 1 ? "post is" : "posts are"} awaiting moderation and not shown. `
              : null}
            {feed.unresolved > 0
              ? `${feed.unresolved} approved ${feed.unresolved === 1 ? "post" : "posts"} could not be shown — no copy reached this device that verified.`
              : null}
          </p>
        ) : null}

        {!feed.loaded ? (
          <div className="flex flex-col gap-2 px-4 py-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
        ) : feed.posts.length === 0 ? (
          <EmptyState
            icon={<Users className="size-6" />}
            title="Nothing approved yet"
            description={
              feed.pending > 0
                ? "Posts have been submitted but no moderator has approved any of them yet. Setu shows only approved posts, because an unapproved one is a request rather than community content."
                : "No moderator has approved a post here, and none of your relays carry one waiting."
            }
          />
        ) : (
          feed.posts.map((post) => {
            const view = views.get(post.id);
            if (!view) return null;
            return (
              <ThreadRow
                key={post.id}
                note={view}
                actions={actions}
                status={statuses.get(post.id)}
                {...(onOpenThread ? { onOpenThread } : {})}
                {...(onOpenProfile ? { onOpenProfile } : {})}
                {...(onOpenHashtag ? { onOpenHashtag } : {})}
              />
            );
          })
        )}
      </ScrollArea>
    </div>
  );
}
