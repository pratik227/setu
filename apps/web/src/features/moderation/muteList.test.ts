import { muteRulesFrom } from "@setu/core";
import { Kind, type NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  editMuteList,
  hasPrivateMuteEntries,
  isMuteTarget,
  isPlausibleMuteWrite,
  type MuteTarget,
  muteRulesInclude,
  normalizeMuteTarget,
  publicMuteEntries,
} from "./muteList";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

function list(tags: readonly (readonly string[])[], content = ""): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: "9".repeat(64),
    created_at: 1_700_000_000,
    kind: Kind.MuteList,
    tags,
    content,
    sig: "0".repeat(128),
  };
}

const pubkey = (value: string): MuteTarget => ({ kind: "pubkey", value });

describe("normalizeMuteTarget", () => {
  it("strips the hash and lowercases a hashtag", () => {
    expect(
      normalizeMuteTarget({ kind: "hashtag", value: " #Politics " }),
    ).toEqual({ kind: "hashtag", value: "politics" });
  });

  it("lowercases hex so an un-mute cannot miss its own entry", () => {
    expect(normalizeMuteTarget(pubkey(ALICE.toUpperCase()))).toEqual(
      pubkey(ALICE),
    );
  });

  it("keeps a multi-word phrase intact", () => {
    expect(
      normalizeMuteTarget({ kind: "word", value: "Free AirDrop" }),
    ).toEqual({ kind: "word", value: "free airdrop" });
  });

  it("rejects a target that normalizes to nothing", () => {
    expect(normalizeMuteTarget({ kind: "word", value: "   " })).toBeUndefined();
    expect(
      normalizeMuteTarget({ kind: "hashtag", value: "##" }),
    ).toBeUndefined();
  });
});

describe("publicMuteEntries", () => {
  it("reads all four NIP-51 entry kinds and skips the rest", () => {
    const event = list([
      ["p", ALICE],
      ["t", "#Politics"],
      ["word", "AIRDROP"],
      ["e", "f".repeat(64)],
      ["alt", "a mute list"],
    ]);
    expect(publicMuteEntries(event)).toEqual([
      { kind: "pubkey", value: ALICE },
      { kind: "hashtag", value: "politics" },
      { kind: "word", value: "airdrop" },
      { kind: "thread", value: "f".repeat(64) },
    ]);
  });

  it("dedupes entries that differ only in case", () => {
    const event = list([
      ["p", ALICE],
      ["p", ALICE.toUpperCase()],
    ]);
    expect(publicMuteEntries(event)).toHaveLength(1);
  });
});

describe("hasPrivateMuteEntries", () => {
  it("is true only for a list with a non-empty content blob", () => {
    expect(hasPrivateMuteEntries(list([], "AhBcD=="))).toBe(true);
    expect(hasPrivateMuteEntries(list([], "  "))).toBe(false);
    expect(hasPrivateMuteEntries(undefined)).toBe(false);
  });
});

