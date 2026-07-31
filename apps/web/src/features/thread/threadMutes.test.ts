import { muteRulesFrom, NO_MUTES } from "@setu/core";
import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { buildThread } from "./threadTree";

/**
 * Mutes in a thread, where the interesting property is *structural*.
 *
 * The rule everywhere else in the app is "drop what is muted". In a thread that rule
 * corrupts the conversation: drop a muted reply and every reply below it loses its
 * parent, so the reader's own answer reparents to the root of a discussion it does not
 * belong to. Muting one account would visibly rewrite a thread the reader is in.
 *
 * So the node stays, flagged, and the row collapses. These tests pin that down —
 * particularly that the reader's *own* reply under a muted one keeps its depth.
 */

const READER = "r".repeat(64);
const NOISY = "n".repeat(64);
const OTHER = "o".repeat(64);

function id(label: string): string {
  return label.padEnd(64, "0").slice(0, 64);
}

function event(spec: {
  label: string;
  reply?: string;
  root?: string;
  pubkey?: string;
  content?: string;
  tags?: readonly (readonly string[])[];
}): NostrEvent {
  const tags: string[][] = spec.tags
    ? spec.tags.map((t) => [...t])
    : (() => {
        const out: string[][] = [];
        const rootLabel = spec.root ?? spec.reply;
        if (rootLabel !== undefined) {
          out.push(["e", id(rootLabel), "", "root"]);
          if (spec.reply !== undefined && spec.reply !== rootLabel) {
            out.push(["e", id(spec.reply), "", "reply"]);
          }
        }
        return out;
      })();
  return {
    id: id(spec.label),
    pubkey: spec.pubkey ?? OTHER,
    created_at: 1000,
    kind: 1,
    tags,
    content: spec.content ?? `note ${spec.label}`,
    sig: "0".repeat(128),
  };
}

/**
 * focus
 *  ├─ a      (OTHER)
 *  ├─ noisy  (NOISY)  ← muted
 *  │   └─ mine (READER)
 *  └─ b      (OTHER)
 */
function thread(): readonly NostrEvent[] {
  return [
    event({ label: "focus" }),
    event({ label: "a", reply: "focus" }),
    event({ label: "noisy", reply: "focus", pubkey: NOISY }),
    event({ label: "mine", reply: "noisy", root: "focus", pubkey: READER }),
    event({ label: "b", reply: "focus" }),
  ];
}

const mutedNoisy = muteRulesFrom([["p", NOISY]]);

describe("buildThread with mutes", () => {
  it("keeps a muted reply in the tree and flags it", () => {
    const tree = buildThread({
      events: thread(),
      focusedId: id("focus"),
      muteRules: mutedNoisy,
    });
    const noisy = tree.replies.find((r) => r.event.id === id("noisy"));

    expect(noisy).toBeDefined();
    expect(noisy?.mutedReason).toBe("author");
  });

  it("does not orphan the reply below a muted one", () => {
    // The regression that matters. Removing the muted node would leave `mine` with a
    // parent nobody holds, so it would be re-attached at depth 1 and marked orphaned
    // — the reader's own reply, visibly moved out of the exchange it answered.
    const tree = buildThread({
      events: thread(),
      focusedId: id("focus"),
      muteRules: mutedNoisy,
    });
    const mine = tree.replies.find((r) => r.event.id === id("mine"));

    expect(mine).toBeDefined();
    expect(mine?.orphaned).toBe(false);
    expect(mine?.rawDepth).toBe(2);
    expect(mine?.mutedReason).toBeUndefined();
  });

  it("produces the same shape muted and unmuted", () => {
    // Same nodes, same depths, same order. Only the flags differ.
    const shape = (rules: Parameters<typeof buildThread>[0]["muteRules"]) =>
      buildThread({
        events: thread(),
        focusedId: id("focus"),
        ...(rules ? { muteRules: rules } : {}),
      }).replies.map((r) => `${r.event.id}@${r.rawDepth}:${r.orphaned}`);

    expect(shape(mutedNoisy)).toEqual(shape(NO_MUTES));
  });

  it("counts muted replies so the header can disclose them", () => {
    const tree = buildThread({
      events: thread(),
      focusedId: id("focus"),
      muteRules: mutedNoisy,
    });

    expect(tree.replies).toHaveLength(4);
    expect(tree.mutedReplies).toBe(1);
    // What the panel shows: 3 readable, 1 muted, and the two numbers add up.
    expect(tree.replies.length - tree.mutedReplies).toBe(3);
  });

  it("reports zero muted with no rules", () => {
    const tree = buildThread({ events: thread(), focusedId: id("focus") });
    expect(tree.mutedReplies).toBe(0);
    for (const reply of tree.replies) {
      expect(reply.mutedReason).toBeUndefined();
    }
  });

  it("never mutes the reader's own reply", () => {
    // A word rule is about what the reader wants to read from others. Unchecked it
    // swallows their own reply the instant they post it, which in a thread reads as
    // the reply having failed to send.
    const tree = buildThread({
      events: [
        event({ label: "focus" }),
        event({
          label: "mine",
          reply: "focus",
          pubkey: READER,
          content: "spoilers ahead",
        }),
      ],
      focusedId: id("focus"),
      muteRules: muteRulesFrom([["word", "spoilers"]]),
      viewerPubkey: READER,
    });

    expect(tree.replies[0]?.mutedReason).toBeUndefined();
    expect(tree.mutedReplies).toBe(0);
  });

  it("never flags the focused note, even for a muted thread", () => {
    // A thread rule matches every event tagging the root — including the note the
    // reader just chose to open. Collapsing what they explicitly asked for is a
    // client overruling them.
    const events = thread();
    const tree = buildThread({
      events,
      focusedId: id("a"),
      muteRules: muteRulesFrom([["e", id("focus")]]),
    });

    expect(tree.focused?.id).toBe(id("a"));
    // The ancestor above it *is* flagged: that one was not asked for.
    const parent = tree.ancestors.find((slot) => slot.type === "note");
    expect(parent?.type === "note" && parent.mutedReason).toBe("thread");
  });

  it("flags a muted ancestor without breaking the chain", () => {
    const tree = buildThread({
      events: thread(),
      focusedId: id("mine"),
      muteRules: mutedNoisy,
    });
    const notes = tree.ancestors.filter((slot) => slot.type === "note");

    // focus, then noisy — the chain is intact, and only noisy is flagged.
    expect(notes.map((slot) => slot.id)).toEqual([id("focus"), id("noisy")]);
    expect(notes[0]?.type === "note" && notes[0].mutedReason).toBeUndefined();
    expect(notes[1]?.type === "note" && notes[1].mutedReason).toBe("author");
  });

  it("flags a hashtag mute by its own reason", () => {
    const tree = buildThread({
      events: [
        event({ label: "focus" }),
        event({
          label: "tagged",
          tags: [
            ["e", id("focus"), "", "root"],
            ["t", "Politics"],
          ],
        }),
      ],
      focusedId: id("focus"),
      muteRules: muteRulesFrom([["t", "politics"]]),
    });

    expect(tree.replies[0]?.mutedReason).toBe("hashtag");
  });
});
