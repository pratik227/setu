import { describe, expect, it } from "vitest";
import {
  isAddressable,
  isEphemeral,
  isRegular,
  isReplaceable,
  Kind,
} from "./kinds";

describe("Kind constants", () => {
  it("pins the wire numbers", () => {
    expect(Kind.Metadata).toBe(0);
    expect(Kind.ShortTextNote).toBe(1);
    expect(Kind.RecommendRelay).toBe(2);
    expect(Kind.Contacts).toBe(3);
    expect(Kind.EventDeletion).toBe(5);
    expect(Kind.Repost).toBe(6);
    expect(Kind.Reaction).toBe(7);
    expect(Kind.GenericRepost).toBe(16);
    expect(Kind.ChannelMessage).toBe(42);
    expect(Kind.Comment).toBe(1111);
    expect(Kind.FileMetadata).toBe(1063);
    expect(Kind.Report).toBe(1984);
    expect(Kind.ZapRequest).toBe(9734);
    expect(Kind.Zap).toBe(9735);
    expect(Kind.Highlight).toBe(9802);
    expect(Kind.MuteList).toBe(10000);
    expect(Kind.RelayList).toBe(10002);
    expect(Kind.Bookmarks).toBe(10003);
    expect(Kind.BlossomServerList).toBe(10063);
    expect(Kind.FollowSets).toBe(30000);
    expect(Kind.ProfileBadges).toBe(30008);
    expect(Kind.LongFormArticle).toBe(30023);
    expect(Kind.AppHandler).toBe(31990);
    expect(Kind.FollowPack).toBe(39089);
  });
});

describe("kind range predicates", () => {
  it("classifies replaceable kinds", () => {
    for (const kind of [0, 3, 10000, 10002, 10063, 19999]) {
      expect(isReplaceable(kind)).toBe(true);
    }
    for (const kind of [1, 2, 5, 7, 9999, 20000, 30000]) {
      expect(isReplaceable(kind)).toBe(false);
    }
  });

  it("classifies addressable kinds", () => {
    for (const kind of [30000, 30023, 31990, 39089, 39999]) {
      expect(isAddressable(kind)).toBe(true);
    }
    for (const kind of [0, 3, 29999, 40000]) {
      expect(isAddressable(kind)).toBe(false);
    }
  });

  it("classifies ephemeral kinds", () => {
    for (const kind of [20000, 24133, 29999]) {
      expect(isEphemeral(kind)).toBe(true);
    }
    for (const kind of [19999, 30000]) {
      expect(isEphemeral(kind)).toBe(false);
    }
  });

  it("treats everything else as regular", () => {
    for (const kind of [1, 2, 5, 6, 7, 16, 42, 1111, 1984, 9735, 40000]) {
      expect(isRegular(kind)).toBe(true);
    }
    for (const kind of [0, 3, 10002, 20000, 30023]) {
      expect(isRegular(kind)).toBe(false);
    }
  });

  it("puts every kind in exactly one class", () => {
    for (const kind of [0, 1, 3, 5, 9999, 10002, 20000, 30023, 40000]) {
      const classes = [
        isReplaceable(kind),
        isAddressable(kind),
        isEphemeral(kind),
        isRegular(kind),
      ].filter(Boolean);
      expect(classes).toHaveLength(1);
    }
  });
});
