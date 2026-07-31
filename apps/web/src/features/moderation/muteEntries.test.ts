import { type FeedEntry, muteRulesFrom, NO_MUTES } from "@setu/core";
import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { filterMutedEntries, muteFilterNotice } from "./muteEntries";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

let counter = 0;
function note(
  overrides: Partial<
    Pick<NostrEvent, "pubkey" | "content" | "tags" | "id">
  > = {},
): NostrEvent {
  counter += 1;
  return {
    id: overrides.id ?? `${counter}`.padStart(64, "0"),
    pubkey: overrides.pubkey ?? ALICE,
    created_at: 1_700_000_000 + counter,
    kind: 1,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "hello",
    sig: "0".repeat(128),
  };
}

function noteRow(event: NostrEvent): FeedEntry {
  return {
    key: `note:${event.id}`,
    kind: "note",
    event,
    createdAt: event.created_at,
    reposters: [],
    repostIds: [],
  };
}

function repostRow(
  target: NostrEvent,
  reposters: readonly string[],
): FeedEntry {
  return {
    key: `repost:${target.id}:1`,
    kind: "repost",
    event: note({ pubkey: reposters[0] ?? BOB }),
    createdAt: target.created_at + 10,
    reposters,
    repostIds: reposters.map((_, index) => `${index}`.repeat(64)),
    targetId: target.id,
    target,
  };
}

describe("filterMutedEntries", () => {
  it("returns the very same array when nothing is muted", () => {
    const entries = [noteRow(note()), noteRow(note())];
    const result = filterMutedEntries(entries, { rules: NO_MUTES });
    expect(result.entries).toBe(entries);
    expect(result.hiddenRows).toBe(0);
  });

  it("returns the very same array when the rules match nothing on the page", () => {
    const entries = [noteRow(note({ pubkey: ALICE }))];
    const result = filterMutedEntries(entries, {
      rules: muteRulesFrom([["p", BOB]]),
    });
    expect(result.entries).toBe(entries);
  });

  it("drops rows by muted author and counts them", () => {
    const entries = [
      noteRow(note({ pubkey: ALICE })),
      noteRow(note({ pubkey: BOB })),
    ];
    const result = filterMutedEntries(entries, {
      rules: muteRulesFrom([["p", BOB]]),
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toBe(entries[0]);
    expect(result.hiddenRows).toBe(1);
  });

  it("drops a row whose word rule matches, and keeps unchanged rows identical", () => {
    const keep = noteRow(note({ content: "a normal note" }));
    const entries = [keep, noteRow(note({ content: "free AIRDROP today" }))];
    const result = filterMutedEntries(entries, {
      rules: muteRulesFrom([["word", "airdrop"]]),
    });
    expect(result.entries).toEqual([keep]);
    expect(result.entries[0]).toBe(keep);
  });

  it("never hides the reader's own note, whatever the word rules say", () => {
    const own = noteRow(
      note({ pubkey: CAROL, content: "my own airdrop post" }),
    );
    const result = filterMutedEntries([own], {
      rules: muteRulesFrom([["word", "airdrop"]]),
      viewerPubkey: CAROL,
    });
    expect(result.entries).toEqual([own]);
    expect(result.hiddenRows).toBe(0);
  });

  it("drops a repost row whose target author is muted", () => {
    const target = note({ pubkey: BOB });
    const result = filterMutedEntries([repostRow(target, [CAROL])], {
      rules: muteRulesFrom([["p", BOB]]),
    });
    expect(result.entries).toHaveLength(0);
    expect(result.hiddenRows).toBe(1);
  });

  it("drops a repost row when every reposter is muted", () => {
    const target = note({ pubkey: ALICE });
    const result = filterMutedEntries([repostRow(target, [BOB])], {
      rules: muteRulesFrom([["p", BOB]]),
    });
    expect(result.entries).toHaveLength(0);
    expect(result.hiddenRows).toBe(1);
    expect(result.trimmedReposts).toBe(0);
  });

  it("keeps the row but drops the muted reposter from the credit line", () => {
    const target = note({ pubkey: ALICE });
    const row = repostRow(target, [BOB, CAROL]);
    const result = filterMutedEntries([row], {
      rules: muteRulesFrom([["p", BOB]]),
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.reposters).toEqual([CAROL]);
    expect(result.entries[0]?.target).toBe(target);
    expect(result.trimmedReposts).toBe(1);
    expect(result.hiddenRows).toBe(0);
  });

  it("hands back the same rewritten object across passes, via the cache", () => {
    const row = repostRow(note({ pubkey: ALICE }), [BOB, CAROL]);
    const cache = new WeakMap<FeedEntry, FeedEntry | null>();
    const options = { rules: muteRulesFrom([["p", BOB]]), cache };
    const first = filterMutedEntries([row], options);
    const second = filterMutedEntries([row], options);
    expect(second.entries[0]).toBe(first.entries[0]);
    expect(second.trimmedReposts).toBe(1);
  });

  it("keeps counting dropped rows on a cached pass", () => {
    const rows = [noteRow(note({ pubkey: BOB })), noteRow(note())];
    const cache = new WeakMap<FeedEntry, FeedEntry | null>();
    const options = { rules: muteRulesFrom([["p", BOB]]), cache };
    filterMutedEntries(rows, options);
    const again = filterMutedEntries(rows, options);
    expect(again.hiddenRows).toBe(1);
    expect(again.entries).toHaveLength(1);
  });

  it("drops a row in a muted thread", () => {
    const root = "f".repeat(64);
    const reply = noteRow(note({ tags: [["e", root, "", "root"]] }));
    const result = filterMutedEntries([reply], {
      rules: muteRulesFrom([["e", root]]),
    });
    expect(result.entries).toHaveLength(0);
  });
});

describe("muteFilterNotice", () => {
  it("says nothing when nothing was filtered", () => {
    expect(
      muteFilterNotice({ entries: [], hiddenRows: 0, trimmedReposts: 0 }),
    ).toBeUndefined();
  });

  it("states the row count and names the mute list as the cause", () => {
    expect(
      muteFilterNotice({ entries: [], hiddenRows: 1, trimmedReposts: 0 }),
    ).toBe("1 note hidden by your mute list.");
    expect(
      muteFilterNotice({ entries: [], hiddenRows: 4, trimmedReposts: 0 }),
    ).toBe("4 notes hidden by your mute list.");
  });

  it("states trimmed reposts too, because that is also a hidden count", () => {
    expect(
      muteFilterNotice({ entries: [], hiddenRows: 2, trimmedReposts: 1 }),
    ).toBe(
      "2 notes hidden by your mute list, 1 repost by muted accounts not credited.",
    );
  });
});
