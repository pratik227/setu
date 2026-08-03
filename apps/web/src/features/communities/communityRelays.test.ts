import type { Community } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { approvalRelays, submitRelays } from "./communityRelays";

/**
 * The failure these guard is silent, which is why they are tested at all: a
 * submission that reaches only the author's own relays is a real, correctly-tagged,
 * published post that no moderator ever sees — and the author is told nothing.
 */

function community(relays: Partial<Community["relays"]> = {}): Community {
  return {
    identifier: "x",
    author: "a".repeat(64) as Community["author"],
    name: "X",
    moderators: [],
    relays: {
      author: [],
      requests: [],
      approvals: [],
      all: [],
      ...relays,
    },
    createdAt: 1,
    address: `34550:${"a".repeat(64)}:x`,
  } as Community;
}

describe("submitRelays", () => {
  it("puts the request relays first — that marker means 'we watch here'", () => {
    const relays = submitRelays(
      community({
        requests: ["wss://req.example"],
        approvals: ["wss://app.example"],
        author: ["wss://author.example"],
        all: ["wss://any.example"],
      }),
    );
    expect(relays[0]).toBe("wss://req.example");
    // An approvals-only relay is not where submissions belong, so it is not
    // included in the submit set at all.
    expect(relays).not.toContain("wss://app.example");
  });

  it("falls back through author, then unmarked", () => {
    expect(
      submitRelays(community({ author: ["wss://a"], all: ["wss://b"] })),
    ).toEqual(["wss://a", "wss://b"]);
    expect(submitRelays(community({ all: ["wss://b"] }))).toEqual(["wss://b"]);
  });

  it("is empty for a community that marked no relays", () => {
    // Not an error: `usePublish` still adds the author's own write relays, and
    // small communities are read on exactly those.
    expect(submitRelays(community())).toEqual([]);
  });
});

describe("approvalRelays", () => {
  it("puts the approval relays first", () => {
    const relays = approvalRelays(
      community({
        requests: ["wss://req.example"],
        approvals: ["wss://app.example"],
      }),
    );
    expect(relays[0]).toBe("wss://app.example");
    expect(relays).not.toContain("wss://req.example");
  });
});

describe("both", () => {
  it("deduplicates a relay listed under several markers", () => {
    // Common in real definitions, and a duplicate would mean publishing twice to
    // one relay and double-counting its verdict.
    const relays = submitRelays(
      community({
        requests: ["wss://one.example"],
        author: ["wss://one.example"],
        all: ["wss://one.example", "wss://two.example"],
      }),
    );
    expect(relays).toEqual(["wss://one.example", "wss://two.example"]);
  });

  it("drops empty strings", () => {
    expect(
      submitRelays(community({ requests: [""], all: ["wss://a"] })),
    ).toEqual(["wss://a"]);
  });
});
