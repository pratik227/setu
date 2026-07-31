import { describe, expect, it } from "vitest";
import { Kind } from "./kinds";
import { parsePoll, parsePollResponse, pollHasEnded, tallyPoll } from "./nip88";
import type { NostrEvent } from "./types";

const POLL_ID = "1".repeat(64);
const AUTHOR = "a".repeat(64);
const VOTER_A = "b".repeat(64);
const VOTER_B = "c".repeat(64);

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: POLL_ID,
    pubkey: AUTHOR,
    created_at: 1000,
    kind: Kind.Poll,
    tags: [
      ["option", "yes", "Yes"],
      ["option", "no", "No"],
    ],
    content: "Ship it?",
    sig: "0".repeat(128),
    ...over,
  };
}

function response(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "9".repeat(64),
    pubkey: VOTER_A,
    created_at: 1100,
    kind: Kind.PollResponse,
    tags: [
      ["e", POLL_ID],
      ["response", "yes"],
    ],
    content: "",
    sig: "0".repeat(128),
    ...over,
  };
}

/** The poll every tally test counts against. */
function poll(over: Partial<NostrEvent> = {}) {
  const parsed = parsePoll(event(over));
  if (!parsed) throw new Error("fixture is not a poll");
  return parsed;
}

function responses(events: readonly NostrEvent[]) {
  return events.flatMap((raw) => {
    const parsed = parsePollResponse(raw);
    return parsed ? [parsed] : [];
  });
}

describe("parsePoll", () => {
  it("reads the question, options and default single-choice type", () => {
    const parsed = poll();
    expect(parsed.question).toBe("Ship it?");
    expect(parsed.options).toEqual([
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ]);
    expect(parsed.type).toBe("singlechoice");
  });

  it("falls back to the option id when the author wrote no label", () => {
    // An option rendered as an empty button cannot be voted on, and dropping it
    // would silently change the poll being shown.
    const parsed = poll({ tags: [["option", "yes"]] });
    expect(parsed.options).toEqual([{ id: "yes", label: "yes" }]);
  });

  it("keeps the first of two rows declaring the same option id", () => {
    const parsed = poll({
      tags: [
        ["option", "yes", "Yes"],
        ["option", "yes", "Also yes"],
      ],
    });
    expect(parsed.options).toEqual([{ id: "yes", label: "Yes" }]);
  });

  it("rejects an event with no options", () => {
    // The only thing such a card could offer is a question nobody can answer.
    expect(parsePoll(event({ tags: [] }))).toBeUndefined();
  });

  it("rejects an event of another kind", () => {
    expect(parsePoll(event({ kind: Kind.ShortTextNote }))).toBeUndefined();
  });

  it("reads multiplechoice, and treats anything unrecognised as single", () => {
    expect(
      poll({
        tags: [
          ["option", "a"],
          ["polltype", "multiplechoice"],
        ],
      }).type,
    ).toBe("multiplechoice");
    expect(
      poll({
        tags: [
          ["option", "a"],
          ["polltype", "ranked"],
        ],
      }).type,
    ).toBe("singlechoice");
  });

  it("ignores an endsAt that is not a usable timestamp", () => {
    // `Number("soon")` is NaN, which compares false against every timestamp — so a
    // malformed value would make a closed poll look open forever.
    expect(
      poll({
        tags: [
          ["option", "a"],
          ["endsAt", "soon"],
        ],
      }).endsAt,
    ).toBeUndefined();
    expect(
      poll({
        tags: [
          ["option", "a"],
          ["endsAt", "2000"],
        ],
      }).endsAt,
    ).toBe(2000);
  });

  it("collects relay hints, deduplicated", () => {
    const parsed = poll({
      tags: [
        ["option", "a"],
        ["relay", "wss://one.test"],
        ["relay", "wss://one.test"],
        ["relay", "wss://two.test"],
      ],
    });
    expect(parsed.relays).toEqual(["wss://one.test", "wss://two.test"]);
  });
});

describe("parsePollResponse", () => {
  it("reads the poll id and the picked options", () => {
    const parsed = parsePollResponse(
      response({
        tags: [
          ["e", POLL_ID],
          ["response", "yes"],
          ["response", "no"],
        ],
      }),
    );
    expect(parsed?.pollId).toBe(POLL_ID);
    expect(parsed?.optionIds).toEqual(["yes", "no"]);
  });

  it("rejects a response whose e tag is not an event id", () => {
    // It would become an id in a relay filter, and a malformed id is one some
    // relays reject outright — taking every real id in the batch with it.
    expect(
      parsePollResponse(response({ tags: [["e", "nope"]] })),
    ).toBeUndefined();
  });

  it("deduplicates repeated option ids", () => {
    const parsed = parsePollResponse(
      response({
        tags: [
          ["e", POLL_ID],
          ["response", "yes"],
          ["response", "yes"],
        ],
      }),
    );
    expect(parsed?.optionIds).toEqual(["yes"]);
  });
});

