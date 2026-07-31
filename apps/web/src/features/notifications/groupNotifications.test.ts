import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  filterByKind,
  groupNotifications,
  type NotificationItem,
  previewText,
  referencedEventIds,
} from "./groupNotifications";

const ME = "0".repeat(64);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);
const DAVE = "d".repeat(64);
const ERIN = "e".repeat(64);

const MY_NOTE = "1".repeat(64);
const OTHER_NOTE = "2".repeat(64);
const UNKNOWN_NOTE = "9".repeat(64);

let serial = 0;

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  serial += 1;
  return {
    id: serial.toString(16).padStart(64, "f"),
    pubkey: ALICE,
    created_at: 1000,
    kind: 1,
    tags: [["p", ME]],
    content: "",
    sig: "0".repeat(128),
    ...over,
  };
}

/** A reaction by `pubkey` to `targetId`. */
function reaction(
  pubkey: string,
  targetId: string,
  over: Partial<NostrEvent> = {},
): NostrEvent {
  return event({
    kind: 7,
    pubkey,
    content: "+",
    tags: [
      ["p", ME],
      ["e", targetId],
    ],
    ...over,
  });
}

function myNote(over: Partial<NostrEvent> = {}): NostrEvent {
  return event({
    id: MY_NOTE,
    pubkey: ME,
    content: "the note I wrote, which is mine",
    tags: [],
    ...over,
  });
}

/** `known` holding the viewer's own note, so replies can be recognised. */
function knownWithMyNote(): Map<string, NostrEvent> {
  const note = myNote();
  return new Map([[note.id, note]]);
}

function group(
  events: readonly NostrEvent[],
  known: ReadonlyMap<string, NostrEvent> = new Map(),
): readonly NotificationItem[] {
  return groupNotifications({ viewerPubkey: ME, events, known });
}

describe("groupNotifications — empty and degenerate input", () => {
  it("returns nothing for no events", () => {
    expect(group([])).toEqual([]);
  });

  it("ignores events that do not actually tag the viewer", () => {
    // The caller's filter says `#p = me`, but a relay is not trusted to honour
    // it, and a mis-addressed row would show one user another user's mail.
    const stray = event({ kind: 7, content: "+", tags: [["p", BOB]] });
    expect(group([stray])).toEqual([]);
  });

  it("ignores kinds that are not notifications", () => {
    expect(group([event({ kind: 4 }), event({ kind: 30023 })])).toEqual([]);
  });
});

describe("groupNotifications — collapse by target", () => {
  it("makes five likes on one note a single row with five actors", () => {
    const events = [ALICE, BOB, CAROL, DAVE, ERIN].map((pubkey, index) =>
      reaction(pubkey, MY_NOTE, { created_at: 1000 + index }),
    );

    const [row, ...rest] = group(events, knownWithMyNote());

    expect(rest).toEqual([]);
    expect(row?.kind).toBe("reaction");
    expect(row?.actors).toHaveLength(5);
    expect(row?.targetId).toBe(MY_NOTE);
    expect(row?.targetIsMine).toBe(true);
  });

  it("sorts actors newest first and dates the row from the newest action", () => {
    const events = [
      reaction(ALICE, MY_NOTE, { created_at: 1000 }),
      reaction(BOB, MY_NOTE, { created_at: 3000 }),
      reaction(CAROL, MY_NOTE, { created_at: 2000 }),
    ];

    const [row] = group(events, knownWithMyNote());

    expect(row?.actors.map((a) => a.pubkey)).toEqual([BOB, CAROL, ALICE]);
    expect(row?.createdAt).toBe(3000);
  });

  it("keeps reactions on different notes in different rows", () => {
    const known = knownWithMyNote();
    const second = myNote({ id: OTHER_NOTE, content: "my second note" });
    known.set(second.id, second);

    const rows = group(
      [reaction(ALICE, MY_NOTE), reaction(BOB, OTHER_NOTE)],
      known,
    );

    expect(rows).toHaveLength(2);
  });

  it("counts one person once, however many times they reacted", () => {
    const rows = group(
      [
        reaction(ALICE, MY_NOTE, { created_at: 1000 }),
        reaction(ALICE, MY_NOTE, { created_at: 2000, content: "🔥" }),
      ],
      knownWithMyNote(),
    );

    expect(rows[0]?.actors).toHaveLength(1);
    // The newest action is the one displayed.
    expect(rows[0]?.actors[0]?.createdAt).toBe(2000);
  });

  it("does not collapse replies, because each carries its own text", () => {
    const rows = group(
      [
        event({
          pubkey: ALICE,
          content: "first answer",
          created_at: 1000,
          tags: [
            ["p", ME],
            ["e", MY_NOTE, "", "root"],
          ],
        }),
        event({
          pubkey: BOB,
          content: "second answer",
          created_at: 1001,
          tags: [
            ["p", ME],
            ["e", MY_NOTE, "", "root"],
          ],
        }),
      ],
      knownWithMyNote(),
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.bodyPreview)).toEqual([
      "second answer",
      "first answer",
    ]);
  });
});

