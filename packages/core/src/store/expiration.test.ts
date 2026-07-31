/**
 * NIP-40 parsing and deadline bookkeeping.
 *
 * The end-to-end behaviour lives in the conformance suite, which proves both
 * stores agree. What is worth testing separately is the parser's table of hostile
 * inputs — every one of these has to fall the *same* way, towards "no
 * expiration", because the other direction deletes someone's note on the strength
 * of a malformed tag.
 */

import { describe, expect, it } from "vitest";
import { hex, makeEvent } from "../testing/fixtures";
import {
  ExpirationIndex,
  expirationOf,
  isExpiredAt,
  MAX_EXPIRATION_SECONDS,
  parseExpirationValue,
} from "./expiration";

describe("parseExpirationValue", () => {
  it("accepts plain positive integer seconds", () => {
    expect(parseExpirationValue("1")).toBe(1);
    expect(parseExpirationValue("1700000000")).toBe(1_700_000_000);
    expect(parseExpirationValue(String(MAX_EXPIRATION_SECONDS))).toBe(
      MAX_EXPIRATION_SECONDS,
    );
  });

  it("treats every malformed value as no expiration", () => {
    for (const value of [
      undefined,
      "",
      " ",
      "soon",
      "-1",
      "+1",
      "0",
      "1.5",
      "1e9",
      "0x10",
      "1_000",
      " 1000",
      "1000 ",
      "NaN",
      "Infinity",
      "99999999999999999999",
      String(MAX_EXPIRATION_SECONDS + 1),
      String(Number.MAX_SAFE_INTEGER),
    ]) {
      expect(parseExpirationValue(value)).toBeUndefined();
    }
  });
});

describe("expirationOf", () => {
  it("returns undefined when no expiration tag is present", () => {
    expect(
      expirationOf(makeEvent({ tags: [["p", hex("bob")]] })),
    ).toBeUndefined();
  });

  it("takes the earliest valid tag and skips malformed ones", () => {
    const event = makeEvent({
      tags: [
        ["expiration", "not-a-number"],
        ["expiration", "5000"],
        ["expiration", "4000"],
      ],
    });
    // A garbage tag must not be able to extend the life of an event whose real
    // deadline is right there in the list.
    expect(expirationOf(event)).toBe(4_000);
  });
});

describe("isExpiredAt", () => {
  it("is inclusive of the deadline second", () => {
    const event = makeEvent({ tags: [["expiration", "1000"]] });
    expect(isExpiredAt(event, 999)).toBe(false);
    expect(isExpiredAt(event, 1_000)).toBe(true);
    expect(isExpiredAt(event, 1_001)).toBe(true);
  });

  it("never reports an event without a usable deadline as expired", () => {
    const event = makeEvent({ tags: [["expiration", "whenever"]] });
    expect(isExpiredAt(event, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe("ExpirationIndex", () => {
  const at = (seed: string, deadline: number) =>
    makeEvent({ id: hex(seed), tags: [["expiration", String(deadline)]] });

  it("tracks only events that carry a usable deadline", () => {
    const index = new ExpirationIndex();
    expect(index.add(makeEvent({ id: hex("plain") }))).toBeUndefined();
    expect(index.add(at("real", 500))).toBe(500);
    expect(index.size).toBe(1);
  });

  it("orders soonest-first regardless of insertion order", () => {
    const index = new ExpirationIndex();
    for (const [seed, deadline] of [
      ["c", 300],
      ["a", 100],
      ["b", 200],
    ] as const) {
      index.add(at(seed, deadline));
    }
    expect(index.earliest()).toBe(100);
    expect(index.takeDue(200)).toEqual([hex("a"), hex("b")]);
    expect(index.earliest()).toBe(300);
    expect(index.size).toBe(1);
  });

  it("removes a specific id out of a run of equal deadlines", () => {
    const index = new ExpirationIndex();
    index.add(at("x", 100));
    index.add(at("y", 100));
    index.add(at("z", 100));
    index.remove(hex("y"));
    expect(index.size).toBe(2);
    expect(index.takeDue(100)).toEqual([hex("x"), hex("z")]);
  });

  it("takeDue yields nothing before the deadline and clears on demand", () => {
    const index = new ExpirationIndex();
    index.add(at("later", 500));
    expect(index.takeDue(499)).toEqual([]);
    index.clear();
    expect(index.size).toBe(0);
    expect(index.earliest()).toBeUndefined();
  });
});
