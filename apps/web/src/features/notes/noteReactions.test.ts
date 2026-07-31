import { Kind, type NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { groupReactions } from "./noteReactions";

const NOTE = "1".repeat(64);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

let nextId = 0;

function reaction(over: Partial<NostrEvent> = {}): NostrEvent {
  nextId += 1;
  return {
    id: String(nextId).padStart(64, "0"),
    pubkey: ALICE,
    created_at: 1000 + nextId,
    kind: Kind.Reaction,
    tags: [["e", NOTE]],
    content: "🔥",
    sig: "0".repeat(128),
    ...over,
  };
}

describe("groupReactions", () => {
  it("groups by emoji and counts distinct accounts", () => {
    const { groups } = groupReactions([
      reaction({ pubkey: ALICE, content: "🔥" }),
      reaction({ pubkey: BOB, content: "🔥" }),
      reaction({ pubkey: CAROL, content: "🎉" }),
    ]);
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["🔥", 2],
      ["🎉", 1],
    ]);
  });

  it("counts one account once, however many times it reacted with the same emoji", () => {
    // Two clients, or a retry, is one person who liked it — counting events shows
    // two and inflates every chip on a note with duplicates.
    const { groups } = groupReactions([
      reaction({ pubkey: ALICE, content: "🔥" }),
      reaction({ pubkey: ALICE, content: "🔥" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(1);
  });

  it("collapses `+` and empty content into one like chip", () => {
    const { groups } = groupReactions([
      reaction({ pubkey: ALICE, content: "+" }),
      reaction({ pubkey: BOB, content: "" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.label).toBe("❤️");
  });

  it("excludes the NIP-25 downvote", () => {
    // `-` is a protocol flag, not an emoji someone picked; showing it as a chip
    // beside deliberate reactions misrepresents what it is.
    const { groups, events } = groupReactions([
      reaction({ content: "-" }),
      reaction({ pubkey: BOB, content: "🔥" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["🔥"]);
    expect(events).toBe(1);
  });

  it("renders a custom emoji reaction as its declared image", () => {
    // The case the aggregate heart count cannot represent at all: the reactor chose
    // an image and a total discards it.
    const { groups } = groupReactions([
      reaction({
        content: ":soapbox:",
        tags: [
          ["e", NOTE],
          ["emoji", "soapbox", "https://x.test/soapbox.png"],
        ],
      }),
    ]);
    expect(groups[0]).toMatchObject({
      key: ":soapbox:",
      imageUrl: "https://x.test/soapbox.png",
    });
  });

  it("groups one shortcode used by two accounts into one chip", () => {
    const { groups } = groupReactions([
      reaction({
        pubkey: ALICE,
        content: ":soapbox:",
        tags: [
          ["e", NOTE],
          ["emoji", "soapbox", "https://x.test/one.png"],
        ],
      }),
      reaction({
        pubkey: BOB,
        content: ":soapbox:",
        tags: [
          ["e", NOTE],
          ["emoji", "soapbox", "https://x.test/two.png"],
        ],
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
  });

  it("picks the same image whatever order the reactions arrive in", () => {
    // Without a deterministic order the rendered emoji depends on relay delivery,
    // so the same note shows a different image across a reload.
    const alice = reaction({
      pubkey: ALICE,
      created_at: 1000,
      content: ":x:",
      tags: [
        ["e", NOTE],
        ["emoji", "x", "https://x.test/one.png"],
      ],
    });
    const bob = reaction({
      pubkey: BOB,
      created_at: 2000,
      content: ":x:",
      tags: [
        ["e", NOTE],
        ["emoji", "x", "https://x.test/two.png"],
      ],
    });
    expect(groupReactions([alice, bob]).groups[0]?.imageUrl).toBe(
      groupReactions([bob, alice]).groups[0]?.imageUrl,
    );
  });

  it("treats a shortcode with no matching tag as plain text", () => {
    const { groups } = groupReactions([reaction({ content: ":unknown:" })]);
    expect(groups[0]).toMatchObject({ key: ":unknown:", label: ":unknown:" });
    expect(groups[0]?.imageUrl).toBeUndefined();
  });

  it("drops a kind-7 carrying a sentence rather than truncating it", () => {
    // A paragraph in a chip destroys the row's layout, and a truncated one
    // misrepresents what was sent.
    const { groups } = groupReactions([
      reaction({ content: "this is a whole opinion, not a reaction" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("marks the viewer's own reaction", () => {
    const { groups } = groupReactions(
      [
        reaction({ pubkey: ALICE, content: "🔥" }),
        reaction({ pubkey: BOB, content: "🎉" }),
      ],
      ALICE,
    );
    const fire = groups.find((g) => g.key === "🔥");
    const party = groups.find((g) => g.key === "🎉");
    expect(fire?.viewerReacted).toBe(true);
    expect(party?.viewerReacted).toBe(false);
  });

  it("breaks a count tie on the key, so chips do not shuffle", () => {
    // A live note re-groups on every arriving reaction and ties are the common
    // case, so arbitrary tie order would reorder the chips under the reader.
    const forward = groupReactions([
      reaction({ pubkey: ALICE, content: "🅰" }),
      reaction({ pubkey: BOB, content: "🅱" }),
    ]);
    const reversed = groupReactions([
      reaction({ pubkey: BOB, content: "🅱" }),
      reaction({ pubkey: ALICE, content: "🅰" }),
    ]);
    expect(forward.groups.map((g) => g.key)).toEqual(
      reversed.groups.map((g) => g.key),
    );
  });

  it("counts distinct reactors across every chip", () => {
    const { reactors } = groupReactions([
      reaction({ pubkey: ALICE, content: "🔥" }),
      reaction({ pubkey: ALICE, content: "🎉" }),
      reaction({ pubkey: BOB, content: "🔥" }),
    ]);
    expect(reactors).toBe(2);
  });
});
