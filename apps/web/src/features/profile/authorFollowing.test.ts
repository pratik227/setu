import { describe, expect, it } from "vitest";
import { projectFollowingCount } from "./useAuthorFollowing";

/**
 * The one social count a client can state exactly.
 *
 * Following is the author's own kind-3, so its `p` tags *are* the answer. The tests
 * that matter are the two ways a count can lie: a duplicate inflating it, and an
 * unfetched list reading as "follows nobody".
 */

const AUTHOR = "a".repeat(64);

function row(tags: readonly (readonly string[])[], createdAt = 1000) {
  return {
    event: {
      id: "1".repeat(64),
      pubkey: AUTHOR,
      created_at: createdAt,
      kind: 3,
      tags: tags.map((t) => [...t]),
      content: "",
      sig: "0".repeat(128),
    },
    provenance: { relays: [], firstSeen: createdAt },
  } as never;
}

const key = (n: number) => String(n).padStart(64, "b");

describe("projectFollowingCount", () => {
  it("counts the p tags of the newest list", () => {
    const result = projectFollowingCount([
      row([
        ["p", key(1)],
        ["p", key(2)],
        ["p", key(3)],
      ]),
    ]);
    expect(result).toEqual({ count: 3, loaded: true });
  });

  it("is not loaded with no list held", () => {
    // The distinction that matters: "we have not fetched it" and "they follow
    // nobody" both produce 0, and printing "0 following" while the event is still in
    // flight states something false about a person.
    expect(projectFollowingCount([])).toEqual({ count: 0, loaded: false });
  });

  it("reports a genuinely empty list as loaded", () => {
    expect(projectFollowingCount([row([])])).toEqual({
      count: 0,
      loaded: true,
    });
  });

  it("deduplicates a repeated pubkey", () => {
    // A hand-edited or merged list can name the same key twice, and "follows 412"
    // must not become 413 because of a duplicate row.
    const result = projectFollowingCount([
      row([
        ["p", key(1)],
        ["p", key(1)],
        ["p", key(2)],
      ]),
    ]);
    expect(result.count).toBe(2);
  });

  it("ignores tags that are not p tags, and p tags with no value", () => {
    const result = projectFollowingCount([
      row([
        ["p", key(1)],
        ["e", "1".repeat(64)],
        ["t", "nostr"],
        ["p"],
        ["p", ""],
        ["relay", "wss://a.example"],
      ]),
    ]);
    expect(result.count).toBe(1);
  });

  it("reads row 0, which the store guarantees is the newest", () => {
    // Replaceable last-write-wins is the store's job; this must not re-sort and must
    // not merge the two, or an older list would add back people since removed.
    const result = projectFollowingCount([
      row([["p", key(1)]], 2000),
      row(
        [
          ["p", key(2)],
          ["p", key(3)],
        ],
        1000,
      ),
    ]);
    expect(result.count).toBe(1);
  });
});
