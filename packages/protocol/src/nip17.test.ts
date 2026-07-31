import { describe, expect, it } from "vitest";
import { Kind } from "./kinds";
import {
  buildChatMessage,
  buildDmRelayList,
  chatParticipants,
  conversationId,
  deliveryTargets,
  parseDmRelayList,
  toChatMessage,
} from "./nip17";
import type { Rumor } from "./nip59";
import type { Hex32, NostrEvent } from "./types";

const ALICE = "a".repeat(64) as Hex32;
const BOB = "b".repeat(64) as Hex32;
const CAROL = "c".repeat(64) as Hex32;

function rumor(over: Partial<Rumor> = {}): Rumor {
  return {
    id: "1".repeat(64) as Hex32,
    pubkey: ALICE,
    kind: Kind.ChatMessage,
    content: "hello",
    tags: [["p", BOB]],
    created_at: 1000,
    ...over,
  };
}

describe("conversationId", () => {
  it("is the same whichever participant is asking", () => {
    // Without sorting, Alice's message and Bob's reply land in different threads.
    expect(conversationId([ALICE, BOB])).toBe(conversationId([BOB, ALICE]));
  });

  it("deduplicates", () => {
    expect(conversationId([ALICE, BOB, ALICE])).toBe(
      conversationId([ALICE, BOB]),
    );
  });

  it("treats a group with an extra member as a different conversation", () => {
    // The honest reading: merging them would show a new member messages sent
    // before they joined.
    expect(conversationId([ALICE, BOB])).not.toBe(
      conversationId([ALICE, BOB, CAROL]),
    );
  });
});

describe("chatParticipants", () => {
  it("includes the author, who is not in the p tags", () => {
    // NIP-17 identifies the author by `pubkey`, so a reader that only walks the
    // tags drops the sender out of their own conversation.
    expect(chatParticipants(rumor())).toEqual([ALICE, BOB].sort());
  });

  it("collects a group", () => {
    const message = rumor({
      tags: [
        ["p", BOB],
        ["p", CAROL],
      ],
    });
    expect(chatParticipants(message)).toEqual([ALICE, BOB, CAROL].sort());
  });

  it("ignores tags that are not p tags or have no value", () => {
    const message = rumor({
      tags: [["p", BOB], ["p"], ["e", "1".repeat(64)], ["subject", "hi"]],
    });
    expect(chatParticipants(message)).toEqual([ALICE, BOB].sort());
  });
});

describe("toChatMessage", () => {
  it("reads a plain message", () => {
    const message = toChatMessage(rumor());
    expect(message).toMatchObject({
      sender: ALICE,
      content: "hello",
      createdAt: 1000,
      isFile: false,
    });
    expect(message?.replyTo).toBeUndefined();
  });

  it("reads a reply and a subject", () => {
    const parent = "9".repeat(64);
    const message = toChatMessage(
      rumor({
        tags: [
          ["p", BOB],
          ["e", parent],
          ["subject", "Invoice"],
        ],
      }),
    );
    expect(message?.replyTo).toBe(parent);
    expect(message?.subject).toBe("Invoice");
  });

  it("marks a kind-15 as a file", () => {
    expect(toChatMessage(rumor({ kind: Kind.ChatFile }))?.isFile).toBe(true);
  });

  it("refuses a rumor that is not a chat message", () => {
    // A gift wrap can contain any kind. Rendering an arbitrary rumor as a chat
    // message would let a sender put a note, a reaction or anything else into a
    // conversation.
    expect(toChatMessage(rumor({ kind: Kind.ShortTextNote }))).toBeUndefined();
    expect(toChatMessage(rumor({ kind: Kind.Metadata }))).toBeUndefined();
  });

  it("uses the rumor's own timestamp, not a wrapper's", () => {
    // Wrapper timestamps are jittered by up to two days; sorting by one would
    // scramble the conversation.
    expect(toChatMessage(rumor({ created_at: 12345 }))?.createdAt).toBe(12345);
  });
});

