import { type Hex32, Kind, type NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  newestDmRelayLists,
  planDmDelivery,
  undeliverableMessage,
} from "./dmDelivery";

const ME = "a".repeat(64) as Hex32;
const ALICE = "b".repeat(64) as Hex32;
const BOB = "c".repeat(64) as Hex32;

function dmRelayEvent(
  pubkey: Hex32,
  relays: readonly string[],
  createdAt = 1000,
): NostrEvent {
  return {
    id: `${pubkey.slice(0, 8)}-${createdAt}`,
    pubkey,
    kind: Kind.DirectMessageRelays,
    created_at: createdAt,
    content: "",
    tags: relays.map((relay) => ["relay", relay]),
    sig: "0".repeat(128),
  };
}

describe("newestDmRelayLists", () => {
  it("keeps the newest list per author", () => {
    // Copies arrive from several relays in socket order, so the map must decide
    // rather than inherit that order: routing by the stale copy delivers to an
    // inbox the recipient left, and the relay accepts it without complaint.
    const lists = newestDmRelayLists([
      dmRelayEvent(ALICE, ["wss://old.example"], 100),
      dmRelayEvent(ALICE, ["wss://new.example"], 200),
      dmRelayEvent(ALICE, ["wss://older.example"], 50),
    ]);
    expect(lists.get(ALICE)).toEqual(["wss://new.example"]);
  });

  it("ignores events that are not kind 10050", () => {
    const note = { ...dmRelayEvent(ALICE, ["wss://a.example"]), kind: 1 };
    expect(newestDmRelayLists([note]).size).toBe(0);
  });

  it("records a list that names no relay as present but empty", () => {
    // A published-but-empty inbox is a confirmed absence, not a pending one.
    const lists = newestDmRelayLists([dmRelayEvent(ALICE, [])]);
    expect(lists.has(ALICE)).toBe(true);
    expect(lists.get(ALICE)).toEqual([]);
  });
});

describe("planDmDelivery", () => {
  it("routes every target when all inboxes are known", () => {
    const plan = planDmDelivery({
      targets: [ME, ALICE],
      lists: new Map([
        [ME, ["wss://mine.example"]],
        [ALICE, ["wss://hers.example"]],
      ]),
      absenceConfirmed: true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.routes.get(ALICE)).toEqual(["wss://hers.example"]);
  });

  it("does not call a missing list absent until absence is confirmed", () => {
    // The bug this locks: the send path read the local store, which nothing ever
    // filled for a recipient, and reported every recipient as having no inbox.
    const plan = planDmDelivery({
      targets: [ME, ALICE],
      lists: new Map([[ME, ["wss://mine.example"]]]),
      absenceConfirmed: false,
    });
    expect(plan).toEqual({ ok: false, noInbox: [], unconfirmed: [ALICE] });
  });

  it("reports a confirmed absence as no inbox", () => {
    const plan = planDmDelivery({
      targets: [ALICE],
      lists: new Map(),
      absenceConfirmed: true,
    });
    expect(plan).toEqual({ ok: false, noInbox: [ALICE], unconfirmed: [] });
  });

  it("treats an empty published list as no inbox even when unconfirmed", () => {
    // We read their answer; it named nowhere. Nothing more will arrive to change
    // that, so waiting longer would only delay an honest refusal.
    const plan = planDmDelivery({
      targets: [ALICE],
      lists: new Map([[ALICE, []]]),
      absenceConfirmed: false,
    });
    expect(plan).toEqual({ ok: false, noInbox: [ALICE], unconfirmed: [] });
  });

  it("refuses the whole send when one participant of a group is unreachable", () => {
    // A group message delivered to some participants is a conversation whose
    // members disagree about what was said, with nothing on the wire to show it.
    const plan = planDmDelivery({
      targets: [ME, ALICE, BOB],
      lists: new Map([
        [ME, ["wss://mine.example"]],
        [ALICE, ["wss://hers.example"]],
      ]),
      absenceConfirmed: true,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.noInbox).toEqual([BOB]);
  });

  it("deduplicates targets", () => {
    const plan = planDmDelivery({
      targets: [ALICE, ALICE],
      lists: new Map([[ALICE, ["wss://hers.example"]]]),
      absenceConfirmed: true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.routes.size).toBe(1);
  });
});

describe("undeliverableMessage", () => {
  it("blames the network, not the recipient, when nothing was confirmed", () => {
    const message = undeliverableMessage({
      author: ME,
      noInbox: [],
      unconfirmed: [ALICE],
    });
    expect(message).toContain("could not confirm");
    expect(message).not.toContain("has not published");
  });

  it("names the recipient's missing inbox once it is confirmed", () => {
    const message = undeliverableMessage({
      author: ME,
      noInbox: [ALICE],
      unconfirmed: [],
    });
    expect(message).toContain("has not published");
    expect(message).not.toContain("could not confirm");
  });

  it("points at Settings when it is our own inbox that is missing", () => {
    const message = undeliverableMessage({
      author: ME,
      noInbox: [ME],
      unconfirmed: [],
    });
    expect(message).toContain("Settings");
    expect(message).not.toContain("That person");
  });

  it("says both when the recipient and we are both unreachable", () => {
    const message = undeliverableMessage({
      author: ME,
      noInbox: [ME, ALICE],
      unconfirmed: [],
    });
    expect(message).toContain("That person has not published");
    expect(message).toContain("Settings");
  });

  it("keeps the two reasons separate when both apply", () => {
    const message = undeliverableMessage({
      author: ME,
      noInbox: [ALICE],
      unconfirmed: [BOB],
    });
    expect(message).toContain("could not confirm");
    expect(message).toContain("has not published");
  });

  it("never returns an empty string, which would read as success", () => {
    expect(
      undeliverableMessage({ author: ME, noInbox: [], unconfirmed: [] }),
    ).not.toBe("");
  });
});
