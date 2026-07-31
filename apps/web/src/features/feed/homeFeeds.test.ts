import { Kind } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  asHomeFeedId,
  GLOBAL_WINDOW_SECONDS,
  HOME_FEEDS,
  homeFeedDefinition,
  homeFeedOption,
} from "./homeFeeds";

const NOW = 1_800_000_000;
const RELAYS = ["wss://a.example", "wss://b.example"];
const FOLLOWS = ["a".repeat(64), "b".repeat(64)];

describe("homeFeedOption", () => {
  it("falls back to the first feed for an unknown id", () => {
    // Defaulting rather than throwing: the id can come from persisted state
    // written by an older build, and a crash on launch is worse than a feed.
    expect(homeFeedOption("nonsense" as never).id).toBe("latest");
  });

  it("defaults to a follow-scoped feed, never the global one", () => {
    expect(HOME_FEEDS[0]!.needsFollows).toBe(true);
  });
});

describe("homeFeedDefinition", () => {
  it("scopes the default feed to followed authors and omits since", () => {
    const definition = homeFeedDefinition({
      id: "latest",
      followedAuthors: FOLLOWS,
      relays: RELAYS,
      now: NOW,
    });
    expect(definition?.authors).toEqual(FOLLOWS);
    expect(definition?.kinds).toEqual([
      Kind.ShortTextNote,
      Kind.Repost,
      Kind.Picture,
      Kind.Video,
      Kind.ShortVideo,
      Kind.Poll,
    ]);
    // An author-scoped feed is already bounded by the author set; a time bound
    // on top of it would hide a quiet account's older notes.
    expect(definition?.since).toBeUndefined();
  });

  it("adds comment kinds only for the replies feed", () => {
    const withReplies = homeFeedDefinition({
      id: "latest-replies",
      followedAuthors: FOLLOWS,
      relays: RELAYS,
      now: NOW,
    });
    expect(withReplies?.kinds).toContain(Kind.Comment);

    const without = homeFeedDefinition({
      id: "latest",
      followedAuthors: FOLLOWS,
      relays: RELAYS,
      now: NOW,
    });
    expect(without?.kinds).not.toContain(Kind.Comment);
  });

  it("asks for the media-first and poll kinds, not only text notes", () => {
    // A feed that asks only for kind 1 shows an account that publishes pictures as
    // an account that has stopped posting.
    const definition = homeFeedDefinition({
      id: "latest",
      followedAuthors: FOLLOWS,
      relays: RELAYS,
      now: NOW,
    });
    for (const kind of [Kind.Picture, Kind.Video, Kind.ShortVideo, Kind.Poll]) {
      expect(definition?.kinds).toContain(kind);
    }
  });

  it("bounds the global feed to the last 24 hours", () => {
    const definition = homeFeedDefinition({
      id: "global-24h",
      followedAuthors: [],
      relays: RELAYS,
      now: NOW,
    });
    expect(definition?.since).toBe(NOW - GLOBAL_WINDOW_SECONDS);
    expect(GLOBAL_WINDOW_SECONDS).toBe(86_400);
  });

  it("never returns an unbounded filter", () => {
    // The regression that matters: every definition this module can produce must
    // narrow by authors, by time, or both. A definition with neither is the
    // firehose, and it was previously the default.
    for (const feed of HOME_FEEDS) {
      const definition = homeFeedDefinition({
        id: feed.id,
        followedAuthors: FOLLOWS,
        relays: RELAYS,
        now: NOW,
      });
      const bounded =
        (definition?.authors?.length ?? 0) > 0 ||
        definition?.since !== undefined;
      expect(bounded, `${feed.id} is unbounded`).toBe(true);
    }
  });

  it("returns undefined rather than substituting global when follows are empty", () => {
    // The dangerous failure: silently showing thousands of strangers' notes to
    // someone who asked for the people they follow.
    for (const id of ["latest", "latest-replies"] as const) {
      expect(
        homeFeedDefinition({
          id,
          followedAuthors: [],
          relays: RELAYS,
          now: NOW,
        }),
      ).toBeUndefined();
    }
  });

  it("still builds the global feed with no follows", () => {
    expect(
      homeFeedDefinition({
        id: "global-24h",
        followedAuthors: [],
        relays: RELAYS,
        now: NOW,
      }),
    ).toBeDefined();
  });
});

describe("asHomeFeedId", () => {
  it("keeps every id the picker offers", () => {
    for (const feed of HOME_FEEDS) {
      expect(asHomeFeedId(feed.id)).toBe(feed.id);
    }
  });

  it.each(["", "trending", "global", "latest ", "LATEST"])(
    "narrows %o to the default feed",
    (stored) => {
      // The persisted preference is a string. It can be hand-edited, and it can
      // come from a newer build that offered a feed this one does not have —
      // casting it would build a filter for a feed with no definition, and the
      // reader would get an empty timeline with no way to tell why.
      expect(asHomeFeedId(stored)).toBe("latest");
    },
  );

  it("resolves to a feed that has a definition", () => {
    // The property that matters: whatever comes out can actually be fetched.
    expect(
      homeFeedDefinition({
        id: asHomeFeedId("nonsense"),
        followedAuthors: FOLLOWS,
        relays: RELAYS,
        now: NOW,
      }),
    ).toBeDefined();
  });
});
