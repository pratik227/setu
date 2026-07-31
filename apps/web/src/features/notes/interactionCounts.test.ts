import { Kind, type NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  countInteractions,
  EMPTY_INTERACTIONS,
  INTERACTION_KINDS,
  interactionTargets,
  type NoteInteractions,
} from "./interactionCounts";

const NOTE_A = "a".repeat(64);
const NOTE_B = "b".repeat(64);
const VIEWER = "v".repeat(64);
const OTHER = "o".repeat(64);

let seq = 0;

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  seq += 1;
  return {
    id: seq.toString(16).padStart(64, "0"),
    pubkey: OTHER,
    created_at: 1000 + seq,
    kind: Kind.Reaction,
    tags: [["e", NOTE_A]],
    content: "+",
    sig: "0".repeat(128),
    ...over,
  };
}

const count = (
  events: readonly NostrEvent[],
  over: {
    noteIds?: readonly string[];
    viewerPubkey?: string;
    limit?: number;
    previous?: ReadonlyMap<string, NoteInteractions>;
  } = {},
): ReadonlyMap<string, NoteInteractions> =>
  countInteractions({
    noteIds: over.noteIds ?? [NOTE_A, NOTE_B],
    events,
    ...(over.viewerPubkey ? { viewerPubkey: over.viewerPubkey } : {}),
    limit: over.limit ?? 500,
    previous: over.previous ?? new Map(),
  });

describe("interactionTargets", () => {
  it("reads NIP-22's uppercase root scope as well as lowercase e", () => {
    const comment = event({
      kind: Kind.Comment,
      tags: [
        ["E", NOTE_A],
        ["e", NOTE_B],
      ],
    });
    expect(interactionTargets(comment)).toEqual([NOTE_A, NOTE_B]);
  });

  it("counts a comment carrying both forms of the same id once", () => {
    const comment = event({
      kind: Kind.Comment,
      tags: [
        ["E", NOTE_A],
        ["e", NOTE_A],
      ],
    });
    expect(interactionTargets(comment)).toEqual([NOTE_A]);
    expect(count([comment]).get(NOTE_A)?.replies).toBe(1);
  });

  it("ignores tags with no value", () => {
    expect(interactionTargets(event({ tags: [["e"], ["E", ""]] }))).toEqual([]);
  });
});

describe("countInteractions — kinds", () => {
  it("asks for NIP-22 comments, which are replies", () => {
    // A thread renders kind 1111 and notifications group it; leaving it out of
    // the counts made a note with ten comments show zero replies.
    expect(INTERACTION_KINDS).toContain(Kind.Comment);
  });

  it("counts kind 1111 comments as replies alongside kind 1", () => {
    const counts = count([
      event({ kind: Kind.ShortTextNote, content: "a reply" }),
      event({ kind: Kind.Comment, content: "a comment" }),
      event({
        kind: Kind.Comment,
        content: "a comment scoped by root only",
        tags: [["E", NOTE_A]],
      }),
    ]);
    expect(counts.get(NOTE_A)?.replies).toBe(3);
  });

  it("sums zap receipts and separates reposts from reactions", () => {
    const counts = count([
      event({ kind: Kind.Repost, content: "" }),
      event({ kind: Kind.Reaction, content: "🔥" }),
      event({
        kind: Kind.Zap,
        tags: [
          ["e", NOTE_A],
          ["bolt11", "lnbc210n1p"],
        ],
      }),
    ]);
    expect(counts.get(NOTE_A)).toMatchObject({
      reposts: 1,
      reactions: 1,
      zapSats: 21,
    });
  });

  it("excludes a NIP-25 downvote from the reaction count", () => {
    const counts = count([
      event({ content: "-" }),
      event({ content: " - " }),
      event({ content: "+" }),
    ]);
    expect(counts.get(NOTE_A)?.reactions).toBe(1);
  });

  it("marks the viewer's own reaction and repost without counting them twice", () => {
    const counts = count(
      [
        event({ pubkey: VIEWER }),
        event({ kind: Kind.Repost, pubkey: VIEWER, content: "" }),
      ],
      { viewerPubkey: VIEWER },
    );
    expect(counts.get(NOTE_A)).toMatchObject({
      reactions: 1,
      reposts: 1,
      viewerReacted: true,
      viewerReposted: true,
    });
    // A downvote by the viewer is not a like, so it must not light the heart.
    const downvote = count([event({ pubkey: VIEWER, content: "-" })], {
      viewerPubkey: VIEWER,
    });
    expect(downvote.get(NOTE_A)).toMatchObject({
      reactions: 0,
      viewerReacted: false,
    });
  });

  it("ignores events pointing at notes outside the wanted set", () => {
    const counts = count([event({ tags: [["e", "f".repeat(64)]] })]);
    expect(counts.get(NOTE_A)).toEqual(EMPTY_INTERACTIONS);
  });
});

describe("countInteractions — honesty about the bound", () => {
  it("marks a note that reached the query's limit as approximate", () => {
    const events = [event(), event(), event()];
    expect(count(events, { limit: 4 }).get(NOTE_A)?.approximate).toBe(false);
    expect(count(events, { limit: 3 }).get(NOTE_A)?.approximate).toBe(true);
  });

  it("leaves notes below the bound exact", () => {
    const counts = count([event(), event({ tags: [["e", NOTE_B]] })], {
      limit: 2,
    });
    expect(counts.get(NOTE_B)?.approximate).toBe(false);
  });
});

describe("countInteractions — identity", () => {
  it("returns the same map when nothing changed", () => {
    const events = [event(), event({ kind: Kind.Repost, content: "" })];
    const first = count(events);
    const second = count(events, { previous: first });
    // Reference equality is the assertion: a store tick that changed nothing must
    // not re-render a single row.
    expect(second).toBe(first);
  });

  it("keeps an untouched note's entry when another note gains a reaction", () => {
    const shared = [event(), event({ tags: [["e", NOTE_B]] })];
    const first = count(shared);
    const second = count([...shared, event({ tags: [["e", NOTE_B]] })], {
      previous: first,
    });

    expect(second).not.toBe(first);
    // NOTE_B changed, so it is a new object...
    expect(second.get(NOTE_B)).not.toBe(first.get(NOTE_B));
    expect(second.get(NOTE_B)?.reactions).toBe(2);
    // ...and NOTE_A did not, so the row already rendering it re-renders nothing.
    expect(second.get(NOTE_A)).toBe(first.get(NOTE_A));
  });

  it("produces a new map when the tracked set changes", () => {
    const events = [event()];
    const first = count(events, { noteIds: [NOTE_A] });
    const grown = count(events, { noteIds: [NOTE_A, NOTE_B], previous: first });
    expect(grown).not.toBe(first);
    expect(grown.get(NOTE_A)).toBe(first.get(NOTE_A));
    expect(grown.get(NOTE_B)).toEqual(EMPTY_INTERACTIONS);

    const shrunk = count(events, { noteIds: [NOTE_A], previous: grown });
    expect(shrunk).not.toBe(grown);
    expect([...shrunk.keys()]).toEqual([NOTE_A]);
  });
});