describe("groupNotifications — self-exclusion", () => {
  it("drops the viewer's own reaction to their own note", () => {
    expect(group([reaction(ME, MY_NOTE)], knownWithMyNote())).toEqual([]);
  });

  it("drops the viewer's own repost", () => {
    const repost = event({
      kind: 6,
      pubkey: ME,
      tags: [
        ["p", ME],
        ["e", MY_NOTE],
      ],
    });
    expect(group([repost], knownWithMyNote())).toEqual([]);
  });

  it("drops the viewer's own reply", () => {
    const self = event({
      pubkey: ME,
      content: "a note to myself",
      tags: [
        ["p", ME],
        ["e", MY_NOTE, "", "root"],
      ],
    });
    expect(group([self], knownWithMyNote())).toEqual([]);
  });

  it("keeps someone else's reaction alongside the viewer's own", () => {
    const rows = group(
      [reaction(ME, MY_NOTE), reaction(ALICE, MY_NOTE)],
      knownWithMyNote(),
    );
    expect(rows[0]?.actors.map((a) => a.pubkey)).toEqual([ALICE]);
  });

  it("drops a self-zap, which is only detectable via the claimed sender", () => {
    // A receipt is signed by the recipient's LNURL server, so `pubkey` is never
    // the viewer: checking it would never exclude anything. The zap request
    // inside the description is the only field that names the payer.
    const selfZap = event({
      kind: 9735,
      pubkey: CAROL,
      tags: [
        ["p", ME],
        ["e", MY_NOTE],
        ["P", ME],
        ["bolt11", "lnbc210n1pjabcdef"],
      ],
    });
    expect(group([selfZap], knownWithMyNote())).toEqual([]);
  });
});

describe("groupNotifications — NIP-25 downvotes", () => {
  it("excludes a `-` reaction entirely rather than counting it as a like", () => {
    const rows = group(
      [reaction(ALICE, MY_NOTE, { content: "-" })],
      knownWithMyNote(),
    );
    expect(rows).toEqual([]);
  });

  it("keeps likes when a downvote is mixed in, and does not count the downvote", () => {
    const rows = group(
      [
        reaction(ALICE, MY_NOTE, { content: "+" }),
        reaction(BOB, MY_NOTE, { content: "-" }),
      ],
      knownWithMyNote(),
    );
    expect(rows[0]?.actors.map((a) => a.pubkey)).toEqual([ALICE]);
    expect(rows[0]?.allLikes).toBe(true);
  });

  it("does not read an emoji reaction as a like", () => {
    const rows = group(
      [reaction(ALICE, MY_NOTE, { content: "💀" })],
      knownWithMyNote(),
    );
    expect(rows[0]?.allLikes).toBe(false);
  });

  it("treats an empty reaction content as a like, per NIP-25", () => {
    const rows = group(
      [reaction(ALICE, MY_NOTE, { content: "" })],
      knownWithMyNote(),
    );
    expect(rows[0]?.allLikes).toBe(true);
  });
});

