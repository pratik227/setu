import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  buildThread,
  MAX_INDENT_DEPTH,
  threadNoteIds,
  threadPubkeys,
} from "./threadTree";

const AUTHOR = "a".repeat(64);

/** 64-char hex id from a short label, so tests can name events readably. */
function id(label: string): string {
  return label.padEnd(64, "0").slice(0, 64);
}

interface EventSpec {
  readonly label: string;
  /** Direct parent label; omit for a thread-starting note. */
  readonly reply?: string;
  /** Root label; defaults to `reply` when a reply is given. */
  readonly root?: string;
  readonly createdAt?: number;
  /** Raw tag rows, used to exercise the legacy positional scheme. */
  readonly tags?: readonly (readonly string[])[];
  readonly pubkey?: string;
}

function event(spec: EventSpec): NostrEvent {
  const tags: string[][] = [];
  if (spec.tags) {
    for (const tag of spec.tags) tags.push([...tag]);
  } else {
    const rootLabel = spec.root ?? spec.reply;
    if (rootLabel !== undefined) {
      tags.push(["e", id(rootLabel), "", "root"]);
      if (spec.reply !== undefined && spec.reply !== rootLabel) {
        tags.push(["e", id(spec.reply), "", "reply"]);
      }
    }
  }
  return {
    id: id(spec.label),
    pubkey: spec.pubkey ?? AUTHOR,
    created_at: spec.createdAt ?? 1000,
    kind: 1,
    tags,
    content: `note ${spec.label}`,
    sig: "0".repeat(128),
  };
}

