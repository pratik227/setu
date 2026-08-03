import type { NostrEvent } from "@setu/protocol";
import { encodeNpub, truncateNpub } from "@setu/protocol";
import { Button, Spinner } from "@setu/ui";
import { Check, ShieldAlert } from "lucide-react";
import { relativeTime } from "../notes/relativeTime";
import type { AuthorView } from "../notes/types";
import type { CommunityWrites } from "./useCommunityWrites";

/**
 * The moderator's queue: posts submitted to a community and not yet approved.
 *
 * Shown only to a moderator, and kept visually distinct from the approved feed
 * below it — a queue that looked like the community would defeat the point of
 * having one, because a moderator could not tell what they had already admitted.
 *
 * ## Approve, and nothing else
 *
 * NIP-72 has no rejection event. A moderator declines by not approving, so there is
 * no Reject button here: a control that publishes nothing and notifies nobody would
 * leave the moderator believing the author had been told something. The absence is
 * the honest design, and the caption says why so it does not read as missing.
 *
 * ## What approving actually does is stated before it is done
 *
 * A kind-4550 is signed by the moderator, is public, embeds the post, and cannot be
 * withdrawn except by a deletion request relays may ignore. That is more than
 * "approve" usually implies, so the caption says it once, above the list, rather
 * than in a tooltip nobody opens.
 */
export function ModerationQueue({
  posts,
  authors,
  writes,
  onOpenProfile,
}: {
  posts: readonly NostrEvent[];
  authors: ReadonlyMap<string, AuthorView>;
  writes: CommunityWrites;
  onOpenProfile?(pubkey: string): void;
}) {
  if (posts.length === 0) return null;

  const pending =
    writes.approveState.status === "working"
      ? writes.approveState.postId
      : undefined;

  return (
    <section className="border-b border-border/50 bg-muted/20">
      <div className="px-4 pt-3">
        <h3 className="text-xs font-semibold">
          Awaiting your approval ({posts.length})
        </h3>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          Approving publishes a signed, public record that you admitted the
          post, with a copy of it attached. There is no reject: declining means
          leaving it here, and the author is not notified either way.
        </p>
      </div>

      {writes.approveState.status === "error" ? (
        <p className="mx-4 mt-2 flex items-start gap-1.5 text-2xs text-destructive">
          <ShieldAlert className="mt-0.5 size-3 shrink-0" />
          <span className="flex-1">{writes.approveState.message}</span>
          <button
            type="button"
            onClick={writes.resetApprove}
            className="shrink-0 underline hover:no-underline"
          >
            Dismiss
          </button>
        </p>
      ) : null}

      <ul className="flex flex-col gap-2 px-4 py-3">
        {posts.map((post) => {
          const author = authors.get(post.pubkey);
          const npub = encodeNpub(post.pubkey);
          return (
            <li
              key={post.id}
              className="rounded-lg border border-border/60 bg-background p-3"
            >
              <div className="flex items-baseline gap-2 text-2xs text-muted-foreground">
                <button
                  type="button"
                  onClick={() => onOpenProfile?.(post.pubkey)}
                  className="truncate font-medium text-foreground hover:underline"
                >
                  {author?.resolved
                    ? author.displayName
                    : npub
                      ? truncateNpub(npub, 8)
                      : post.pubkey.slice(0, 12)}
                </button>
                <span>{relativeTime(post.created_at)}</span>
              </div>
              {/* Plain text, deliberately: an unapproved post is content a
                  moderator is deciding about, and rendering its embeds would give
                  a stranger a way to put images on a moderator's screen before
                  anyone admitted them. */}
              <p className="mt-1 text-sm break-words whitespace-pre-wrap">
                {post.content}
              </p>
              <div className="mt-2">
                <Button
                  size="xs"
                  disabled={pending !== undefined}
                  onClick={() => void writes.approve(post)}
                >
                  {pending === post.id ? (
                    <Spinner size={12} aria-hidden />
                  ) : (
                    <Check />
                  )}
                  Approve
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
