import { describe, expect, it } from "vitest";
import { newestFollowPacks, newMembers, parseFollowPack } from "./nip51packs";
import type { NostrEvent } from "./types";

/**
 * Follow packs are events written by strangers and surfaced to a user who is about
 * to follow people based on them. The tests are mostly about what must not survive
 * parsing.
 */

const AUTHOR = "a".repeat(64);
const ALICE = "1".repeat(64);
const BOB = "2".repeat(64);

let counter = 0;
function pack(over: {
  tags?: readonly (readonly string[])[];
  kind?: number;
  createdAt?: number;
  pubkey?: string;
}): NostrEvent {
  counter += 1;
  return {
    id: String(counter).padStart(64, "0"),
    pubkey: over.pubkey ?? AUTHOR,
    created_at: over.createdAt ?? 1_700_000_000,
    kind: over.kind ?? 39089,
    tags: (over.tags ?? [["d", "friends"]]).map((t) => [...t]),
    content: "",
    sig: "0".repeat(128),
  };
}

describe("parseFollowPack", () => {
  it("reads members, title, description and image", () => {
    const parsed = parseFollowPack(
      pack({
        tags: [
          ["d", "friends"],
          ["title", "  Good people  "],
          ["description", " folks I read "],
          ["image", "https://example.com/p.png"],
          ["p", ALICE],
          ["p", BOB],
        ],
      }),
    );
    expect(parsed?.title).toBe("Good people");
    expect(parsed?.description).toBe("folks I read");
    expect(parsed?.image).toBe("https://example.com/p.png");
    expect(parsed?.pubkeys).toEqual([ALICE, BOB]);
    expect(parsed?.address).toBe(`39089:${AUTHOR}:friends`);
  });

  it("drops malformed and duplicate members", () => {
    // A malformed entry becomes a follow of nothing; a duplicate inflates the
    // number the user is deciding on.
    const parsed = parseFollowPack(
      pack({
        tags: [
          ["d", "friends"],
          ["p", ALICE],
          ["p", ALICE],
          ["p", "not-hex"],
          ["p", ""],
          ["p"],
          ["p", ALICE.toUpperCase()],
        ],
      }),
    );
    expect(parsed?.pubkeys).toEqual([ALICE]);
  });

  it("rejects a pack with no d tag", () => {
    // `d` is what makes it addressable; a synthetic one would produce a pack that
    // cannot be re-fetched or replaced by its own author.
    expect(parseFollowPack(pack({ tags: [["p", ALICE]] }))).toBeUndefined();
    expect(parseFollowPack(pack({ tags: [["d", ""]] }))).toBeUndefined();
  });

  it("ignores another kind", () => {
    expect(parseFollowPack(pack({ kind: 30000 }))).toBeUndefined();
  });

  it("falls back to the identifier when there is no title", () => {
    expect(parseFollowPack(pack({ tags: [["d", "friends"]] }))?.title).toBe(
      "friends",
    );
    // A whitespace-only title is not a title.
    expect(
      parseFollowPack(
        pack({
          tags: [
            ["d", "friends"],
            ["title", "   "],
          ],
        }),
      )?.title,
    ).toBe("friends");
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>", "not a url", ""])(
    "refuses %o as an image",
    (href) => {
      const parsed = parseFollowPack(
        pack({
          tags: [
            ["d", "friends"],
            ["image", href],
          ],
        }),
      );
      expect(parsed?.image).toBeUndefined();
    },
  );

  it("parses an empty pack rather than rejecting it", () => {
    // A real state — an author cleared it — and the caller must be able to say so
    // instead of showing a button that follows nobody.
    const parsed = parseFollowPack(pack({ tags: [["d", "friends"]] }));
    expect(parsed).toBeDefined();
    expect(parsed?.pubkeys).toEqual([]);
  });
});

describe("newestFollowPacks", () => {
  it("keeps the newest version per address", () => {
    const packs = newestFollowPacks([
      pack({
        tags: [
          ["d", "friends"],
          ["p", ALICE],
        ],
        createdAt: 1000,
      }),
      pack({
        tags: [
          ["d", "friends"],
          ["p", ALICE],
          ["p", BOB],
        ],
        createdAt: 2000,
      }),
    ]);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.pubkeys).toHaveLength(2);
  });

  it("keeps packs from different authors separate", () => {
    const other = "b".repeat(64);
    const packs = newestFollowPacks([
      pack({
        tags: [
          ["d", "friends"],
          ["p", ALICE],
        ],
      }),
      pack({
        tags: [
          ["d", "friends"],
          ["p", BOB],
        ],
        pubkey: other,
      }),
    ]);
    expect(packs).toHaveLength(2);
  });

  it("skips events that are not packs", () => {
    expect(newestFollowPacks([pack({ kind: 1 })])).toEqual([]);
  });
});

describe("newMembers", () => {
  it("reports only the people not already followed", () => {
    // "Follow 24 people" and "follow 3 you are missing" are different decisions,
    // and the second is the honest one when applying a second pack.
    const parsed = parseFollowPack(
      pack({
        tags: [
          ["d", "f"],
          ["p", ALICE],
          ["p", BOB],
        ],
      }),
    );
    expect(parsed && newMembers(parsed, new Set([ALICE]))).toEqual([BOB]);
    expect(parsed && newMembers(parsed, new Set([ALICE, BOB]))).toEqual([]);
    expect(parsed && newMembers(parsed, new Set())).toEqual([ALICE, BOB]);
  });
});
