import type { FeedEntry } from "@setu/core";
import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import type { NoteInteractions } from "../notes/interactionCounts";
import type { AuthorView } from "../notes/types";
import { noteEventsIn, noteIdsIn, pubkeysIn, toNoteViews } from "./toNoteViews";

const AUTHOR_A = "a".repeat(64);
const AUTHOR_B = "b".repeat(64);
const REPOSTER = "c".repeat(64);

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: AUTHOR_A,
    created_at: 1000,
    kind: 1,
    tags: [],
    content: "hello",
    sig: "0".repeat(128),
    ...over,
  };
}

function noteEntry(over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    key: "note:1",
    kind: "note",
    event: event(),
    createdAt: 1000,
    reposters: [],
    repostIds: [],
    ...over,
  };
}

const authorView = (pubkey: string, displayName: string): AuthorView => ({
  pubkey,
  resolved: true,
  displayName,
  handle: `${displayName.toLowerCase()}@example.com`,
});

const counts = (over: Partial<NoteInteractions> = {}): NoteInteractions => ({
  replies: 0,
  reposts: 0,
  reactions: 0,
  zapSats: 0,
  viewerReacted: false,
  viewerReposted: false,
  approximate: false,
  ...over,
});

describe("toNoteViews", () => {
  it("uses resolved author metadata when available", () => {
    const [view] = toNoteViews(
      [noteEntry()],
      new Map([[AUTHOR_A, authorView(AUTHOR_A, "Aditi")]]),
      new Map(),
      0,
    );
    expect(view?.author.displayName).toBe("Aditi");
    expect(view?.author.handle).toBe("aditi@example.com");
  });

  it("falls back to a truncated npub for an unresolved author", () => {
    const [view] = toNoteViews([noteEntry()], new Map(), new Map(), 0);
    // The row must still render — an unresolved profile is the normal case for
    // the first frame, not an error state.
    expect(view?.author.displayName.startsWith("npub1")).toBe(true);
  });

  it("renders the target note for a repost row, not the kind-6 wrapper", () => {
    const target = event({
      id: "2".repeat(64),
      pubkey: AUTHOR_B,
      content: "the original",
    });
    const entry = noteEntry({
      key: "repost:2",
      kind: "repost",
      // A kind-6 carries no content of its own; rendering it would show a blank.
      event: event({
        id: "9".repeat(64),
        kind: 6,
        content: "",
        pubkey: REPOSTER,
      }),
      target,
      targetId: target.id,
      reposters: [REPOSTER],
      repostIds: ["9".repeat(64)],
    });

    const [view] = toNoteViews(
      [entry],
      new Map([
        [AUTHOR_B, authorView(AUTHOR_B, "Rahul")],
        [REPOSTER, authorView(REPOSTER, "Priya")],
      ]),
      new Map(),
      0,
    );

    expect(view?.content).toBe("the original");
    expect(view?.author.displayName).toBe("Rahul");
    expect(view?.repostedBy?.[0]?.displayName).toBe("Priya");
  });

  it("takes counts from the interaction map, keyed by the displayed note", () => {
    const [view] = toNoteViews(
      [noteEntry()],
      new Map(),
      new Map([["1".repeat(64), counts({ replies: 3, zapSats: 2100 })]]),
      0,
    );
    expect(view?.replyCount).toBe(3);
    expect(view?.zapSats).toBe(2100);
  });

  it("never reports fewer reposts than the row itself carries", () => {
    // Counts lag the feed: the repost that produced this row may not have been
    // counted yet, and showing 0 next to a visible "X reposted" line is worse
    // than showing the floor we already know.
    const entry = noteEntry({ reposters: [REPOSTER, AUTHOR_B] });
    const [view] = toNoteViews([entry], new Map(), new Map(), 0);
    expect(view?.repostCount).toBe(2);
  });

  it("surfaces a content warning, with generic copy when the tag is empty", () => {
    const withReason = toNoteViews(
      [noteEntry({ event: event({ tags: [["content-warning", "nsfw"]] }) })],
      new Map(),
      new Map(),
      0,
    );
    expect(withReason[0]?.contentWarning).toBe("nsfw");

    const withoutReason = toNoteViews(
      [noteEntry({ event: event({ tags: [["content-warning"]] }) })],
      new Map(),
      new Map(),
      0,
    );
    expect(withoutReason[0]?.contentWarning).toBeTruthy();
  });

  it("marks only rows newer than the mount time as just-arrived", () => {
    const older = noteEntry({ event: event({ created_at: 500 }) });
    const newer = noteEntry({
      key: "note:new",
      event: event({ id: "3".repeat(64), created_at: 1500 }),
    });
    const views = toNoteViews([older, newer], new Map(), new Map(), 1000);
    expect(views[0]?.justArrived).toBeUndefined();
    expect(views[1]?.justArrived).toBe(true);
  });

  it("leaves media unset for a note that shows none", () => {
    const [view] = toNoteViews([noteEntry()], new Map(), new Map(), 0);
    expect(view?.media).toBeUndefined();
  });

  it("carries the author's declared imeta dimensions onto the media view", () => {
    // Without the size on the view model the row reserves no space, so every row
    // below the image moves the moment it decodes.
    const entry = noteEntry({
      event: event({
        content: "look https://x.test/a.png",
        tags: [["imeta", "url https://x.test/a.png", "dim 1200x800"]],
      }),
    });
    const [view] = toNoteViews([entry], new Map(), new Map(), 0);
    expect(view?.media).toEqual([
      { url: "https://x.test/a.png", kind: "image", width: 1200, height: 800 },
    ]);
  });

  it("still shows a body image the author declared no imeta for", () => {
    const entry = noteEntry({
      event: event({ content: "look https://x.test/a.png" }),
    });
    const [view] = toNoteViews([entry], new Map(), new Map(), 0);
    expect(view?.media?.[0]?.url).toBe("https://x.test/a.png");
    expect(view?.media?.[0]?.width).toBeUndefined();
  });

  it("shows the reposted note's media, not the wrapper's", () => {
    const target = event({
      id: "2".repeat(64),
      pubkey: AUTHOR_B,
      content: "the original https://x.test/a.png",
      tags: [["imeta", "url https://x.test/a.png", "dim 100x50"]],
    });
    const [view] = toNoteViews(
      [
        noteEntry({
          key: "repost:2",
          kind: "repost",
          event: event({ id: "9".repeat(64), kind: 6, content: "" }),
          target,
          targetId: target.id,
          reposters: [REPOSTER],
          repostIds: ["9".repeat(64)],
        }),
      ],
      new Map(),
      new Map(),
      0,
    );
    expect(view?.media).toEqual([
      { url: "https://x.test/a.png", kind: "image", width: 100, height: 50 },
    ]);
  });

  it("resolves NIP-10 reply position", () => {
    const reply = noteEntry({
      event: event({
        tags: [
          ["e", "r".repeat(64), "", "root"],
          ["e", "p".repeat(64), "", "reply"],
        ],
      }),
    });
    const [view] = toNoteViews([reply], new Map(), new Map(), 0);
    expect(view?.replyingTo?.id).toBe("p".repeat(64));
  });
});

