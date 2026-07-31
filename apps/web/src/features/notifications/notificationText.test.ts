import { describe, expect, it } from "vitest";
import { actorPhrase, notificationLine } from "./notificationText";

const line = (
  over: Partial<Parameters<typeof notificationLine>[0]> = {},
): string =>
  notificationLine({
    kind: "reaction",
    names: ["Aditi"],
    actorCount: 1,
    targetIsMine: true,
    allLikes: true,
    ...over,
  });

describe("actorPhrase", () => {
  it("names one actor", () => {
    expect(actorPhrase(["Aditi"], 1)).toBe("Aditi");
  });

  it("names both actors rather than saying 'and 1 other'", () => {
    expect(actorPhrase(["Aditi", "Rahul"], 2)).toBe("Aditi and Rahul");
  });

  it("counts the rest past two", () => {
    expect(actorPhrase(["Aditi", "Rahul"], 5)).toBe("Aditi and 4 others");
  });

  it("falls back rather than inventing a name when none resolved", () => {
    expect(actorPhrase([], 1)).toBe("Someone");
    expect(actorPhrase(["Aditi"], 2)).toBe("Aditi and Someone");
  });
});

describe("notificationLine", () => {
  it("says liked for a plain like", () => {
    expect(line()).toBe("Aditi liked your note");
  });

  it("says reacted when the reactions are not plain likes", () => {
    expect(line({ allLikes: false })).toBe("Aditi reacted to your note");
  });

  it("does not claim the target is yours when it was not verified", () => {
    expect(line({ targetIsMine: false })).toBe("Aditi liked a note");
  });

  it("collapses a crowd", () => {
    expect(line({ names: ["Aditi", "Rahul"], actorCount: 5 })).toBe(
      "Aditi and 4 others liked your note",
    );
  });

  it("words each kind", () => {
    expect(line({ kind: "reply" })).toBe("Aditi replied to your note");
    expect(line({ kind: "repost" })).toBe("Aditi reposted your note");
    expect(line({ kind: "zap" })).toBe("Aditi zapped your note");
  });

  it("does not attach a target phrase to a mention", () => {
    // A mention has no target by construction; "mentioned you in your note"
    // would be nonsense.
    expect(line({ kind: "mention", targetIsMine: false })).toBe(
      "Aditi mentioned you",
    );
  });
});
