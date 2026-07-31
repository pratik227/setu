import { describe, expect, it } from "vitest";
import { hex, makeEvent } from "../testing/fixtures";
import {
  isMuted,
  isMuteRulesEmpty,
  mutedReason,
  muteRulesFrom,
  muteRulesKey,
  NO_MUTES,
  occursAsWord,
} from "./muteFilter";

const ALICE = hex("alice");
const BOB = hex("bob");

describe("muteRulesFrom", () => {
  it("parses every entry kind NIP-51 defines for a mute list", () => {
    const rules = muteRulesFrom([
      ["p", ALICE],
      ["t", "Politics"],
      ["word", "AirDrop"],
      ["e", hex("thread")],
    ]);
    expect([...rules.pubkeys]).toEqual([ALICE]);
    expect([...rules.hashtags]).toEqual(["politics"]);
    expect(rules.words).toEqual(["airdrop"]);
    expect([...rules.threads]).toEqual([hex("thread")]);
  });

  it("normalizes a hashtag written with its hash and drops duplicate words", () => {
    const rules = muteRulesFrom([
      ["t", "#NostrDev"],
      ["word", "spam"],
      ["word", "SPAM"],
    ]);
    expect([...rules.hashtags]).toEqual(["nostrdev"]);
    expect(rules.words).toEqual(["spam"]);
  });

  it("ignores entries with no value and tag names it does not know", () => {
    const rules = muteRulesFrom([["p"], ["p", ""], ["nonsense", "x"]]);
    expect(isMuteRulesEmpty(rules)).toBe(true);
  });

  it("treats an empty list and NO_MUTES alike", () => {
    expect(isMuteRulesEmpty(muteRulesFrom([]))).toBe(true);
    expect(isMuteRulesEmpty(NO_MUTES)).toBe(true);
  });
});

describe("muteRulesKey", () => {
  it("is equal for lists that differ only in tag order", () => {
    const a = muteRulesFrom([
      ["p", ALICE],
      ["p", BOB],
      ["word", "b"],
      ["word", "a"],
    ]);
    const b = muteRulesFrom([
      ["word", "a"],
      ["p", BOB],
      ["word", "b"],
      ["p", ALICE],
    ]);
    expect(muteRulesKey(a)).toBe(muteRulesKey(b));
  });

  it("changes when an entry is added, so memoised filters rebuild", () => {
    const before = muteRulesKey(muteRulesFrom([["p", ALICE]]));
    const after = muteRulesKey(
      muteRulesFrom([
        ["p", ALICE],
        ["p", BOB],
      ]),
    );
    expect(after).not.toBe(before);
  });

  it("does not confuse a muted word with a muted hashtag of the same text", () => {
    expect(muteRulesKey(muteRulesFrom([["word", "art"]]))).not.toBe(
      muteRulesKey(muteRulesFrom([["t", "art"]])),
    );
  });
});

describe("occursAsWord", () => {
  it("matches a standalone occurrence", () => {
    expect(occursAsWord("the art of it", "art")).toBe(true);
  });

  it("does not match inside a longer word", () => {
    for (const text of ["party time", "start here", "smartest"]) {
      expect(occursAsWord(text, "art")).toBe(false);
    }
  });

  it("matches when punctuation is adjacent", () => {
    expect(occursAsWord("(art), really", "art")).toBe(true);
    expect(occursAsWord("#art", "#art")).toBe(true);
  });

  it("keeps scanning past a rejected match", () => {
    expect(occursAsWord("started with art", "art")).toBe(true);
  });

  it("matches multi-word phrases", () => {
    expect(occursAsWord("buy my new coin now", "new coin")).toBe(true);
  });

  it("never matches an empty needle", () => {
    expect(occursAsWord("anything", "")).toBe(false);
  });
});

describe("mutedReason", () => {
  it("mutes by author", () => {
    const rules = muteRulesFrom([["p", ALICE]]);
    expect(mutedReason(makeEvent({ pubkey: ALICE }), rules)).toBe("author");
    expect(mutedReason(makeEvent({ pubkey: BOB }), rules)).toBeUndefined();
  });

  it("mutes a hashtag declared in a t tag whatever its case", () => {
    const rules = muteRulesFrom([["t", "politics"]]);
    const event = makeEvent({ tags: [["t", "Politics"]] });
    expect(mutedReason(event, rules)).toBe("hashtag");
  });

  it("mutes a hashtag written inline, because most notes tag nothing", () => {
    const rules = muteRulesFrom([["t", "politics"]]);
    const event = makeEvent({ content: "more #politics today" });
    expect(mutedReason(event, rules)).toBe("hashtag");
  });

  it("does not mute a hashtag that is only a prefix of another", () => {
    const rules = muteRulesFrom([["t", "art"]]);
    expect(
      mutedReason(makeEvent({ content: "#artist" }), rules),
    ).toBeUndefined();
  });

  it("mutes by word, case-insensitively", () => {
    const rules = muteRulesFrom([["word", "airdrop"]]);
    const event = makeEvent({ content: "Free AIRDROP, click here" });
    expect(mutedReason(event, rules)).toBe("word");
  });

  it("mutes the muted event itself and anything referencing it", () => {
    const root = hex("root");
    const rules = muteRulesFrom([["e", root]]);
    expect(mutedReason(makeEvent({ id: root }), rules)).toBe("thread");
    expect(
      mutedReason(makeEvent({ tags: [["e", root, "", "root"]] }), rules),
    ).toBe("thread");
    expect(
      mutedReason(makeEvent({ tags: [["p", root]] }), rules),
    ).toBeUndefined();
  });

  it("reports the author rule first when several apply", () => {
    const rules = muteRulesFrom([
      ["p", ALICE],
      ["word", "hello"],
    ]);
    expect(mutedReason(makeEvent({ pubkey: ALICE }), rules)).toBe("author");
  });

  it("mutes nothing when the list is empty", () => {
    expect(isMuted(makeEvent(), NO_MUTES)).toBe(false);
    expect(isMuted(makeEvent({ content: "" }), muteRulesFrom([]))).toBe(false);
  });
});
