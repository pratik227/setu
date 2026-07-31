import {
  Button,
  ContentHeader,
  EmptyState,
  ScrollArea,
  Skeleton,
} from "@setu/ui";
import { MessageSquareOff, X } from "lucide-react";
import { useMemo, useRef } from "react";
import { useSession } from "../identity/SessionProvider";
import { useInteractions } from "../notes/useInteractions";
import { useNoteRowActions } from "../notes/useNoteRowActions";
import { useAuthors } from "../profiles/useAuthors";
import { MissingNoteRow, ThreadRow } from "./ThreadRow";
import { threadEvents, threadNoteIds, threadPubkeys } from "./threadTree";
import { threadNoteViews } from "./threadViews";
import { useThread } from "./useThread";

function ThreadSkeleton() {
  return (
    <div className="flex gap-3 border-b border-border/50 px-4 py-3">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-3/5" />
      </div>
    </div>
  );
}

export interface ThreadViewProps {
  noteId: string;
  onClose?(): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
  /** Re-root the panel on another note in the conversation. */
  onOpenThread?(id: string): void;
}

/**
 * A conversation, for the auxiliary panel.
 *
 * The panel is ~380px, which drives two layout decisions. Indentation is capped
 * at three steps (enforced in `threadTree`, not here) so a deep chain keeps a
 * readable text column, and the ancestor chain renders in full rather than behind
 * a "show parents" affordance — a reply read without its parent is a different
 * statement, and the chain is short in practice.
 *
 * All three data sources are independent live queries: the thread itself, author
 * metadata, and interaction counts. Names and counts arrive well after the text,
 * and a reader should get the conversation immediately rather than waiting on
 * avatars.
 */
export function ThreadView({
  noteId,
  onClose,
  onOpenProfile,
  onOpenHashtag,
  onOpenThread,
}: ThreadViewProps) {
  const { tree, status } = useThread(noteId);
  const { session } = useSession();

  // Rows newer than the moment the panel opened are the ones worth animating.
  const mountedAt = useRef(Math.floor(Date.now() / 1000));

  const events = useMemo(() => threadEvents(tree), [tree]);
  const pubkeys = useMemo(() => threadPubkeys(tree), [tree]);
  const noteIds = useMemo(() => threadNoteIds(tree), [tree]);

  const authors = useAuthors(pubkeys);
  // Without the viewer's pubkey the heart and repost icons render inactive on
  // notes this account has already acted on, and invite acting twice.
  const interactions = useInteractions(noteIds, session?.pubkey);

  const views = useMemo(
    () => threadNoteViews(events, authors, interactions, mountedAt.current),
    [events, authors, interactions],
  );

  const eventsById = useMemo(
    () => new Map(events.map((event) => [event.id, event])),
    [events],
  );
  const actions = useNoteRowActions(eventsById);

  const replyCount = tree.replies.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContentHeader>
        <h2 className="text-sm font-semibold">Thread</h2>
        {status === "ready" && replyCount > 0 ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {replyCount} {replyCount === 1 ? "reply" : "replies"}
          </span>
        ) : null}
        {onClose ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close thread"
            className="ml-auto"
            onClick={onClose}
          >
            <X />
          </Button>
        ) : null}
      </ContentHeader>

      <ScrollArea>
        {status === "loading" ? (
          <>
            <ThreadSkeleton />
            <ThreadSkeleton />
          </>
        ) : status === "unavailable" ? (
          // Every relay in the read set answered and none of them had it. Saying
          // so is the only honest option: there is no "somewhere else" to try
          // without a relay hint, and inventing a placeholder note would put
          // fabricated content on screen.
          <EmptyState
            icon={<MessageSquareOff className="size-6" />}
            title="Note unavailable"
            description="None of the relays we asked returned this note. It may have been deleted, or it may live only on a relay that is not in the read set."
          />
        ) : (
          <>
            {tree.ancestors.map((slot) => {
              if (slot.type === "missing") {
                return <MissingNoteRow key={slot.id} id={slot.id} />;
              }
              const view = views.get(slot.id);
              if (!view) return null;
              return (
                <ThreadRow
                  key={slot.id}
                  note={view}
                  actions={actions}
                  {...(onOpenThread ? { onOpenThread } : {})}
                  {...(onOpenProfile ? { onOpenProfile } : {})}
                  {...(onOpenHashtag ? { onOpenHashtag } : {})}
                />
              );
            })}

            {tree.focused && views.get(tree.focused.id) ? (
              <ThreadRow
                focused
                note={views.get(tree.focused.id)!}
                actions={actions}
                {...(onOpenProfile ? { onOpenProfile } : {})}
                {...(onOpenHashtag ? { onOpenHashtag } : {})}
              />
            ) : null}

            {replyCount === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                No replies yet.
              </p>
            ) : (
              tree.replies.map((reply) => {
                const view = views.get(reply.event.id);
                if (!view) return null;
                return (
                  <ThreadRow
                    key={reply.event.id}
                    note={view}
                    actions={actions}
                    depth={reply.depth}
                    orphaned={reply.orphaned}
                    {...(onOpenThread ? { onOpenThread } : {})}
                    {...(onOpenProfile ? { onOpenProfile } : {})}
                    {...(onOpenHashtag ? { onOpenHashtag } : {})}
                  />
                );
              })
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
