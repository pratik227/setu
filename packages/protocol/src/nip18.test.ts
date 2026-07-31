import { describe, expect, it } from "vitest";
import { quotedEventIds } from "./nip18";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

describe("quotedEventIds", () => {
  it("reads q tags in order", () => {
    expect(
      quotedEventIds({
        tags: [
          ["q", ID_A],
          ["q", ID_B],
        ],
      }),
    ).toEqual([ID_A, ID_B]);
  });

  it("deduplicates a repeated quote", () => {
    expect(
      quotedEventIds({
        tags: [
          ["q", ID_A],
          ["q", ID_A],
        ],
      }),
    ).toEqual([ID_A]);
  });

  it("ignores e tags, which are thread edges rather than quotes", () => {
    // Conflating the two files a quote under the thread of the note it quotes.
    expect(quotedEventIds({ tags: [["e", ID_A]] })).toEqual([]);
  });

  it("drops a value that is not an event id", () => {
    // A malformed id in a filter is one some relays reject outright, taking every
    // real id in the same batch with it.
    expect(
      quotedEventIds({
        tags: [["q"], ["q", ""], ["q", "not-hex"], ["q", ID_A.slice(0, 63)]],
      }),
    ).toEqual([]);
  });
});
