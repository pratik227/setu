import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  buildDeletion,
  buildNote,
  buildReaction,
  buildRepost,
} from "./buildNote";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);
const ROOT_ID = "1".repeat(64);
const MID_ID = "2".repeat(64);

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: ROOT_ID,
    pubkey: ALICE,
    created_at: 1000,
    kind: 1,
    tags: [],
    content: "parent",
    sig: "0".repeat(128),
    ...over,
  };
}

const tagsNamed = (t: readonly (readonly string[])[], name: string) =>
  t.filter((tag) => tag[0] === name);

describe("buildNote", () => {
  it("extracts hashtags as lowercased, deduped t tags", () => {
    const template = buildNote({
      content: "love #Nostr and #nostr and #Bitcoin",
    });
    const t = tagsNamed(template.tags ?? [], "t").map((tag) => tag[1]);
    expect(t).toEqual(["nostr", "bitcoin"]);
  });

  it("does not create a t tag for a hashtag inside a URL", () => {
    // The tokenizer owns this rule; asserting it here stops a future
    // regex-based shortcut from reintroducing the bug.
    const template = buildNote({
      content: "see https://example.com/page#section for details",
    });
    expect(tagsNamed(template.tags ?? [], "t")).toEqual([]);
  });

  it("turns nostr: mentions into p tags so the mention actually notifies", () => {
    const npub =
      "nostr:npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9";
    const template = buildNote({ content: `hello ${npub}` });
    expect(tagsNamed(template.tags ?? [], "p")).toHaveLength(1);
  });

  it("marks the parent as root when replying to a top-level note", () => {
    const template = buildNote({
      content: "agreed",
      reply: { parent: event() },
    });
    expect(tagsNamed(template.tags ?? [], "e")).toEqual([
      ["e", ROOT_ID, "", "root"],
    ]);
  });

  it("keeps the parent's root when replying to a reply", () => {
    // Emitting the parent as root here is the bug that flattens every
    // sub-thread into the top level.
    const parent = event({
      id: MID_ID,
      pubkey: BOB,
      tags: [["e", ROOT_ID, "", "root"]],
    });
    const template = buildNote({ content: "me too", reply: { parent } });
    expect(tagsNamed(template.tags ?? [], "e")).toEqual([
      ["e", ROOT_ID, "", "root"],
      ["e", MID_ID, "", "reply"],
    ]);
  });

  it("carries a relay hint into both e tags", () => {
    const parent = event({ id: MID_ID, tags: [["e", ROOT_ID, "", "root"]] });
    const template = buildNote({
      content: "x",
      reply: { parent, relayHint: "wss://relay.example.com" },
    });
    for (const tag of tagsNamed(template.tags ?? [], "e")) {
      expect(tag[2]).toBe("wss://relay.example.com");
    }
  });

  it("notifies the parent author and everyone the parent notified", () => {
    const parent = event({ pubkey: BOB, tags: [["p", CAROL]] });
    const template = buildNote({ content: "hi", reply: { parent } });
    const p = tagsNamed(template.tags ?? [], "p").map((tag) => tag[1]);
    expect(p).toContain(BOB);
    expect(p).toContain(CAROL);
  });

  it("deduplicates p tags across every source", () => {
    const parent = event({
      pubkey: BOB,
      tags: [
        ["p", BOB],
        ["p", CAROL],
      ],
    });
    const template = buildNote({
      content: "hi",
      reply: { parent },
      notify: [CAROL, BOB],
    });
    const p = tagsNamed(template.tags ?? [], "p").map((tag) => tag[1]);
    expect(new Set(p).size).toBe(p.length);
  });

  it("emits a valueless content-warning tag for an empty reason", () => {
    // Presence of the tag is what means "warn"; an empty reason is still a warning.
    const withEmpty = buildNote({ content: "x", contentWarning: "" });
    expect(tagsNamed(withEmpty.tags ?? [], "content-warning")).toEqual([
      ["content-warning"],
    ]);
    const withReason = buildNote({ content: "x", contentWarning: "nsfw" });
    expect(tagsNamed(withReason.tags ?? [], "content-warning")).toEqual([
      ["content-warning", "nsfw"],
    ]);
    const without = buildNote({ content: "x" });
    expect(tagsNamed(without.tags ?? [], "content-warning")).toEqual([]);
  });

  it("trims the content and uses kind 1", () => {
    const template = buildNote({ content: "  hello  " });
    expect(template.content).toBe("hello");
    expect(template.kind).toBe(1);
  });

  it("orders tags e, then p, then t", () => {
    const parent = event({ pubkey: BOB });
    const template = buildNote({ content: "hi #nostr", reply: { parent } });
    const order = (template.tags ?? []).map((tag) => tag[0]);
    expect(order).toEqual(["e", "p", "t"]);
  });
});

describe("buildReaction", () => {
  it("tags the target event, its author, and its kind", () => {
    const template = buildReaction(event({ pubkey: BOB }));
    expect(template.kind).toBe(7);
    expect(template.content).toBe("+");
    expect(template.tags).toEqual([
      ["e", ROOT_ID],
      ["p", BOB],
      ["k", "1"],
    ]);
  });

  it("carries a custom emoji as the content", () => {
    expect(buildReaction(event(), "🤙").content).toBe("🤙");
  });
});

describe("buildRepost", () => {
  it("uses kind 6 and embeds the note so clients need no second fetch", () => {
    const target = event({ pubkey: BOB });
    const template = buildRepost(target);
    expect(template.kind).toBe(6);
    expect(JSON.parse(template.content)).toEqual(target);
    expect(template.tags).toEqual([
      ["e", ROOT_ID, ""],
      ["p", BOB],
    ]);
  });

  it("uses kind 16 with a k tag for anything that is not a note", () => {
    const template = buildRepost(event({ kind: 30023, pubkey: BOB }));
    expect(template.kind).toBe(16);
    expect(template.tags).toContainEqual(["k", "30023"]);
  });
});

describe("buildDeletion", () => {
  it("tags every target and each distinct kind", () => {
    const template = buildDeletion([
      event({ id: ROOT_ID, kind: 7 }),
      event({ id: MID_ID, kind: 7 }),
    ]);
    expect(template.kind).toBe(5);
    expect(template.tags).toEqual([
      ["e", ROOT_ID],
      ["e", MID_ID],
      ["k", "7"],
    ]);
  });

  it("emits one k tag per kind, not one per event", () => {
    // A relay applies the request from the k tags when it no longer holds the
    // target, so they must be present and must not be duplicated per event.
    const template = buildDeletion([
      event({ id: ROOT_ID, kind: 7 }),
      event({ id: MID_ID, kind: 6 }),
    ]);
    expect(template.tags).toContainEqual(["k", "7"]);
    expect(template.tags).toContainEqual(["k", "6"]);
    expect((template.tags ?? []).filter((t) => t[0] === "k")).toHaveLength(2);
  });

  it("carries an optional reason and defaults to none", () => {
    expect(buildDeletion([event()]).content).toBe("");
    expect(buildDeletion([event()], "mistake").content).toBe("mistake");
  });

  it("produces an empty request for an empty target list", () => {
    // The caller must treat this as "nothing to delete" rather than publish it;
    // a kind-5 with no e tags asks a relay to delete nothing.
    expect(buildDeletion([]).tags).toEqual([]);
  });
});
