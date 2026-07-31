import type { Conversation } from "@setu/core";
import type { ChatMessage } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  countUnreadConversations,
  isConversationUnread,
} from "./unreadConversations";

/**
 * The badge and the bold row have to agree.
 *
 * A count that will not clear is worse than no count: it tells the user they have mail
 * and gives them nowhere to find it. So the predicate is tested on its own, and both
 * surfaces call this one function.
 */

const ME = "m".repeat(64);
const THEM = "t".repeat(64);

function conversation(over: {
  id?: string;
  sender?: string;
  updatedAt?: number;
}): Conversation {
  const sender = over.sender ?? THEM;
  const updatedAt = over.updatedAt ?? 2000;
  const lastMessage = {
    id: "1".repeat(64),
    sender,
    recipients: [sender === ME ? THEM : ME],
    content: "hello",
    createdAt: updatedAt,
  } as unknown as ChatMessage;
  return {
    id: over.id ?? "conv-1",
    participants: [ME, THEM],
    others: [THEM],
    messages: [lastMessage],
    lastMessage,
    updatedAt,
  } as unknown as Conversation;
}

describe("isConversationUnread", () => {
  it("is unread when their message is newer than the mark", () => {
    expect(
      isConversationUnread(conversation({ updatedAt: 2000 }), ME, new Map()),
    ).toBe(true);
  });

  it("is read once the mark reaches the newest message", () => {
    expect(
      isConversationUnread(
        conversation({ updatedAt: 2000 }),
        ME,
        new Map([["conv-1", 2000]]),
      ),
    ).toBe(false);
  });

  it("is never unread when we sent the last message", () => {
    // Sending is reading. Without this every conversation the user just replied in
    // comes back bold, and the badge counts their own messages back to them.
    expect(
      isConversationUnread(
        conversation({ sender: ME, updatedAt: 9999 }),
        ME,
        new Map(),
      ),
    ).toBe(false);
  });

  it("goes unread again when a newer message arrives after the mark", () => {
    const marks = new Map([["conv-1", 2000]]);
    expect(
      isConversationUnread(conversation({ updatedAt: 2001 }), ME, marks),
    ).toBe(true);
  });

  it("treats a missing mark as never read, not as read", () => {
    // The default has to be 0. Defaulting to "now" would silently swallow every
    // message that arrived before the first visit to Messages.
    expect(
      isConversationUnread(conversation({ updatedAt: 1 }), ME, new Map()),
    ).toBe(true);
  });

  it("does not treat an equal timestamp as unread", () => {
    // `updatedAt > mark`, not `>=`: opening a conversation marks it at exactly its
    // newest timestamp, and an off-by-one here would leave it permanently lit.
    expect(
      isConversationUnread(
        conversation({ updatedAt: 500 }),
        ME,
        new Map([["conv-1", 500]]),
      ),
    ).toBe(false);
  });
});

describe("countUnreadConversations", () => {
  it("counts conversations, not messages", () => {
    const conversations = [
      conversation({ id: "a", updatedAt: 10 }),
      conversation({ id: "b", updatedAt: 20 }),
      conversation({ id: "c", sender: ME, updatedAt: 30 }),
      conversation({ id: "d", updatedAt: 40 }),
    ];
    const marks = new Map([["b", 20]]);

    // a and d: b is marked read, c is ours.
    expect(countUnreadConversations(conversations, ME, marks)).toBe(2);
  });

  it("is zero for an empty inbox", () => {
    expect(countUnreadConversations([], ME, new Map())).toBe(0);
  });

  it("does not gate on the session, and does not need to", () => {
    // With no viewer nothing can match "we sent it", so every conversation counts.
    // That is safe rather than sloppy: a decrypted conversation only exists for a
    // session that had a key to decrypt it with, so the signed-out case is an empty
    // list, not a miscounted one. Asserted so the reasoning is on the record if
    // anyone later hands this a viewer-less inbox.
    const conversations = [conversation({ id: "a", updatedAt: 10 })];
    expect(countUnreadConversations(conversations, undefined, new Map())).toBe(
      1,
    );
    expect(countUnreadConversations([], undefined, new Map())).toBe(0);
  });
});
