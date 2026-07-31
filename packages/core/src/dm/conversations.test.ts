import type { ChatMessage, Hex32 } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  conversationTitle,
  groupConversations,
  unreadConversations,
} from "./conversations";

const ME = "1".repeat(64) as Hex32;
const BOB = "2".repeat(64) as Hex32;
const CAROL = "3".repeat(64) as Hex32;

let counter = 0;
function message(over: Partial<ChatMessage> = {}): ChatMessage {
  counter += 1;
  return {
    id: String(counter).padStart(64, "0") as Hex32,
    sender: BOB,
    participants: [ME, BOB].sort(),
    content: "hi",
    createdAt: 1000,
    isFile: false,
    ...over,
  };
}

describe("groupConversations", () => {
  it("groups by participant set regardless of who sent each message", () => {
    const conversations = groupConversations(
      [
        message({ sender: BOB, createdAt: 1 }),
        message({ sender: ME, createdAt: 2 }),
      ],
      ME,
    );
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.messages).toHaveLength(2);
  });

  it("keeps a group chat separate from the one-to-one", () => {
    const conversations = groupConversations(
      [
        message({ participants: [ME, BOB].sort() }),
        message({ participants: [ME, BOB, CAROL].sort() }),
      ],
      ME,
    );
    expect(conversations).toHaveLength(2);
  });

  it("deduplicates the same message arriving from several relays", () => {
    // The same rumor id reaches us once per relay carrying it. A conversation
    // showing every copy is unusable on a well-connected client.
    const duplicate = message({ createdAt: 5 });
    const conversations = groupConversations(
      [duplicate, { ...duplicate }, { ...duplicate }],
      ME,
    );
    expect(conversations[0]?.messages).toHaveLength(1);
  });

  it("orders messages oldest first, by the rumor's own timestamp", () => {
    // Never the gift wrap's: wrapper timestamps are jittered by up to two days to
    // defeat correlation, so sorting by one shuffles the conversation.
    const conversations = groupConversations(
      [
        message({ content: "third", createdAt: 30 }),
        message({ content: "first", createdAt: 10 }),
        message({ content: "second", createdAt: 20 }),
      ],
      ME,
    );
    expect(conversations[0]?.messages.map((m) => m.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("breaks timestamp ties deterministically", () => {
    // Otherwise the order depends on which relay answered first and the list
    // reshuffles between renders.
    const a = message({ id: "a".repeat(64) as Hex32, createdAt: 7 });
    const b = message({ id: "b".repeat(64) as Hex32, createdAt: 7 });
    const first = groupConversations([a, b], ME)[0]?.messages.map((m) => m.id);
    const second = groupConversations([b, a], ME)[0]?.messages.map((m) => m.id);
    expect(first).toEqual(second);
  });

  it("sorts conversations by most recent activity", () => {
    const conversations = groupConversations(
      [
        message({ participants: [ME, BOB].sort(), createdAt: 10 }),
        message({ participants: [ME, CAROL].sort(), createdAt: 50 }),
      ],
      ME,
    );
    expect(conversations[0]?.updatedAt).toBe(50);
    expect(conversations[1]?.updatedAt).toBe(10);
  });

  it("excludes the viewer from `others`", () => {
    const [conversation] = groupConversations([message()], ME);
    expect(conversation?.others).toEqual([BOB]);
    expect(conversation?.participants).toContain(ME);
  });

  it("takes the newest subject when one was set", () => {
    // Renaming a thread should take effect; the newest message is the most recent
    // statement of what it is called.
    const [conversation] = groupConversations(
      [
        message({ createdAt: 10, subject: "Old name" }),
        message({ createdAt: 20, subject: "New name" }),
        message({ createdAt: 30 }),
      ],
      ME,
    );
    expect(conversation?.subject).toBe("New name");
  });

  it("returns nothing for no messages", () => {
    expect(groupConversations([], ME)).toEqual([]);
  });
});

describe("conversationTitle", () => {
  const names = new Map<string, string>([[BOB, "Bob"]]);
  const nameOf = (pubkey: Hex32) => names.get(pubkey);

  it("prefers an explicit subject", () => {
    const [conversation] = groupConversations(
      [message({ subject: "Invoice" })],
      ME,
    );
    expect(conversationTitle(conversation!, nameOf)).toBe("Invoice");
  });

  it("uses resolved names", () => {
    const [conversation] = groupConversations([message()], ME);
    expect(conversationTitle(conversation!, nameOf)).toBe("Bob");
  });

  it("falls back to a count rather than truncated pubkeys", () => {
    // Three unreadable hex fragments tell the reader nothing, and they shift as
    // names resolve one at a time.
    const [conversation] = groupConversations(
      [message({ participants: [ME, BOB, CAROL].sort() })],
      ME,
    );
    expect(conversationTitle(conversation!, nameOf)).toBe("2 people");
  });

  it("names a conversation with only yourself", () => {
    const [conversation] = groupConversations(
      [message({ participants: [ME], sender: ME })],
      ME,
    );
    expect(conversationTitle(conversation!, nameOf)).toBe("Notes to self");
  });
});

describe("unreadConversations", () => {
  it("counts a newer message from someone else as unread", () => {
    const conversations = groupConversations(
      [message({ sender: BOB, createdAt: 100 })],
      ME,
    );
    expect(
      unreadConversations(
        conversations,
        ME,
        new Map([[conversations[0]!.id, 50]]),
      ),
    ).toHaveLength(1);
  });

  it("does not count our own message as unread", () => {
    // Sending something is reading it.
    const conversations = groupConversations(
      [message({ sender: ME, createdAt: 100 })],
      ME,
    );
    expect(unreadConversations(conversations, ME, new Map())).toHaveLength(0);
  });

  it("respects a read mark at or after the last message", () => {
    const conversations = groupConversations(
      [message({ sender: BOB, createdAt: 100 })],
      ME,
    );
    expect(
      unreadConversations(
        conversations,
        ME,
        new Map([[conversations[0]!.id, 100]]),
      ),
    ).toHaveLength(0);
  });

  it("treats a never-read conversation as unread", () => {
    const conversations = groupConversations(
      [message({ sender: BOB, createdAt: 1 })],
      ME,
    );
    expect(unreadConversations(conversations, ME, new Map())).toHaveLength(1);
  });
});