describe("tallyPoll", () => {
  it("counts one voter per option", () => {
    const tally = tallyPoll(
      poll(),
      responses([
        response(),
        response({
          id: "8".repeat(64),
          pubkey: VOTER_B,
          tags: [
            ["e", POLL_ID],
            ["response", "no"],
          ],
        }),
      ]),
    );
    expect(tally.options).toEqual([
      { optionId: "yes", atLeast: 1 },
      { optionId: "no", atLeast: 1 },
    ]);
    expect(tally.voters).toBe(2);
  });

  it("counts only the newest response per voter", () => {
    // The bug this locks: one pubkey can publish any number of kind-1018s, so a
    // loop over events counts a changed mind twice — once for the option they left
    // and once for the option they moved to.
    const tally = tallyPoll(
      poll(),
      responses([
        response({
          created_at: 1100,
          tags: [
            ["e", POLL_ID],
            ["response", "yes"],
          ],
        }),
        response({
          id: "8".repeat(64),
          created_at: 1200,
          tags: [
            ["e", POLL_ID],
            ["response", "no"],
          ],
        }),
      ]),
    );
    expect(tally.options).toEqual([
      { optionId: "yes", atLeast: 0 },
      { optionId: "no", atLeast: 1 },
    ]);
    expect(tally.voters).toBe(1);
    expect(tally.responses).toBe(2);
    expect(tally.revisedVoters).toBe(1);
  });

  it("breaks a created_at tie deterministically, so a reload agrees with itself", () => {
    const older = response({
      id: "1".repeat(64),
      tags: [
        ["e", POLL_ID],
        ["response", "yes"],
      ],
    });
    const newer = response({
      id: "f".repeat(64),
      tags: [
        ["e", POLL_ID],
        ["response", "no"],
      ],
    });
    const forward = tallyPoll(poll(), responses([older, newer]));
    const reversed = tallyPoll(poll(), responses([newer, older]));
    expect(forward.options).toEqual(reversed.options);
    expect(forward.options).toEqual([
      { optionId: "yes", atLeast: 0 },
      { optionId: "no", atLeast: 1 },
    ]);
  });

  it("counts one option per voter on a single-choice poll", () => {
    // Honouring several would let one voter fill every bar.
    const tally = tallyPoll(
      poll(),
      responses([
        response({
          tags: [
            ["e", POLL_ID],
            ["response", "yes"],
            ["response", "no"],
          ],
        }),
      ]),
    );
    expect(tally.options).toEqual([
      { optionId: "yes", atLeast: 1 },
      { optionId: "no", atLeast: 0 },
    ]);
    expect(tally.voters).toBe(1);
  });

  it("counts every pick on a multiple-choice poll", () => {
    const tally = tallyPoll(
      poll({
        tags: [
          ["option", "yes", "Yes"],
          ["option", "no", "No"],
          ["polltype", "multiplechoice"],
        ],
      }),
      responses([
        response({
          tags: [
            ["e", POLL_ID],
            ["response", "yes"],
            ["response", "no"],
          ],
        }),
      ]),
    );
    expect(tally.options).toEqual([
      { optionId: "yes", atLeast: 1 },
      { optionId: "no", atLeast: 1 },
    ]);
    // One voter, two options: the shares of a multiple-choice poll do not add to
    // 100%, which is why nothing here computes a percentage.
    expect(tally.voters).toBe(1);
  });

  it("drops responses that arrived after the poll closed", () => {
    const tally = tallyPoll(
      poll({
        tags: [
          ["option", "yes"],
          ["endsAt", "1150"],
        ],
      }),
      responses([
        response({ created_at: 1100 }),
        response({ id: "8".repeat(64), pubkey: VOTER_B, created_at: 1200 }),
      ]),
    );
    expect(tally.options).toEqual([{ optionId: "yes", atLeast: 1 }]);
    expect(tally.lateResponses).toBe(1);
  });

  it("ignores option ids the poll never declared", () => {
    const tally = tallyPoll(
      poll(),
      responses([
        response({
          tags: [
            ["e", POLL_ID],
            ["response", "maybe"],
          ],
        }),
      ]),
    );
    expect(tally.options).toEqual([
      { optionId: "yes", atLeast: 0 },
      { optionId: "no", atLeast: 0 },
    ]);
    // Not a voter either: counting it would shrink every option's share for a vote
    // nobody cast.
    expect(tally.voters).toBe(0);
  });

  it("ignores responses aimed at a different poll", () => {
    const tally = tallyPoll(
      poll(),
      responses([
        response({
          tags: [
            ["e", "2".repeat(64)],
            ["response", "yes"],
          ],
        }),
      ]),
    );
    expect(tally.voters).toBe(0);
  });
});

describe("pollHasEnded", () => {
  it("is false for a poll with no declared deadline", () => {
    expect(pollHasEnded(poll(), 9_999_999)).toBe(false);
  });

  it("is true only after the deadline passes", () => {
    const ending = poll({
      tags: [
        ["option", "a"],
        ["endsAt", "2000"],
      ],
    });
    expect(pollHasEnded(ending, 2000)).toBe(false);
    expect(pollHasEnded(ending, 2001)).toBe(true);
  });
});