it("gives a reposted note and its standalone row distinct rowKeys", () => {
  // The bug this locks: a note can be in the feed on its own *and* as the
  // target of someone's repost. Both rows display the same note, so both carry
  // the same `id` — and React was keyed on `id`, so it saw two siblings
  // claiming one key and dropped or duplicated one of them. `rowKey` comes
  // from the entry, which the feed engine already made distinct.
  const target = event({ id: "9".repeat(64) });
  const standalone = noteEntry({ key: "note:9", event: target });
  const reposted = noteEntry({
    key: "repost:9:anchor",
    kind: "repost",
    event: event({ id: "8".repeat(64), kind: 6, pubkey: REPOSTER }),
    target,
    targetId: target.id,
    reposters: [REPOSTER],
    repostIds: ["8".repeat(64)],
  });

  const views = toNoteViews([standalone, reposted], new Map(), new Map(), 0);

  expect(views).toHaveLength(2);
  // Same note on display in both rows...
  expect(views[0]!.id).toBe(target.id);
  expect(views[1]!.id).toBe(target.id);
  // ...but two distinct row identities.
  expect(views[0]!.rowKey).not.toBe(views[1]!.rowKey);
  expect(new Set(views.map((view) => view.rowKey)).size).toBe(views.length);
});

it("carries the entry key through as rowKey", () => {
  const [view] = toNoteViews(
    [noteEntry({ key: "note:distinctive" })],
    new Map(),
    new Map(),
    0,
  );
  expect(view?.rowKey).toBe("note:distinctive");
});

