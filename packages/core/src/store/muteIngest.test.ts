import type { NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { muteRulesFrom, NO_MUTES } from "./muteFilter";
import {
  MUTE_REFUSABLE_KINDS,
  MuteIngestPolicy,
  mutedAtIngest,
} from "./muteIngest";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

let counter = 0;
function event(over: Partial<NostrEvent> = {}): NostrEvent {
  counter += 1;
  return {
    id: `${counter}`.padStart(64, "0"),
    pubkey: over.pubkey ?? BOB,
    created_at: 1_700_000_000 + counter,
    kind: over.kind ?? 7,
    tags: over.tags ?? [],
    content: over.content ?? "+",
    sig: "0".repeat(128),
  };
}

const mutedBob = muteRulesFrom([["p", BOB]]);

describe("mutedAtIngest", () => {
  it("refuses a muted author's reaction, repost and zap receipt", () => {
    for (const kind of MUTE_REFUSABLE_KINDS) {
      expect(mutedAtIngest(event({ kind }), { rules: mutedBob })).toBe(true);
    }
  });

  it("keeps a muted author's notes, replies and comments", () => {
    // The load-bearing decision: refusing these would orphan every reply below
    // them and make un-muting unable to bring a conversation back.
    for (const kind of [1, 1111, 30023]) {
      expect(mutedAtIngest(event({ kind }), { rules: mutedBob })).toBe(false);
    }
  });

  it("keeps an unmuted author's reactions", () => {
    expect(mutedAtIngest(event({ pubkey: ALICE }), { rules: mutedBob })).toBe(
      false,
    );
  });

  it("never refuses the reader's own reaction", () => {
    // Otherwise `viewerReacted` goes false and the row offers to react again.
    expect(
      mutedAtIngest(event({ pubkey: BOB }), {
        rules: mutedBob,
        viewerPubkey: BOB,
      }),
    ).toBe(false);
  });

  it("ignores word rules, so a punctuation word cannot refuse every like", () => {
    const rules = muteRulesFrom([["word", "+"]]);
    expect(mutedAtIngest(event({ content: "+" }), { rules })).toBe(false);
  });

  it("ignores hashtag and thread rules", () => {
    const root = "f".repeat(64);
    expect(
      mutedAtIngest(event({ tags: [["e", root]] }), {
        rules: muteRulesFrom([["e", root]]),
      }),
    ).toBe(false);
    expect(
      mutedAtIngest(event({ tags: [["t", "spam"]] }), {
        rules: muteRulesFrom([["t", "spam"]]),
      }),
    ).toBe(false);
  });

  it("refuses nothing when no author is muted", () => {
    expect(mutedAtIngest(event(), { rules: NO_MUTES })).toBe(false);
  });
});

describe("MuteIngestPolicy", () => {
  it("starts inert and refuses nothing", () => {
    const policy = new MuteIngestPolicy();
    expect(policy.inert).toBe(true);
    expect(policy.blocks(event())).toBe(false);
  });

  it("blocks once rules arrive, and reports whether it changed", () => {
    const policy = new MuteIngestPolicy();
    expect(policy.update(mutedBob)).toBe(true);
    // The same object back is the common case — the store re-emits an unchanged
    // list several times a second — and must not read as a change.
    expect(policy.update(mutedBob)).toBe(false);
    expect(policy.blocks(event())).toBe(true);
  });

  it("stops blocking after an unmute, forward-looking only", () => {
    const policy = new MuteIngestPolicy({ rules: mutedBob });
    expect(policy.blocks(event())).toBe(true);
    policy.update(NO_MUTES);
    expect(policy.blocks(event())).toBe(false);
  });

  it("honours the viewer exemption handed to the constructor", () => {
    const policy = new MuteIngestPolicy({
      rules: mutedBob,
      viewerPubkey: BOB,
    });
    expect(policy.blocks(event({ pubkey: BOB }))).toBe(false);
  });

  it("clears back to inert", () => {
    const policy = new MuteIngestPolicy({ rules: mutedBob });
    policy.clear();
    expect(policy.inert).toBe(true);
    expect(policy.blocks(event())).toBe(false);
  });
});
