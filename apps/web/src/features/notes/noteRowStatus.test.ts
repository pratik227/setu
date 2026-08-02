import { describe, expect, it } from "vitest";
import { type NoteRowStatusSources, noteRowStatuses } from "./noteRowStatus";

const NOTE = "1".repeat(64);
const OTHER = "2".repeat(64);

const sources = (
  over: Partial<NoteRowStatusSources> = {},
): NoteRowStatusSources => ({
  shareBusy: new Set(),
  actions: new Map(),
  notices: new Map(),
  zaps: new Map(),
  bookmark: { status: "idle" },
  ...over,
});

describe("noteRowStatuses", () => {
  it("holds no entry for a row with nothing happening", () => {
    // The property the feed's row memoisation rests on: an idle row is handed the
    // same `undefined` every render, so its props never change.
    expect(noteRowStatuses(sources()).size).toBe(0);
  });

  it("leaves every other row absent while one row acts", () => {
    const statuses = noteRowStatuses(sources({ shareBusy: new Set([NOTE]) }));
    expect(statuses.get(NOTE)?.pending).toBe("share");
    expect(statuses.has(OTHER)).toBe(false);
  });

  it("spins the control the action belongs to, undo included", () => {
    const slot = (action: "react" | "unreact" | "repost" | "unrepost") =>
      noteRowStatuses(
        sources({
          actions: new Map([[NOTE, { status: "working", action }]]),
        }),
      ).get(NOTE)?.pending;
    expect(slot("react")).toBe("react");
    expect(slot("unreact")).toBe("react");
    expect(slot("repost")).toBe("repost");
    expect(slot("unrepost")).toBe("repost");
  });

  it("names one pending control when two subsystems are working", () => {
    // Two spinners on one row would say two different things are happening to the
    // same note.
    const statuses = noteRowStatuses(
      sources({
        shareBusy: new Set([NOTE]),
        actions: new Map([[NOTE, { status: "working", action: "react" }]]),
        zaps: new Map([[NOTE, { status: "working", step: "resolving" }]]),
      }),
    );
    expect(statuses.get(NOTE)?.pending).toBe("share");
  });

  it("attributes a bookmark write only to the note it was about", () => {
    // The list is one document, so without the target check every row on screen
    // would claim to be bookmarking.
    const statuses = noteRowStatuses(
      sources({ bookmark: { status: "working", target: NOTE } }),
    );
    expect(statuses.get(NOTE)?.pending).toBe("bookmark");
    expect(statuses.has(OTHER)).toBe(false);
  });

  it("reports a bookmark failure on its own row, with its message", () => {
    const statuses = noteRowStatuses(
      sources({
        bookmark: { status: "error", target: NOTE, message: "no relay" },
      }),
    );
    expect(statuses.get(NOTE)?.error).toBe("no relay");
    expect(statuses.has(OTHER)).toBe(false);
  });

  it("carries a local notice through", () => {
    const statuses = noteRowStatuses(
      sources({ notices: new Map([[NOTE, "Link copied"]]) }),
    );
    expect(statuses.get(NOTE)?.notice).toBe("Link copied");
  });

  it("shows a handed-off invoice rather than the row's local notice", () => {
    // The invoice is the only copy the reader has, and it has to be paid by hand.
    // "Link copied" replacing it would lose it.
    const statuses = noteRowStatuses(
      sources({
        notices: new Map([[NOTE, "Link copied"]]),
        zaps: new Map([
          [NOTE, { status: "handed-off", invoice: "lnbc1", message: "Paid?" }],
        ]),
      }),
    );
    expect(statuses.get(NOTE)?.notice).toBe("Paid? lnbc1");
  });

  it("omits the invoice from the notice when the service gave none", () => {
    const statuses = noteRowStatuses(
      sources({
        zaps: new Map([[NOTE, { status: "handed-off", message: "Opened it" }]]),
      }),
    );
    expect(statuses.get(NOTE)?.notice).toBe("Opened it");
  });

  it("shows one error when several subsystems failed on one row", () => {
    const statuses = noteRowStatuses(
      sources({
        actions: new Map([
          [NOTE, { status: "error", action: "react", message: "declined" }],
        ]),
        zaps: new Map([[NOTE, { status: "error", message: "no lnurl" }]]),
        bookmark: { status: "error", target: NOTE, message: "no relay" },
      }),
    );
    expect(statuses.get(NOTE)?.error).toBe("declined");
  });

  it("keeps rows apart when several are busy at once", () => {
    const statuses = noteRowStatuses(
      sources({
        shareBusy: new Set([NOTE]),
        zaps: new Map([[OTHER, { status: "working", step: "signing" }]]),
      }),
    );
    expect(statuses.get(NOTE)?.pending).toBe("share");
    expect(statuses.get(OTHER)?.pending).toBe("zap");
  });
});

describe("mining attribution", () => {
  const MINING = {
    targetBits: 20,
    hashes: 1_400_000,
    elapsedMs: 6_000,
    budgetMs: 21_000,
  } as const;

  it("attaches mining to the row that is acting", () => {
    // The gap this closes: at difficulty 20 a like hashes for ~10s behind the
    // ordinary spinner, which reads as a relay that stopped answering.
    const statuses = noteRowStatuses(
      sources({
        actions: new Map([[NOTE, { status: "working", action: "react" }]]),
        mining: MINING,
        onSkipMining: () => {},
      }),
    );
    expect(statuses.get(NOTE)?.mining).toEqual(MINING);
    expect(statuses.get(NOTE)?.onSkipMining).toBeTypeOf("function");
  });

  it("never attributes mining to a row that is only showing a notice", () => {
    // One publisher serves every note action, so mining belongs to the row with
    // a pending control. Painting it on a row that merely copied a link would be
    // work attributed to a row that is not doing it.
    const statuses = noteRowStatuses(
      sources({
        notices: new Map([[OTHER, "Link copied"]]),
        mining: MINING,
        onSkipMining: () => {},
      }),
    );
    expect(statuses.get(OTHER)?.notice).toBe("Link copied");
    expect(statuses.get(OTHER)?.mining).toBeUndefined();
  });

  it("omits the skip handler when nothing is mining", () => {
    const statuses = noteRowStatuses(
      sources({
        actions: new Map([[NOTE, { status: "working", action: "react" }]]),
        onSkipMining: () => {},
      }),
    );
    expect(statuses.get(NOTE)?.pending).toBe("react");
    expect(statuses.get(NOTE)?.onSkipMining).toBeUndefined();
  });
});