describe("buildChatMessage", () => {
  it("tags recipients but not the author", () => {
    const template = buildChatMessage({
      content: "hi",
      to: [BOB, ALICE],
      author: ALICE,
    });
    expect(template.tags).toEqual([["p", BOB]]);
    expect(template.kind).toBe(Kind.ChatMessage);
  });

  it("deduplicates recipients", () => {
    const template = buildChatMessage({
      content: "hi",
      to: [BOB, BOB, CAROL],
      author: ALICE,
    });
    expect(template.tags).toEqual([
      ["p", BOB],
      ["p", CAROL],
    ]);
  });

  it("adds reply and subject tags only when given", () => {
    const bare = buildChatMessage({ content: "hi", to: [BOB], author: ALICE });
    expect(bare.tags).toEqual([["p", BOB]]);

    const full = buildChatMessage({
      content: "hi",
      to: [BOB],
      author: ALICE,
      replyTo: "7".repeat(64) as Hex32,
      subject: "Re: thing",
    });
    expect(full.tags).toContainEqual(["e", "7".repeat(64)]);
    expect(full.tags).toContainEqual(["subject", "Re: thing"]);
  });

  it("adds no hashtag, mention or media tags", () => {
    // Every tag here survives decryption, so a recipient who leaks the message
    // leaks the metadata too. A private message is not a note.
    const template = buildChatMessage({
      content: "see #bitcoin and nostr:npub1abc https://x.example/a.png",
      to: [BOB],
      author: ALICE,
    });
    expect(template.tags).toEqual([["p", BOB]]);
  });
});

describe("deliveryTargets", () => {
  it("always includes the author", () => {
    // Without a self-addressed copy the sender cannot read their own messages.
    expect(deliveryTargets(ALICE, [BOB])).toContain(ALICE);
  });

  it("deduplicates when the author is already a recipient", () => {
    expect(deliveryTargets(ALICE, [ALICE, BOB])).toEqual([ALICE, BOB]);
  });
});

describe("parseDmRelayList", () => {
  const event = (tags: string[][]): NostrEvent => ({
    id: "1".repeat(64),
    pubkey: ALICE,
    created_at: 1,
    kind: Kind.DirectMessageRelays,
    tags,
    content: "",
    sig: "0".repeat(128),
  });

  it("reads relay tags", () => {
    expect(
      parseDmRelayList(
        event([
          ["relay", "wss://inbox.example.com"],
          ["relay", "wss://other.example.com"],
        ]),
      ),
    ).toEqual(["wss://inbox.example.com", "wss://other.example.com"]);
  });

  it("ignores other tags and deduplicates", () => {
    expect(
      parseDmRelayList(
        event([
          ["relay", "wss://a.example.com"],
          ["r", "wss://b.example.com"],
          ["relay", "wss://a.example.com"],
          ["relay"],
        ]),
      ),
    ).toEqual(["wss://a.example.com"]);
  });

  it("returns nothing for a missing or wrong-kind event", () => {
    // Callers must not fall back to the public relay set: an undeliverable gift
    // wrap addressed to someone, left on a relay of the sender's choosing, is
    // worse than not sending it.
    expect(parseDmRelayList(undefined)).toEqual([]);
    expect(
      parseDmRelayList({
        ...event([["relay", "wss://a.example.com"]]),
        kind: 10002,
      }),
    ).toEqual([]);
  });
});

describe("buildDmRelayList", () => {
  it("emits relay tags and deduplicates", () => {
    expect(
      buildDmRelayList([
        "wss://a.example.com",
        "wss://a.example.com",
        "wss://b.example.com",
      ]),
    ).toMatchObject({
      kind: Kind.DirectMessageRelays,
      content: "",
      tags: [
        ["relay", "wss://a.example.com"],
        ["relay", "wss://b.example.com"],
      ],
    });
  });
});
