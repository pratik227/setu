import { type Conversation, conversationTitle } from "@setu/core";
import type { Hex32 } from "@setu/protocol";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  cn,
  EmptyState,
  Input,
  ScrollArea,
  Spinner,
} from "@setu/ui";
import { Lock, Send, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../identity/SessionProvider";
import { relativeTime } from "../notes/relativeTime";
import { useAuthors } from "../profiles/useAuthors";
import { useDirectMessages } from "./DirectMessagesProvider";
import { planDmDelivery, undeliverableMessage } from "./dmDelivery";
import { isConversationUnread } from "./unreadConversations";
import { type DmRelayLists, useDmRelayLists } from "./useDmRelayLists";
import { useSendMessage } from "./useSendMessage";

/**
 * Private messages.
 *
 * Two panes: conversations on the left, the open one on the right. The layout is
 * conventional on purpose — the interesting decisions here are all about what the
 * screen refuses to imply.
 *
 * **It never claims a message is private when it is not.** A read-only session
 * cannot decrypt, so it gets an explanation rather than an empty list that looks
 * like "no messages".
 *
 * **Undeliverable is stated, not swallowed.** NIP-17 delivery depends on the
 * recipient having published a kind-10050. When they have not, sending fails with
 * that reason instead of appearing to succeed — and the screen says so *before* a
 * message is typed, but only once the answer is actually known. Those lists are
 * fetched here for every participant of every conversation (`useDmRelayLists`),
 * which is also what makes the first send in a conversation instant instead of a
 * round trip the user waits through.
 *
 * **Wraps we could not open are counted.** An inbox always contains some; hiding
 * them would mean silently dropping messages someone believes they sent.
 */

export interface ChatScreenProps {
  onOpenProfile?(pubkey: string): void;
}

export function ChatScreen({ onOpenProfile }: ChatScreenProps) {
  const { session } = useSession();
  // The app's inbox, not this screen's: the subscription and the decryption cache
  // outlive the screen so a message arriving on another route is still received.
  const {
    conversations,
    loading,
    undecryptable,
    canRead,
    lastReadAt,
    markRead,
  } = useDirectMessages();
  const [openId, setOpenId] = useState<string | undefined>();

  const open = useMemo(
    () => conversations.find((c) => c.id === openId),
    [conversations, openId],
  );

  // Everyone across every conversation, so names resolve once for both panes.
  const pubkeys = useMemo(
    () => [...new Set(conversations.flatMap((c) => c.participants))],
    [conversations],
  );
  const authors = useAuthors(pubkeys);
  // Held for the whole screen, not per conversation: a kind-10050 is replaceable,
  // so one REQ covers every participant and opening a conversation costs nothing.
  const dmRelays = useDmRelayLists(pubkeys);
  const nameOf = useCallback(
    (pubkey: Hex32) => {
      const author = authors.get(pubkey);
      return author?.resolved ? author.displayName : undefined;
    },
    [authors],
  );

  useEffect(() => {
    if (open) markRead(open.id, open.updatedAt);
  }, [open, markRead]);

  if (!session) {
    return (
      <EmptyState
        title="Sign in to read your messages"
        description="Private messages are encrypted to your key, so there is nothing to decrypt until this client has one."
      />
    );
  }

  if (!canRead) {
    return (
      <EmptyState
        title="This session cannot read private messages"
        description="Messages are encrypted to your key. A read-only session has no key to decrypt them with — unlock or sign in with a key, or use an extension that supports NIP-44."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Conversation list.
          `basis-72` with `shrink-0` rather than `w-72` alone: a flex item's
          default `min-width: auto` resolves to its min-content, and a sibling
          whose content cannot wrap will otherwise win the width negotiation. */}
      <div className="flex w-72 shrink-0 basis-72 flex-col border-r border-border/60">
        <ScrollArea className="flex-1">
          {loading && conversations.length === 0 ? (
            <div className="flex justify-center py-12">
              <Spinner aria-label="Loading messages" />
            </div>
          ) : conversations.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">
              No conversations yet.
            </p>
          ) : (
            <ul>
              {conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === openId}
                  // The same predicate the sidebar badge counts with, so a lit
                  // badge always has a bold row to point at.
                  unread={isConversationUnread(
                    conversation,
                    session.pubkey,
                    lastReadAt,
                  )}
                  title={conversationTitle(conversation, nameOf)}
                  avatarUrl={
                    authors.get(conversation.others[0] ?? "")?.avatarUrl
                  }
                  onOpen={() => setOpenId(conversation.id)}
                />
              ))}
            </ul>
          )}

          {/* Never hidden: a wrap we cannot open may be a message someone
              believes they sent. */}
          {undecryptable > 0 ? (
            <p className="border-t border-border/50 px-4 py-2 text-2xs text-muted-foreground">
              {undecryptable} {undecryptable === 1 ? "message" : "messages"}{" "}
              could not be decrypted and {undecryptable === 1 ? "is" : "are"}{" "}
              not shown.
            </p>
          ) : null}
        </ScrollArea>
      </div>

      {/* Open conversation */}
      {open ? (
        <ConversationView
          conversation={open}
          viewer={session.pubkey as Hex32}
          title={conversationTitle(open, nameOf)}
          nameOf={nameOf}
          avatarFor={(pubkey) => authors.get(pubkey)?.avatarUrl}
          dmRelays={dmRelays}
          {...(onOpenProfile ? { onOpenProfile } : {})}
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <div className="max-w-xs text-center">
            <Lock className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">Pick a conversation</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Messages are sealed and gift-wrapped, so relays can see neither
              what you wrote nor who you wrote it to.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  unread,
  title,
  avatarUrl,
  onOpen,
}: {
  conversation: Conversation;
  active: boolean;
  unread: boolean;
  title: string;
  avatarUrl?: string;
  onOpen(): void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
          "duration-(--motion-duration-instant) hover:bg-accent/60",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
          active && "bg-accent",
        )}
      >
        <Avatar className="size-9">
          {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
          <AvatarFallback>{title.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                unread ? "font-semibold" : "font-medium",
              )}
            >
              {/* Empty while a single participant's name is still resolving —
                  a truncated npub here would be replaced a second later. */}
              {title || " "}
            </span>
            <span className="shrink-0 text-2xs text-muted-foreground">
              {relativeTime(conversation.updatedAt)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                unread ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {conversation.lastMessage.isFile
                ? "Sent a file"
                : conversation.lastMessage.content}
            </span>
            {/* Decorative. The row is already announced as unread by the
                bolder label; a second announcement would say it twice. */}
            {unread ? (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-primary"
              />
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function ConversationView({
  conversation,
  viewer,
  title,
  nameOf,
  avatarFor,
  dmRelays,
  onOpenProfile,
}: {
  conversation: Conversation;
  viewer: Hex32;
  title: string;
  nameOf(pubkey: Hex32): string | undefined;
  avatarFor(pubkey: Hex32): string | undefined;
  dmRelays: DmRelayLists;
  onOpenProfile?(pubkey: string): void;
}) {
  const [draft, setDraft] = useState("");
  const { state, send, reset } = useSendMessage();
  const bottom = useRef<HTMLDivElement>(null);

  /*
   * Who in this conversation has published no inbox — said before a message is
   * typed rather than after one is written and refused.
   *
   * The same plan and the same words the send path uses, so a warning here and the
   * error there can never disagree. Only *confirmed* absences are reported:
   * `plan.unconfirmed` is dropped on purpose, because a list that has not arrived
   * yet is not a list that does not exist, and a warning that cannot tell the
   * difference is one readers learn to ignore.
   */
  const undeliverable = useMemo(() => {
    const plan = planDmDelivery({
      // The viewer is included: our own copy needs an inbox too, and a
      // conversation we cannot keep our half of is worth knowing about early.
      targets: [viewer, ...conversation.others],
      lists: dmRelays.lists,
      absenceConfirmed: dmRelays.absenceConfirmed,
    });
    if (plan.ok || plan.noInbox.length === 0) return undefined;
    return undeliverableMessage({
      author: viewer,
      noInbox: plan.noInbox,
      unconfirmed: [],
    });
  }, [conversation.others, dmRelays, viewer]);

  // Jump to the newest message when the conversation changes or one arrives.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [conversation.id, conversation.messages.length]);

  const submit = useCallback(async () => {
    const content = draft.trim();
    if (content === "" || state.status === "sending") return;
    const ok = await send({
      content,
      to: conversation.others,
      ...(conversation.subject ? { subject: conversation.subject } : {}),
    });
    // Cleared only on success. Discarding text the network never received is the
    // worst outcome available here.
    if (ok) setDraft("");
  }, [draft, send, conversation, state.status]);

  return (
    /*
     * `min-w-0` is load-bearing. Without it this pane's `min-width: auto`
     * resolves to its min-content, and a message containing a long unbreakable
     * string — a bare URL, which is most of what people paste into a chat —
     * makes that min-content wider than the surface. The pane then refuses to
     * shrink, and the conversation list beside it is crushed to a sliver.
     */
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title || "Conversation"}
        </h2>
        <span className="flex items-center gap-1 text-2xs text-muted-foreground">
          <Lock className="size-3" />
          End-to-end encrypted
        </span>
      </header>

      <ScrollArea className="flex-1 px-4 py-3">
        <ul className="flex flex-col gap-2">
          {conversation.messages.map((message) => {
            const mine = message.sender === viewer;
            return (
              <li
                key={message.id}
                className={cn("flex min-w-0 gap-2", mine && "flex-row-reverse")}
              >
                {!mine ? (
                  <button
                    type="button"
                    onClick={() => onOpenProfile?.(message.sender)}
                    aria-label={`Open ${nameOf(message.sender) ?? "sender"}'s profile`}
                    className="shrink-0 self-end rounded-full focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
                  >
                    <Avatar className="size-6">
                      {avatarFor(message.sender) ? (
                        <AvatarImage src={avatarFor(message.sender)} alt="" />
                      ) : null}
                      <AvatarFallback>
                        {(nameOf(message.sender) ?? "")
                          .slice(0, 1)
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </button>
                ) : null}
                <div
                  className={cn(
                    "max-w-[min(34rem,75%)] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
                    // `break-words` only breaks *between* words. A pasted URL is
                    // one word and would push the bubble past its max width;
                    // `anywhere` is the only thing that breaks inside it.
                    "[overflow-wrap:anywhere]",
                    mine
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground",
                  )}
                >
                  {message.content}
                  <span
                    className={cn(
                      "mt-1 block text-2xs",
                      mine
                        ? "text-primary-foreground/60"
                        : "text-muted-foreground",
                    )}
                  >
                    {relativeTime(message.createdAt)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <div ref={bottom} />
      </ScrollArea>

      {/* Suppressed while an error is showing: the send path's message is the
          more specific one, and stacking both says it twice. */}
      {undeliverable && state.status !== "error" ? (
        <p className="flex items-start gap-1.5 border-t border-warning/40 bg-warning-bg px-4 py-2 text-xs">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{undeliverable}</span>
        </p>
      ) : null}

      {state.status === "error" ? (
        <p className="flex items-start gap-1.5 border-t border-border/50 px-4 py-2 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{state.message}</span>
          <button
            type="button"
            onClick={reset}
            className="shrink-0 underline hover:no-underline"
          >
            Dismiss
          </button>
        </p>
      ) : null}

      <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Message"
          aria-label="Message"
          className="flex-1"
        />
        <Button
          size="icon"
          aria-label="Send"
          disabled={draft.trim() === "" || state.status === "sending"}
          onClick={() => void submit()}
        >
          {state.status === "sending" ? (
            <Spinner size={16} aria-hidden />
          ) : (
            <Send />
          )}
        </Button>
      </div>
    </div>
  );
}