describe("buildThread", () => {
  it("reports the focused id as missing when nothing is held", () => {
    const tree = buildThread({ events: [], focusedId: id("focus") });
    expect(tree.focused).toBeUndefined();
    expect(tree.rootId).toBe(id("focus"));
    expect(tree.ancestors).toEqual([]);
    expect(tree.replies).toEqual([]);
    expect(tree.missingIds).toEqual([id("focus")]);
  });

  it("treats a note with no e tags as its own root", () => {
    const root = event({ label: "root" });
    const tree = buildThread({ events: [root], focusedId: root.id });
    expect(tree.rootId).toBe(root.id);
    expect(tree.ancestors).toEqual([]);
    expect(tree.focused).toBe(root);
    expect(tree.missingIds).toEqual([]);
  });

  it("resolves a linear ancestor chain root-most first", () => {
    const root = event({ label: "root", createdAt: 100 });
    const mid = event({ label: "mid", reply: "root", createdAt: 200 });
    const focus = event({
      label: "focus",
      root: "root",
      reply: "mid",
      createdAt: 300,
    });

    const tree = buildThread({
      events: [focus, root, mid],
      focusedId: focus.id,
    });

    expect(tree.rootId).toBe(root.id);
    expect(tree.ancestors.map((slot) => slot.id)).toEqual([root.id, mid.id]);
    expect(tree.ancestors.every((slot) => slot.type === "note")).toBe(true);
    expect(tree.focused).toBe(focus);
    expect(tree.replies).toEqual([]);
    expect(tree.missingIds).toEqual([]);
  });

  it("resolves a legacy positional chain (no NIP-10 markers)", () => {
    const root = event({ label: "root" });
    const focus = event({
      label: "focus",
      tags: [
        ["e", id("root")],
        ["e", id("mid")],
      ],
    });
    const mid = event({ label: "mid", tags: [["e", id("root")]] });

    const tree = buildThread({
      events: [root, mid, focus],
      focusedId: focus.id,
    });

    expect(tree.rootId).toBe(root.id);
    expect(tree.ancestors.map((slot) => slot.id)).toEqual([root.id, mid.id]);
  });

  it("orders branching replies oldest-first within each level", () => {
    const focus = event({ label: "focus", createdAt: 100 });
    const b = event({ label: "b", reply: "focus", createdAt: 300 });
    const a = event({ label: "a", reply: "focus", createdAt: 200 });
    const aa = event({
      label: "aa",
      root: "focus",
      reply: "a",
      createdAt: 250,
    });

    const tree = buildThread({
      events: [focus, b, a, aa],
      focusedId: focus.id,
    });

    expect(tree.replies.map((r) => r.event.id)).toEqual([a.id, aa.id, b.id]);
    expect(tree.replies.map((r) => r.depth)).toEqual([1, 2, 1]);
    expect(tree.replies.every((r) => r.orphaned)).toBe(false);
  });

  it("shows an explicit gap for a missing middle ancestor, keeping the root", () => {
    const root = event({ label: "root", createdAt: 100 });
    // "mid" is never handed to the builder.
    const focus = event({
      label: "focus",
      root: "root",
      reply: "mid",
      createdAt: 300,
    });

    const tree = buildThread({ events: [root, focus], focusedId: focus.id });

    expect(tree.ancestors).toEqual([
      { type: "note", id: root.id, event: root },
      { type: "missing", id: id("mid") },
    ]);
    expect(tree.missingIds).toEqual([id("mid")]);
  });

  it("reports the root as missing when the whole chain above is absent", () => {
    const focus = event({ label: "focus", root: "root", reply: "mid" });
    const tree = buildThread({ events: [focus], focusedId: focus.id });

    expect(tree.rootId).toBe(id("root"));
    expect(tree.ancestors).toEqual([{ type: "missing", id: id("mid") }]);
    expect(tree.missingIds).toEqual([id("mid"), id("root")]);
  });

  it("keeps an orphan reply whose parent is absent, flagged and un-nested", () => {
    const focus = event({ label: "focus", createdAt: 100 });
    const direct = event({ label: "direct", reply: "focus", createdAt: 200 });
    // Replies to "gone", which never arrives, but tags the thread root.
    const orphan = event({
      label: "orphan",
      root: "focus",
      reply: "gone",
      createdAt: 300,
    });
    const orphanChild = event({
      label: "child",
      root: "focus",
      reply: "orphan",
      createdAt: 400,
    });

    const tree = buildThread({
      events: [focus, direct, orphan, orphanChild],
      focusedId: focus.id,
    });

    expect(tree.replies.map((r) => r.event.id)).toEqual([
      direct.id,
      orphan.id,
      orphanChild.id,
    ]);
    expect(tree.replies.map((r) => r.orphaned)).toEqual([false, true, false]);
    expect(tree.replies.map((r) => r.depth)).toEqual([1, 1, 2]);
    expect(tree.missingIds).toEqual([id("gone")]);
  });

  it("ignores an unrelated note that names neither the root nor a member", () => {
    const focus = event({ label: "focus" });
    const stranger = event({
      label: "stranger",
      root: "otherroot",
      reply: "otherparent",
    });

    const tree = buildThread({
      events: [focus, stranger],
      focusedId: focus.id,
    });

    expect(tree.replies).toEqual([]);
    expect(tree.missingIds).toEqual([]);
  });

  it("terminates on a two-node cycle between an event and its descendant", () => {
    // "up" claims "down" as its parent while "down" claims "up" — following
    // either direction without a guard loops forever.
    const up = event({ label: "up", tags: [["e", id("down"), "", "reply"]] });
    const down = event({ label: "down", tags: [["e", id("up"), "", "reply"]] });

    const tree = buildThread({ events: [up, down], focusedId: up.id });

    expect(tree.ancestors.map((slot) => slot.id)).toEqual([down.id]);
    expect(tree.replies).toEqual([]);
    expect(tree.missingIds).toEqual([]);
  });

  it("terminates on a three-node reply cycle", () => {
    const a = event({ label: "ca", tags: [["e", id("cb"), "", "reply"]] });
    const b = event({ label: "cb", tags: [["e", id("cc"), "", "reply"]] });
    const c = event({ label: "cc", tags: [["e", id("ca"), "", "reply"]] });

    const tree = buildThread({ events: [a, b, c], focusedId: a.id });

    expect(tree.ancestors.map((slot) => slot.id)).toEqual([c.id, b.id]);
    expect(tree.replies).toEqual([]);
  });

  it("ignores an event that tags itself as its own parent", () => {
    const focus = event({
      label: "focus",
      tags: [["e", id("focus"), "", "reply"]],
    });
    const tree = buildThread({ events: [focus], focusedId: focus.id });

    expect(tree.ancestors).toEqual([]);
    expect(tree.replies).toEqual([]);
    expect(tree.focused).toBe(focus);
  });

  it("flattens indentation past the cap while keeping true depth", () => {
    const focus = event({ label: "focus", createdAt: 100 });
    const chain = ["d1", "d2", "d3", "d4", "d5", "d6"];
    const events: NostrEvent[] = [focus];
    chain.forEach((label, index) => {
      events.push(
        event({
          label,
          root: "focus",
          reply: index === 0 ? "focus" : (chain[index - 1] as string),
          createdAt: 200 + index,
        }),
      );
    });

    const tree = buildThread({ events, focusedId: focus.id });

    expect(tree.replies.map((r) => r.rawDepth)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tree.replies.map((r) => r.depth)).toEqual([1, 2, 3, 3, 3, 3]);
    expect(MAX_INDENT_DEPTH).toBe(3);
  });

  it("honours a custom indentation cap", () => {
    const focus = event({ label: "focus" });
    const one = event({ label: "one", reply: "focus", createdAt: 200 });
    const two = event({
      label: "two",
      root: "focus",
      reply: "one",
      createdAt: 300,
    });

    const tree = buildThread({
      events: [focus, one, two],
      focusedId: focus.id,
      maxIndentDepth: 1,
    });

    expect(tree.replies.map((r) => r.depth)).toEqual([1, 1]);
    expect(tree.replies.map((r) => r.rawDepth)).toEqual([1, 2]);
  });

  it("collects the pubkeys and ids the tree needs resolved", () => {
    const other = "b".repeat(64);
    const root = event({ label: "root", createdAt: 100 });
    const focus = event({ label: "focus", reply: "root", createdAt: 200 });
    const reply = event({
      label: "reply",
      root: "root",
      reply: "focus",
      createdAt: 300,
      pubkey: other,
    });

    const tree = buildThread({
      events: [root, focus, reply],
      focusedId: focus.id,
    });

    expect(threadPubkeys(tree).sort()).toEqual([AUTHOR, other].sort());
    expect(threadNoteIds(tree)).toEqual([root.id, focus.id, reply.id]);
  });
});