describe("groupNotifications — unknown targets", () => {
  it("still renders a reaction to a note we do not hold, flagged unavailable", () => {
    const [row, ...rest] = group([reaction(ALICE, UNKNOWN_NOTE)]);

    // Dropping the row would silently hide a real notification; the honest
    // rendering is "we have not retrieved that note".
    expect(rest).toEqual([]);
    expect(row?.kind).toBe("reaction");
    expect(row?.targetId).toBe(UNKNOWN_NOTE);
    expect(row?.targetUnavailable).toBe(true);
    expect(row?.targetPreview).toBeUndefined();
  });

  it("does not claim the target is the viewer's when it was never retrieved", () => {
    const [row] = group([reaction(ALICE, UNKNOWN_NOTE)]);
    expect(row?.targetIsMine).toBe(false);
  });

  it("does not claim the target is the viewer's when it is somebody else's", () => {
    const theirs = event({ id: OTHER_NOTE, pubkey: BOB, content: "not mine" });
    const [row] = group(
      [reaction(ALICE, OTHER_NOTE)],
      new Map([[theirs.id, theirs]]),
    );
    expect(row?.targetUnavailable).toBe(false);
    expect(row?.targetIsMine).toBe(false);
  });

  it("previews the target when we hold it", () => {
    const [row] = group([reaction(ALICE, MY_NOTE)], knownWithMyNote());
    expect(row?.targetPreview).toBe("the note I wrote, which is mine");
  });

  it("renders a repost of an unknown note rather than dropping it", () => {
    const repost = event({
      kind: 6,
      pubkey: BOB,
      tags: [
        ["p", ME],
        ["e", UNKNOWN_NOTE],
      ],
    });
    const [row] = group([repost]);
    expect(row?.kind).toBe("repost");
    expect(row?.targetUnavailable).toBe(true);
  });
});

describe("groupNotifications — mention versus reply", () => {
  it("calls it a reply when an `e` tag names a note we hold and it is ours", () => {
    const [row] = group(
      [
        event({
          pubkey: ALICE,
          content: "answering you",
          tags: [
            ["p", ME],
            ["e", MY_NOTE, "", "root"],
          ],
        }),
      ],
      knownWithMyNote(),
    );

    expect(row?.kind).toBe("reply");
    expect(row?.targetId).toBe(MY_NOTE);
    expect(row?.targetIsMine).toBe(true);
    expect(row?.bodyPreview).toBe("answering you");
  });

  it("calls it a mention when the note tags the viewer but references nothing", () => {
    const [row] = group([
      event({ pubkey: ALICE, content: "hey nostr:npub… look at this" }),
    ]);
    expect(row?.kind).toBe("mention");
    expect(row?.targetId).toBeUndefined();
    expect(row?.targetUnavailable).toBe(false);
  });

  it("calls it a mention when the referenced note is someone else's", () => {
    // NIP-10 asks a reply to `p`-tag every thread participant, so "addressed to
    // you" routinely means "you are in this thread" rather than "this answers
    // your note". Claiming the latter would invent a relationship.
    const theirs = event({ id: OTHER_NOTE, pubkey: BOB, content: "theirs" });
    const [row] = group(
      [
        event({
          pubkey: ALICE,
          content: "chiming in",
          tags: [
            ["p", ME],
            ["e", OTHER_NOTE, "", "root"],
          ],
        }),
      ],
      new Map([[theirs.id, theirs]]),
    );
    expect(row?.kind).toBe("mention");
  });

  it("calls it a mention when the referenced note was never retrieved", () => {
    const [row] = group([
      event({
        pubkey: ALICE,
        content: "in some thread",
        tags: [
          ["p", ME],
          ["e", UNKNOWN_NOTE, "", "root"],
        ],
      }),
    ]);
    expect(row?.kind).toBe("mention");
  });

  it("reads a NIP-22 comment's uppercase root tag, not only the lowercase one", () => {
    const comment = event({
      kind: 1111,
      pubkey: ALICE,
      content: "a comment on your note",
      tags: [
        ["p", ME],
        ["E", MY_NOTE],
        ["K", "1"],
      ],
    });
    const [row] = group([comment], knownWithMyNote());
    expect(row?.kind).toBe("reply");
    expect(row?.targetId).toBe(MY_NOTE);
  });
});

