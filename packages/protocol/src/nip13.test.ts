import { describe, expect, it } from "vitest";
import { computeEventId } from "./event";
import {
  committedDifficulty,
  eventDifficulty,
  leadingZeroBits,
  mineEvent,
} from "./nip13";
import type { UnsignedEvent } from "./types";

const AUTHOR = "a".repeat(64);

function unsigned(over: Partial<UnsignedEvent> = {}): UnsignedEvent {
  return {
    pubkey: AUTHOR,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: "hello",
    ...over,
  };
}

describe("leadingZeroBits", () => {
  it("counts bits, not hex characters", () => {
    // The factor-of-four mistake this exists to prevent: `0f…` is one zero nibble and
    // four zero bits. Counting characters would advertise 8 for work worth 32.
    expect(leadingZeroBits("0f".padEnd(64, "0"))).toBe(4);
    expect(leadingZeroBits("00ff".padEnd(64, "0"))).toBe(8);
    expect(leadingZeroBits("000f".padEnd(64, "0"))).toBe(12);
  });

  it("counts within a nibble", () => {
    expect(leadingZeroBits("8".padEnd(64, "0"))).toBe(0);
    expect(leadingZeroBits("4".padEnd(64, "0"))).toBe(1);
    expect(leadingZeroBits("2".padEnd(64, "0"))).toBe(2);
    expect(leadingZeroBits("1".padEnd(64, "0"))).toBe(3);
  });

  it("is 0 for a hash with no leading zero", () => {
    expect(leadingZeroBits("f".repeat(64))).toBe(0);
  });

  it("counts an all-zero hash as every bit", () => {
    expect(leadingZeroBits("0".repeat(64))).toBe(256);
  });

  it("stops at a non-hex character rather than throwing", () => {
    // Also runs on ids that came from a relay; a malformed one has no difficulty.
    expect(leadingZeroBits("00zz")).toBe(8);
    expect(leadingZeroBits("")).toBe(0);
    expect(leadingZeroBits("nonsense")).toBe(0);
  });
});

describe("committedDifficulty", () => {
  it("reads the target from the nonce tag", () => {
    expect(committedDifficulty({ tags: [["nonce", "42", "16"]] })).toBe(16);
  });

  it("is undefined with no nonce tag or a malformed target", () => {
    expect(committedDifficulty({ tags: [] })).toBeUndefined();
    expect(committedDifficulty({ tags: [["nonce", "42"]] })).toBeUndefined();
    expect(
      committedDifficulty({ tags: [["nonce", "42", "lots"]] }),
    ).toBeUndefined();
    expect(
      committedDifficulty({ tags: [["nonce", "42", "-1"]] }),
    ).toBeUndefined();
  });

  it("is a claim, not evidence — the hash is what counts", () => {
    // A committed target is trivially inflated. `eventDifficulty` measures the id, and
    // a client trusting the tag would let anyone claim any difficulty.
    const event = unsigned({ tags: [["nonce", "0", "255"]] });
    expect(committedDifficulty(event)).toBe(255);
    expect(eventDifficulty(computeEventId(event))).toBeLessThan(255);
  });
});

describe("mineEvent", () => {
  it("reaches a small target and reports the work", () => {
    const result = mineEvent(unsigned(), { targetBits: 8, timeoutMs: 30_000 });
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.difficulty).toBeGreaterThanOrEqual(8);
    expect(result.hashes).toBeGreaterThan(0);
    // And the id genuinely has the zeros, measured independently of the miner.
    expect(leadingZeroBits(computeEventId(result.event))).toBe(
      result.difficulty,
    );
  });

  it("commits the target it was asked for in the nonce tag", () => {
    const result = mineEvent(unsigned(), { targetBits: 8, timeoutMs: 30_000 });
    const nonce = result?.event.tags.find((tag) => tag[0] === "nonce");
    expect(nonce?.[2]).toBe("8");
    expect(Number(nonce?.[1])).toBeGreaterThanOrEqual(0);
  });

  it("does nothing for a target of 0 or less", () => {
    for (const targetBits of [0, -5]) {
      const result = mineEvent(unsigned(), { targetBits, timeoutMs: 1000 });
      expect(result?.hashes).toBe(0);
      expect(result?.event.tags).toEqual([]);
    }
  });

  it("replaces an existing nonce rather than accumulating one per attempt", () => {
    // Re-mining must not grow the event on every retry.
    const result = mineEvent(unsigned({ tags: [["nonce", "999", "4"]] }), {
      targetBits: 8,
      timeoutMs: 30_000,
    });
    const nonces = result?.event.tags.filter((tag) => tag[0] === "nonce") ?? [];
    expect(nonces).toHaveLength(1);
    expect(nonces[0]?.[2]).toBe("8");
  });

  it("keeps every other tag", () => {
    const result = mineEvent(
      unsigned({
        tags: [
          ["t", "nostr"],
          ["nonce", "1", "2"],
        ],
      }),
      { targetBits: 4, timeoutMs: 30_000 },
    );
    expect(result?.event.tags).toContainEqual(["t", "nostr"]);
  });

  it("never changes created_at", () => {
    // Bumping it is a real extra-entropy technique and is deliberately not used: it
    // would re-date a note the user wrote a minute ago, and reorder a reply.
    const event = unsigned();
    const result = mineEvent(event, { targetBits: 8, timeoutMs: 30_000 });
    expect(result?.event.created_at).toBe(event.created_at);
    expect(result?.event.content).toBe(event.content);
    expect(result?.event.pubkey).toBe(event.pubkey);
  });

  it("gives up on the deadline rather than looping forever", () => {
    // Difficulty is exponential: 30 bits is about a billion hashes. A composer that
    // hangs is worse than one that says the relay wants more work than we could do.
    let ticks = 0;
    const result = mineEvent(unsigned(), {
      targetBits: 240,
      timeoutMs: 10,
      // Jumps past the deadline on the first check, so the test costs 512 hashes
      // rather than real time.
      now: () => {
        ticks += 1;
        return ticks === 1 ? 0 : 1_000_000;
      },
    });
    expect(result).toBeUndefined();
  });
});
