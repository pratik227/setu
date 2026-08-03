import type { EventTemplate, NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  editCommunityList,
  isJoined,
  isPlausibleCommunityWrite,
  listedCommunities,
} from "./communityList";

/**
 * Kind 10004 is replaceable, so the failure mode is not "the join did not work" —
 * it is "every community you had is gone". These tests are about the three guards
 * that prevent that.
 */

const ME = "0".repeat(64);
const A = `34550:${"a".repeat(64)}:gardening`;
const B = `34550:${"b".repeat(64)}:woodwork`;
const PRIVATE = "encrypted-private-entries";

function list(tags: string[][], content = PRIVATE): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: ME,
    created_at: 1000,
    kind: 10004,
    tags,
    content,
    sig: "0".repeat(128),
  };
}

function addresses(template: EventTemplate): string[] {
  return (template.tags ?? [])
    .filter((tag) => tag[0] === "a")
    .map((tag) => tag[1] as string);
}

describe("listedCommunities", () => {
  it("reads community coordinates, deduped and in order", () => {
    expect(
      listedCommunities(
        list([
          ["a", B],
          ["a", A],
          ["a", B],
        ]),
      ),
    ).toEqual([B, A]);
  });

  it("ignores a tags that are not communities", () => {
    // A kind-10004 may legitimately carry other `a` tags; treating one as a
    // community would put a broken row in the list.
    expect(
      listedCommunities(
        list([
          ["a", `30023:${"a".repeat(64)}:post`],
          ["a", A],
        ]),
      ),
    ).toEqual([A]);
  });

  it("is empty for no list", () => {
    expect(listedCommunities(undefined)).toEqual([]);
    expect(isJoined(undefined, A)).toBe(false);
  });
});

describe("editCommunityList", () => {
  it("joins by appending, keeping every existing tag", () => {
    const current = list([
      ["a", B],
      ["unknown", "keep me"],
    ]);
    const result = editCommunityList({
      current,
      absenceConfirmed: true,
      address: A,
      action: "join",
    });
    if (!result.ok) throw new Error("refused");
    expect(addresses(result.template)).toEqual([B, A]);
    // A tag this build does not understand must survive the round trip.
    expect(result.template.tags).toContainEqual(["unknown", "keep me"]);
  });

  it("carries content through verbatim", () => {
    // On a NIP-51 list this holds encrypted private entries. Blanking it
    // destroys them with no way back.
    const result = editCommunityList({
      current: list([["a", B]]),
      absenceConfirmed: true,
      address: A,
      action: "join",
    });
    expect(result.ok && result.template.content).toBe(PRIVATE);
  });

  it("leaves by removing every entry for that address", () => {
    // A list naming it twice would otherwise still name it once afterwards.
    const result = editCommunityList({
      current: list([
        ["a", A],
        ["a", B],
        ["a", A],
      ]),
      absenceConfirmed: true,
      address: A,
      action: "leave",
    });
    if (!result.ok) throw new Error("refused");
    expect(addresses(result.template)).toEqual([B]);
  });

  it("stores a relay hint when the community named one", () => {
    const result = editCommunityList({
      current: list([]),
      absenceConfirmed: true,
      address: A,
      action: "join",
      relayHint: "wss://a.example",
    });
    expect(result.ok && result.template.tags).toContainEqual([
      "a",
      A,
      "wss://a.example",
    ]);
  });

  it("refuses to create a list from an unconfirmed absence", () => {
    // The one that matters: indistinguishable afterwards from the user having
    // left every community they were in.
    const result = editCommunityList({
      current: undefined,
      absenceConfirmed: false,
      address: A,
      action: "join",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("unverified-absence");
  });

  it("refuses a no-op in either direction", () => {
    expect(
      editCommunityList({
        current: list([["a", A]]),
        absenceConfirmed: true,
        address: A,
        action: "join",
      }).ok,
    ).toBe(false);
    expect(
      editCommunityList({
        current: list([["a", B]]),
        absenceConfirmed: true,
        address: A,
        action: "leave",
      }).ok,
    ).toBe(false);
  });
});

describe("isPlausibleCommunityWrite", () => {
  it("allows a move of exactly one", () => {
    const current = list([["a", B]]);
    const result = editCommunityList({
      current,
      absenceConfirmed: true,
      address: A,
      action: "join",
    });
    expect(
      result.ok && isPlausibleCommunityWrite(current, result.template),
    ).toBe(true);
  });

  it("blocks a write that would drop a whole list", () => {
    // A bug upstream of here costs somebody every community they follow, so the
    // last line of defence is a size check rather than trust.
    const current = list([
      ["a", A],
      ["a", B],
      ["a", `34550:${"c".repeat(64)}:x`],
    ]);
    const gutted: EventTemplate = {
      kind: 10004,
      content: "",
      created_at: 1,
      tags: [["a", A]],
    };
    expect(isPlausibleCommunityWrite(current, gutted)).toBe(false);
  });
});