describe("toNoteViews identity", () => {
  it("reuses the previous object when nothing about a row changed", () => {
    // Without this, `React.memo` on the row compares freshly built objects every
    // tick and skips nothing — and the store re-emits its whole matching set on
    // every change, so that is every reaction and every resolved name.
    const entries = [noteEntry()];
    const first = toNoteViews(entries, new Map(), new Map(), 0);
    const second = toNoteViews(entries, new Map(), new Map(), 0, first);
    expect(second[0]).toBe(first[0]);
  });

  it("produces a new object when a count changes", () => {
    const entries = [noteEntry()];
    const first = toNoteViews(entries, new Map(), new Map(), 0);
    const counts = new Map([
      [
        entries[0]!.event.id,
        {
          replies: 3,
          reposts: 0,
          reactions: 0,
          zapSats: 0,
          viewerReacted: false,
          viewerReposted: false,
          approximate: false,
        } as NoteInteractions,
      ],
    ]);
    const second = toNoteViews(entries, new Map(), counts, 0, first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.replyCount).toBe(3);
  });

  it("produces a new object when the author resolves", () => {
    const entries = [noteEntry()];
    const first = toNoteViews(entries, new Map(), new Map(), 0);
    const authors = new Map([[AUTHOR_A, authorView(AUTHOR_A, "Ada")]]);
    const second = toNoteViews(entries, authors, new Map(), 0, first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.author.displayName).toBe("Ada");
  });

  it("keeps identity for a repost row whose reposter list is rebuilt fresh", () => {
    // `repostedBy` is built by mapping pubkeys through `fallbackAuthor`, which
    // returns a new object every call — so the reposter list is a fresh array of
    // fresh objects on every tick even when nobody new reposted. Comparing it by
    // reference would make exactly the reposted rows un-memoisable.
    const target = event({ id: "7".repeat(64) });
    const entry = noteEntry({
      key: "repost:7",
      kind: "repost",
      event: event({ id: "6".repeat(64), kind: 6, pubkey: REPOSTER }),
      target,
      targetId: target.id,
      reposters: [REPOSTER],
      repostIds: ["6".repeat(64)],
    });
    const first = toNoteViews([entry], new Map(), new Map(), 0);
    const second = toNoteViews([entry], new Map(), new Map(), 0, first);
    expect(second[0]).toBe(first[0]);
  });

  it("produces a new object when another account reposts the same note", () => {
    const target = event({ id: "7".repeat(64) });
    const base = {
      key: "repost:7",
      kind: "repost" as const,
      event: event({ id: "6".repeat(64), kind: 6, pubkey: REPOSTER }),
      target,
      targetId: target.id,
    };
    const first = toNoteViews(
      [noteEntry({ ...base, reposters: [REPOSTER] })],
      new Map(),
      new Map(),
      0,
    );
    const second = toNoteViews(
      [noteEntry({ ...base, reposters: [REPOSTER, AUTHOR_B] })],
      new Map(),
      new Map(),
      0,
      first,
    );
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.repostedBy).toHaveLength(2);
  });

  it("keeps identity for a row with media, whose media list is derived", () => {
    // The trap this locks. `media` is computed from the event, so the obvious
    // implementation builds a fresh array on every call — and `sameView` compares
    // `media` by reference, so every row with an image would look changed on every
    // store tick and `React.memo` would skip nothing for exactly the rows that
    // cost the most to render.
    const entries = [
      noteEntry({
        event: event({
          content: "look https://x.test/a.png",
          tags: [["imeta", "url https://x.test/a.png", "dim 1200x800"]],
        }),
      }),
    ];
    const first = toNoteViews(entries, new Map(), new Map(), 0);
    const second = toNoteViews(entries, new Map(), new Map(), 0, first);
    expect(second[0]).toBe(first[0]);
    expect(second[0]?.media).toBe(first[0]?.media);
  });

  it("keeps the media array across a tick that changed a count", () => {
    // The row object is rebuilt, but re-deriving the media is wasted work: the
    // event is immutable, so the same note always shows the same media.
    const entries = [
      noteEntry({ event: event({ content: "look https://x.test/a.png" }) }),
    ];
    const first = toNoteViews(entries, new Map(), new Map(), 0);
    const second = toNoteViews(
      entries,
      new Map(),
      new Map([[entries[0]!.event.id, counts({ replies: 1 })]]),
      0,
      first,
    );
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.media).toBe(first[0]?.media);
  });

  it("re-derives media when the row starts showing a different note", () => {
    // A repost row's target can arrive after the wrapper, so one rowKey does
    // legitimately change which note it displays.
    const wrapper = event({ id: "6".repeat(64), kind: 6, content: "" });
    const base = {
      key: "repost:7",
      kind: "repost" as const,
      event: wrapper,
      targetId: "7".repeat(64),
    };
    const first = toNoteViews([noteEntry(base)], new Map(), new Map(), 0);
    expect(first[0]?.media).toBeUndefined();

    const target = event({
      id: "7".repeat(64),
      content: "the original https://x.test/a.png",
    });
    const second = toNoteViews(
      [noteEntry({ ...base, target })],
      new Map(),
      new Map(),
      0,
      first,
    );
    expect(second[0]?.media?.[0]?.url).toBe("https://x.test/a.png");
  });

  it("keeps identity for untouched rows while one row changes", () => {
    // The whole point: one arriving reaction re-renders one row, not the page.
    const a = noteEntry({
      key: "note:a",
      event: event({ id: "a".repeat(64) }),
    });
    const b = noteEntry({
      key: "note:b",
      event: event({ id: "b".repeat(64) }),
    });
    const first = toNoteViews([a, b], new Map(), new Map(), 0);
    const counts = new Map([
      [
        "a".repeat(64),
        {
          replies: 1,
          reposts: 0,
          reactions: 0,
          zapSats: 0,
          viewerReacted: false,
          viewerReposted: false,
          approximate: false,
        } as NoteInteractions,
      ],
    ]);
    const second = toNoteViews([a, b], new Map(), counts, 0, first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });
});