describe("editMuteList", () => {
  it("refuses to create a first list from an unconfirmed absence", () => {
    const result = editMuteList({
      current: undefined,
      absenceConfirmed: false,
      target: pubkey(ALICE),
      action: "mute",
    });
    expect(result).toEqual({ ok: false, reason: "unverified-absence" });
  });

  it("creates a first list once absence is confirmed", () => {
    const result = editMuteList({
      current: undefined,
      absenceConfirmed: true,
      target: pubkey(ALICE),
      action: "mute",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.kind).toBe(Kind.MuteList);
    expect(result.template.tags).toEqual([["p", ALICE]]);
    expect(result.template.content).toBe("");
  });

  it("refuses an empty target rather than writing a blank entry", () => {
    expect(
      editMuteList({
        current: list([]),
        absenceConfirmed: true,
        target: { kind: "word", value: " " },
        action: "mute",
      }),
    ).toEqual({ ok: false, reason: "empty-target" });
  });

  it("reports no-change when the target is already in the requested state", () => {
    const current = list([["p", ALICE]]);
    expect(
      editMuteList({
        current,
        absenceConfirmed: true,
        target: pubkey(ALICE),
        action: "mute",
      }),
    ).toEqual({ ok: false, reason: "no-change" });
    expect(
      editMuteList({
        current,
        absenceConfirmed: true,
        target: pubkey(BOB),
        action: "unmute",
      }),
    ).toEqual({ ok: false, reason: "no-change" });
  });

  it("preserves every other entry, unknown tags and content when muting", () => {
    const current = list(
      [
        ["p", ALICE],
        ["t", "politics"],
        ["word", "airdrop"],
        ["e", "f".repeat(64)],
        ["something-new", "keep me"],
      ],
      "encrypted-private-half",
    );
    const result = editMuteList({
      current,
      absenceConfirmed: true,
      target: pubkey(BOB),
      action: "mute",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([...current.tags, ["p", BOB]]);
    expect(result.template.content).toBe("encrypted-private-half");
  });

  it("removes every duplicate entry for the target when un-muting", () => {
    const current = list([
      ["p", ALICE],
      ["p", BOB],
      ["p", BOB.toUpperCase()],
      ["p", CAROL],
    ]);
    const result = editMuteList({
      current,
      absenceConfirmed: true,
      target: pubkey(BOB),
      action: "unmute",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([
      ["p", ALICE],
      ["p", CAROL],
    ]);
  });

  it("does not touch same-valued entries of another kind", () => {
    // A hashtag and a word can legitimately hold the same text; un-muting one
    // must not remove the other.
    const current = list([
      ["t", "art"],
      ["word", "art"],
    ]);
    const result = editMuteList({
      current,
      absenceConfirmed: true,
      target: { kind: "word", value: "art" },
      action: "unmute",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([["t", "art"]]);
  });

  it("writes hashtags without the hash, matching what the matcher reads", () => {
    const result = editMuteList({
      current: list([]),
      absenceConfirmed: true,
      target: { kind: "hashtag", value: "#Politics" },
      action: "mute",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toEqual([["t", "politics"]]);
  });
});

describe("isMuteTarget", () => {
  it("matches regardless of hex case and hashtag spelling", () => {
    const current = list([
      ["p", ALICE.toUpperCase()],
      ["t", "Politics"],
    ]);
    expect(isMuteTarget(current, pubkey(ALICE))).toBe(true);
    expect(isMuteTarget(current, { kind: "hashtag", value: "#politics" })).toBe(
      true,
    );
    expect(isMuteTarget(current, pubkey(BOB))).toBe(false);
    expect(isMuteTarget(undefined, pubkey(ALICE))).toBe(false);
  });
});

describe("muteRulesInclude", () => {
  const rules = muteRulesFrom([
    ["p", ALICE],
    ["t", "politics"],
    ["word", "airdrop"],
    ["e", "f".repeat(64)],
  ]);

  it("answers for every entry kind, normalizing the question first", () => {
    expect(muteRulesInclude(rules, pubkey(ALICE.toUpperCase()))).toBe(true);
    expect(
      muteRulesInclude(rules, { kind: "hashtag", value: "#Politics" }),
    ).toBe(true);
    expect(muteRulesInclude(rules, { kind: "word", value: "AirDrop" })).toBe(
      true,
    );
    expect(
      muteRulesInclude(rules, { kind: "thread", value: "f".repeat(64) }),
    ).toBe(true);
  });

  it("does not confuse entry kinds that share a value", () => {
    expect(muteRulesInclude(rules, { kind: "word", value: "politics" })).toBe(
      false,
    );
    expect(muteRulesInclude(rules, pubkey(BOB))).toBe(false);
  });
});

describe("isPlausibleMuteWrite", () => {
  const before = list(
    [
      ["p", ALICE],
      ["p", BOB],
      ["t", "politics"],
      ["future-entry", "x"],
    ],
    "private",
  );

  it("accepts a write that moves the entry count by one", () => {
    const result = editMuteList({
      current: before,
      absenceConfirmed: true,
      target: pubkey(CAROL),
      action: "mute",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isPlausibleMuteWrite(before, result.template)).toBe(true);
  });

  it("blocks a write that truncates the list", () => {
    expect(
      isPlausibleMuteWrite(before, {
        kind: Kind.MuteList,
        content: "private",
        tags: [["p", CAROL]],
      }),
    ).toBe(false);
  });

  it("blocks a write that drops a tag this version does not understand", () => {
    expect(
      isPlausibleMuteWrite(before, {
        kind: Kind.MuteList,
        content: "private",
        tags: [
          ["p", ALICE],
          ["p", BOB],
          ["t", "politics"],
          ["p", CAROL],
        ],
      }),
    ).toBe(false);
  });

  it("blocks a write that blanks the encrypted private half", () => {
    expect(
      isPlausibleMuteWrite(before, {
        kind: Kind.MuteList,
        content: "",
        tags: [...before.tags, ["p", CAROL]],
      }),
    ).toBe(false);
  });

  it("accepts a first list, where there is nothing to lose", () => {
    expect(
      isPlausibleMuteWrite(undefined, {
        kind: Kind.MuteList,
        content: "",
        tags: [["p", ALICE]],
      }),
    ).toBe(true);
  });
});
