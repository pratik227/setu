import { encodeNaddr, encodeNote, encodeNpub } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import type { NoteCandidate } from "./localMatch";
import { buildSearchItems, groupItems } from "./searchItems";
import { parseSearchInput } from "./searchQuery";
import type { SearchPerson } from "./useSearchCorpus";

const PUBKEY = "a".repeat(64);
const EVENT_ID = "b".repeat(64);
const NPUB = encodeNpub(PUBKEY) as string;
const NOTE = encodeNote(EVENT_ID) as string;

function person(over: Partial<SearchPerson> = {}): SearchPerson {
  const pubkey = over.pubkey ?? PUBKEY;
  return {
    pubkey,
    label: over.displayName ?? "alice",
    handle: "alice@example.com",
    displayName: "alice",
    ...over,
  };
}

function note(over: Partial<NoteCandidate> = {}): NoteCandidate {
  return {
    id: over.id ?? EVENT_ID,
    pubkey: over.pubkey ?? PUBKEY,
    createdAt: over.createdAt ?? 1000,
    content: over.content ?? "a note about gardening",
  };
}

function build(
  raw: string,
  over: {
    people?: readonly SearchPerson[];
    notes?: readonly NoteCandidate[];
    byPubkey?: ReadonlyMap<string, SearchPerson>;
  } = {},
) {
  return buildSearchItems({
    intent: parseSearchInput(raw),
    people: over.people ?? [],
    notes: over.notes ?? [],
    byPubkey: over.byPubkey ?? new Map(),
  });
}

describe("buildSearchItems", () => {
  it("produces nothing for an empty box", () => {
    expect(build("")).toEqual([]);
  });

  it("produces nothing for a pasted secret key", () => {
    const nsec =
      "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    expect(build(nsec)).toEqual([]);
  });

  it("resolves a pasted npub to a single profile row", () => {
    const items = build(NPUB);
    expect(items).toHaveLength(1);
    expect(items[0]?.group).toBe("jump");
    expect(items[0]?.action).toEqual({ kind: "profile", pubkey: PUBKEY });
  });

  it("names the person when their profile is already held", () => {
    const items = build(NPUB, { byPubkey: new Map([[PUBKEY, person()]]) });
    expect(items[0]?.kind).toBe("person");
  });

  it("falls back to a truncated key when the profile is not held", () => {
    const [item] = build(NPUB);
    expect(item?.kind).toBe("command");
    if (item?.kind === "command") expect(item.hint).toContain("…");
  });

  it("resolves a pasted note id to a single note row", () => {
    const items = build(NOTE);
    expect(items).toHaveLength(1);
    expect(items[0]?.action).toEqual({ kind: "note", id: EVENT_ID });
  });

  it("offers both readings of a bare hex string", () => {
    const items = build(PUBKEY);
    expect(items.map((i) => i.action.kind)).toEqual(["profile", "note"]);
  });

  it("offers the hashtag feed for a single #word", () => {
    const items = build("#nostr", { people: [person()] });
    expect(items[0]?.action).toEqual({ kind: "hashtag", tag: "nostr" });
    expect(items[0]?.group).toBe("jump");
  });

  it("puts direct addresses ahead of text matches", () => {
    const items = build("#nostr", {
      notes: [note({ content: "about #nostr" })],
    });
    expect(items[0]?.group).toBe("jump");
    expect(items.at(-1)?.group).toBe("notes");
  });

  it("orders people before notes for a text query", () => {
    const items = build("alice", {
      people: [person()],
      notes: [note({ content: "alice was here" })],
    });
    expect(items.map((i) => i.group)).toEqual(["people", "notes"]);
  });

  it("attaches the author to a note row when the profile is held", () => {
    const [item] = build("gardening", {
      notes: [note()],
      byPubkey: new Map([[PUBKEY, person()]]),
    });
    expect(item?.kind === "note" && item.author?.pubkey).toBe(PUBKEY);
  });

  it("still renders a note whose author is unknown to this device", () => {
    const [item] = build("gardening", { notes: [note()] });
    expect(item?.kind === "note" && item.author).toBeUndefined();
  });

  it("gives every row a unique key", () => {
    const items = build("alice", {
      people: [
        person({ pubkey: "1".repeat(64) }),
        person({ pubkey: "2".repeat(64) }),
      ],
      notes: [
        note({ id: "3".repeat(64), content: "alice" }),
        note({ id: "4".repeat(64), content: "alice" }),
      ],
    });
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps a hex profile row and a hex note row distinct", () => {
    const keys = build(PUBKEY).map((i) => i.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("honours the per-group limits", () => {
    const people = Array.from({ length: 20 }, (_, i) =>
      person({ pubkey: `${i}`.padStart(64, "0") }),
    );
    const items = buildSearchItems({
      intent: parseSearchInput("alice"),
      people,
      notes: [],
      byPubkey: new Map(),
      peopleLimit: 3,
    });
    expect(items).toHaveLength(3);
  });

  it("returns nothing for an naddr, which has no route yet", () => {
    // A coordinate for one long-form article. No screen takes one, so a row
    // would be an affordance that does nothing when pressed.
    const naddr = encodeNaddr({
      identifier: "guide",
      pubkey: PUBKEY,
      kind: 30023,
    }) as string;
    expect(parseSearchInput(naddr).kind).toBe("ref");
    expect(build(naddr)).toEqual([]);
  });
});

describe("groupItems", () => {
  it("returns groups in render order and skips empty ones", () => {
    const items = build("alice", {
      people: [person()],
      notes: [note({ content: "alice" })],
    });
    expect(groupItems(items).map((g) => g.group)).toEqual(["people", "notes"]);
  });

  it("preserves the flat order inside each group", () => {
    const items = build("alice", {
      notes: [
        note({ id: "3".repeat(64), createdAt: 2, content: "alice" }),
        note({ id: "4".repeat(64), createdAt: 1, content: "alice" }),
      ],
    });
    const grouped = groupItems(items);
    expect(grouped[0]?.items.map((i) => i.key)).toEqual(
      items.map((i) => i.key),
    );
  });

  it("handles no items at all", () => {
    expect(groupItems([])).toEqual([]);
  });
});