describe("pubkeysIn / noteIdsIn", () => {
  it("collects authors and reposters, deduplicated", () => {
    const target = event({ id: "2".repeat(64), pubkey: AUTHOR_B });
    const entries = [
      noteEntry(),
      noteEntry({
        key: "repost:2",
        kind: "repost",
        event: event({ id: "9".repeat(64), kind: 6, pubkey: REPOSTER }),
        target,
        reposters: [REPOSTER, AUTHOR_A],
      }),
    ];
    expect(pubkeysIn(entries).sort()).toEqual(
      [AUTHOR_A, AUTHOR_B, REPOSTER].sort(),
    );
  });

  it("collects the displayed note id, not the repost wrapper id", () => {
    const target = event({ id: "2".repeat(64), pubkey: AUTHOR_B });
    const entries = [
      noteEntry({
        key: "repost:2",
        kind: "repost",
        event: event({ id: "9".repeat(64), kind: 6 }),
        target,
        reposters: [REPOSTER],
      }),
    ];
    // Counting reactions against the wrapper would always yield zero.
    expect(noteIdsIn(entries)).toEqual([target.id]);
  });
});

describe("noteEventsIn", () => {
  it("maps each row's id to the event a write must be built from", () => {
    const events = noteEventsIn([noteEntry()]);
    expect(events.get("1".repeat(64))?.content).toBe("hello");
  });

  it("maps a repost row to the target note, not the kind-6 wrapper", () => {
    // Reacting to a repost row must react to the note being reposted. Keying the
    // map by the wrapper's id would also break the row lookup, because the view
    // model renders under the target's id.
    const target = event({
      id: "2".repeat(64),
      pubkey: AUTHOR_B,
      content: "the original",
    });
    const events = noteEventsIn([
      noteEntry({
        key: "repost:2",
        kind: "repost",
        event: event({ id: "9".repeat(64), kind: 6, pubkey: REPOSTER }),
        target,
        targetId: target.id,
        reposters: [REPOSTER],
      }),
    ]);
    expect([...events.keys()]).toEqual([target.id]);
    expect(events.get(target.id)?.kind).toBe(1);
  });

  it("falls back to the repost event when the target is not held", () => {
    // Same fallback `toNoteViews` uses, so ids never disagree between the two.
    const wrapper = event({ id: "9".repeat(64), kind: 6, pubkey: REPOSTER });
    const events = noteEventsIn([
      noteEntry({ key: "repost:9", kind: "repost", event: wrapper }),
    ]);
    expect(events.get(wrapper.id)).toBe(wrapper);
  });
});