describe("groupNotifications — zaps", () => {
  /**
   * A receipt for `sats`, claiming `sender`.
   *
   * `sats` must be a multiple of 100 that the micro-BTC form encodes exactly —
   * `bolt11Sats` floors, and its own float behaviour is `bolt11.test.ts`'s
   * subject, not this suite's. These assertions are about summing and grouping.
   */
  function zap(
    sender: string | undefined,
    sats: number,
    over: Partial<NostrEvent> = {},
  ): NostrEvent {
    const micro = sats / 100;
    return event({
      kind: 9735,
      pubkey: CAROL,
      tags: [
        ["p", ME],
        ["e", MY_NOTE],
        ...(sender ? [["P", sender]] : []),
        ["bolt11", `lnbc${micro}u1pjabcdef`],
      ],
      ...over,
    });
  }

  it("reads sats through the shared BOLT11 reader", () => {
    const [row] = group([zap(ALICE, 2100)], knownWithMyNote());
    expect(row?.kind).toBe("zap");
    expect(row?.totalSats).toBe(2100);
    expect(row?.actors[0]?.sats).toBe(2100);
  });

  it("marks a zap actor as claimed rather than signed", () => {
    const [row] = group([zap(ALICE, 1100)], knownWithMyNote());
    expect(row?.actors[0]?.attribution).toBe("claimed");
  });

  it("marks a reaction actor as signed", () => {
    const [row] = group([reaction(ALICE, MY_NOTE)], knownWithMyNote());
    expect(row?.actors[0]?.attribution).toBe("signed");
  });

  it("sums sats across every receipt collapsed into a row", () => {
    const [row] = group([zap(ALICE, 1100), zap(BOB, 2200)], knownWithMyNote());
    expect(row?.totalSats).toBe(3300);
    expect(row?.actors).toHaveLength(2);
  });

  it("sums a repeat zapper's receipts into one actor", () => {
    const [row] = group(
      [
        zap(ALICE, 1100, { created_at: 1000 }),
        zap(ALICE, 400, { created_at: 2000 }),
      ],
      knownWithMyNote(),
    );
    expect(row?.actors).toHaveLength(1);
    expect(row?.actors[0]?.sats).toBe(1500);
    expect(row?.totalSats).toBe(1500);
  });

  it("keeps an anonymous zap, with no invented sender", () => {
    const [row] = group([zap(undefined, 400)], knownWithMyNote());
    expect(row?.actors[0]?.pubkey).toBeUndefined();
    expect(row?.totalSats).toBe(400);
  });

  it("groups a profile zap that names no event separately", () => {
    const profileZap = event({
      kind: 9735,
      pubkey: CAROL,
      tags: [
        ["p", ME],
        ["P", ALICE],
        ["bolt11", "lnbc10u1pjabcdef"],
      ],
    });
    const rows = group([profileZap, zap(BOB, 100)], knownWithMyNote());
    expect(rows).toHaveLength(2);
    const profile = rows.find((r) => r.targetId === undefined);
    expect(profile?.kind).toBe("zap");
    expect(profile?.targetUnavailable).toBe(false);
  });
});

