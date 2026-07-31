import { muteRulesFrom, NO_MUTES } from "@setu/core";
import { describe, expect, it } from "vitest";
import {
  checkMuteDraft,
  groupMuteEntries,
  MAX_MUTE_VALUE_LENGTH,
  mutedListSummary,
} from "./mutedListModel";
import type { MuteTarget } from "./muteList";

const BOB = "b".repeat(64);
const ROOT = "f".repeat(64);

const entries: readonly MuteTarget[] = [
  { kind: "word", value: "airdrop" },
  { kind: "pubkey", value: BOB },
  { kind: "hashtag", value: "politics" },
  { kind: "thread", value: ROOT },
  { kind: "word", value: "giveaway" },
];

describe("groupMuteEntries", () => {
  it("returns every kind in a fixed order, accounts first", () => {
    expect(groupMuteEntries(entries).map((s) => s.kind)).toEqual([
      "pubkey",
      "word",
      "hashtag",
      "thread",
    ]);
  });

  it("keeps list order inside a group, because that is mute order", () => {
    const words = groupMuteEntries(entries).find((s) => s.kind === "word");
    expect(words?.targets.map((t) => t.value)).toEqual(["airdrop", "giveaway"]);
  });

  it("returns empty groups rather than dropping them", () => {
    const groups = groupMuteEntries([]);
    expect(groups).toHaveLength(4);
    expect(groups.every((group) => group.targets.length === 0)).toBe(true);
  });

  it("explains what each kind matches", () => {
    for (const group of groupMuteEntries(entries)) {
      expect(group.blurb.length).toBeGreaterThan(20);
      expect(group.title).not.toBe("");
    }
  });
});

describe("checkMuteDraft", () => {
  it("accepts a normal word, lowercased", () => {
    const result = checkMuteDraft("word", "  AirDrop ", NO_MUTES);
    expect(result).toEqual({
      ok: true,
      target: { kind: "word", value: "airdrop" },
    });
  });

  it("accepts a hashtag with or without the hash", () => {
    expect(checkMuteDraft("hashtag", "#Politics", NO_MUTES)).toEqual({
      ok: true,
      target: { kind: "hashtag", value: "politics" },
    });
  });

  it("refuses a one-character word before it empties the timeline", () => {
    const result = checkMuteDraft("word", "a", NO_MUTES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe("too-short");
  });

  it("refuses a hashtag typed into the word field rather than converting it", () => {
    const result = checkMuteDraft("word", "#politics", NO_MUTES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe("hashtag-in-word");
  });

  it("refuses an empty draft", () => {
    expect(checkMuteDraft("word", "   ", NO_MUTES).ok).toBe(false);
    expect(checkMuteDraft("hashtag", "#", NO_MUTES).ok).toBe(false);
  });

  it("refuses something long enough to be pasted content", () => {
    const result = checkMuteDraft(
      "word",
      "x".repeat(MAX_MUTE_VALUE_LENGTH + 1),
      NO_MUTES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe("too-long");
  });

  it("catches a duplicate before it costs a signature", () => {
    const rules = muteRulesFrom([
      ["word", "airdrop"],
      ["t", "politics"],
    ]);
    const word = checkMuteDraft("word", "AIRDROP", rules);
    expect(word.ok).toBe(false);
    if (!word.ok) expect(word.problem).toBe("duplicate");
    expect(checkMuteDraft("hashtag", "#politics", rules).ok).toBe(false);
  });
});

describe("mutedListSummary", () => {
  it("does not claim the list is empty before it has arrived", () => {
    const summary = mutedListSummary({
      entries: [],
      loaded: false,
      hasPrivateEntries: false,
    });
    expect(summary).toContain("Still reading");
    expect(summary).not.toContain("empty");
  });

  it("says the list is empty once it has", () => {
    expect(
      mutedListSummary({
        entries: [],
        loaded: true,
        hasPrivateEntries: false,
      }),
    ).toContain("empty");
  });

  it("says the list is public, because readers assume it is not", () => {
    expect(
      mutedListSummary({ entries, loaded: true, hasPrivateEntries: false }),
    ).toContain("unencrypted");
  });

  it("admits private entries are not applied", () => {
    const summary = mutedListSummary({
      entries,
      loaded: true,
      hasPrivateEntries: true,
    });
    expect(summary).toContain("not applied");
  });
});