describe("groupNotifications — ordering", () => {
  it("orders rows newest first", () => {
    const known = knownWithMyNote();
    const second = myNote({ id: OTHER_NOTE, content: "second" });
    known.set(second.id, second);

    const rows = group(
      [
        reaction(ALICE, MY_NOTE, { created_at: 1000 }),
        reaction(BOB, OTHER_NOTE, { created_at: 5000 }),
      ],
      known,
    );

    expect(rows.map((r) => r.createdAt)).toEqual([5000, 1000]);
  });

  it("breaks timestamp ties deterministically, whatever order events arrive in", () => {
    const known = knownWithMyNote();
    const second = myNote({ id: OTHER_NOTE, content: "second" });
    known.set(second.id, second);

    const a = reaction(ALICE, MY_NOTE, { created_at: 1000 });
    const b = event({
      kind: 6,
      pubkey: BOB,
      created_at: 1000,
      tags: [
        ["p", ME],
        ["e", OTHER_NOTE],
      ],
    });

    const forward = group([a, b], known).map((r) => r.key);
    const backward = group([b, a], known).map((r) => r.key);

    // Equal timestamps must not let arrival order decide the layout, or rows
    // swap places between renders for no visible reason.
    expect(forward).toEqual(backward);
  });

  it("breaks actor ties deterministically too", () => {
    const first = group(
      [
        reaction(ALICE, MY_NOTE, { created_at: 1000 }),
        reaction(BOB, MY_NOTE, { created_at: 1000 }),
      ],
      knownWithMyNote(),
    );
    const second = group(
      [
        reaction(BOB, MY_NOTE, { created_at: 1000 }),
        reaction(ALICE, MY_NOTE, { created_at: 1000 }),
      ],
      knownWithMyNote(),
    );
    expect(first[0]?.actors.map((a) => a.pubkey)).toEqual(
      second[0]?.actors.map((a) => a.pubkey),
    );
  });
});

describe("referencedEventIds", () => {
  it("reads `e` tags and drops anything that is not a 32-byte hex id", () => {
    const e = event({
      tags: [
        ["e", MY_NOTE],
        ["e", "not-an-id"],
        ["e", ""],
      ],
    });
    expect(referencedEventIds(e)).toEqual([MY_NOTE]);
  });

  it("reads both `e` and `E` for a NIP-22 comment", () => {
    const e = event({
      kind: 1111,
      tags: [
        ["e", OTHER_NOTE],
        ["E", MY_NOTE],
      ],
    });
    expect(referencedEventIds(e)).toEqual([OTHER_NOTE, MY_NOTE]);
  });

  it("deduplicates", () => {
    const e = event({
      tags: [
        ["e", MY_NOTE],
        ["e", MY_NOTE],
      ],
    });
    expect(referencedEventIds(e)).toEqual([MY_NOTE]);
  });
});

describe("previewText", () => {
  it("collapses whitespace onto one line", () => {
    expect(previewText("a\n\n  b\tc")).toBe("a b c");
  });

  it("truncates with an ellipsis", () => {
    expect(previewText("abcdefghij", 4)).toBe("abcd…");
  });

  it("leaves short text untouched", () => {
    expect(previewText("short", 40)).toBe("short");
  });
});

describe("filterByKind", () => {
  it("keeps only the requested kinds, in the given order", () => {
    const rows = group(
      [
        reaction(ALICE, MY_NOTE, { created_at: 3000 }),
        event({
          pubkey: BOB,
          content: "hello",
          created_at: 2000,
          tags: [["p", ME]],
        }),
      ],
      knownWithMyNote(),
    );

    expect(filterByKind(rows, ["reaction"]).map((r) => r.kind)).toEqual([
      "reaction",
    ]);
    expect(filterByKind(rows, ["reply", "mention"]).map((r) => r.kind)).toEqual(
      ["mention"],
    );
    expect(filterByKind(rows, [])).toEqual([]);
  });
});
