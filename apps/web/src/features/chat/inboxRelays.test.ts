import { type Hex32, Kind, type NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  configuredRelaysConnected,
  inboxReadRelays,
  ownInboxRelays,
} from "./inboxRelays";

const ME = "a".repeat(64) as Hex32;
const ALICE = "b".repeat(64) as Hex32;

const CONFIGURED = ["wss://nos.lol", "wss://purplepag.es"] as const;

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

describe("inboxReadRelays", () => {
  it("reads the account's own inbox relay as well as the configured set", () => {
    // The failure this prevents: a wrap delivered exactly where NIP-17 says to
    // deliver it, to a relay the app never asked, so the recipient is reachable
    // and sees nothing.
    expect(inboxReadRelays(CONFIGURED, ["wss://auth.nostr1.com"])).toEqual([
      "wss://nos.lol",
      "wss://purplepag.es",
      "wss://auth.nostr1.com",
    ]);
  });

  it("asks a relay named by both halves only once", () => {
    // Two REQs to one relay for one filter burns a subscription slot; relays cap
    // those in the low tens and stop answering rather than complaining.
    expect(inboxReadRelays(CONFIGURED, ["wss://Nos.lol/"])).toEqual([
      "wss://nos.lol",
      "wss://purplepag.es",
    ]);
  });

  it("still reads the configured set when there is no inbox list", () => {
    expect(inboxReadRelays(CONFIGURED, [])).toEqual([...CONFIGURED]);
  });
});

describe("ownInboxRelays", () => {
  it("returns undefined until the account's own list has been seen", () => {
    expect(ownInboxRelays([], ME)).toBeUndefined();
    // Someone else's list is not ours, however many arrive.
    expect(
      ownInboxRelays([dmRelayEvent(ALICE, ["wss://alice.example"])], ME),
    ).toBeUndefined();
  });

  it("distinguishes a published empty list from no list at all", () => {
    // "You receive private messages nowhere" is worth telling the user; "we have
    // not finished asking" is not the same claim.
    expect(ownInboxRelays([dmRelayEvent(ME, [])], ME)).toEqual([]);
  });

  it("takes the newest list", () => {
    const events = [
      dmRelayEvent(ME, ["wss://old.example"], 100),
      dmRelayEvent(ME, ["wss://new.example"], 200),
    ];
    expect(ownInboxRelays(events, ME)).toEqual(["wss://new.example"]);
  });

  it("has no answer for a signed-out session", () => {
    expect(
      ownInboxRelays([dmRelayEvent(ME, ["wss://a.example"])], undefined),
    ).toBeUndefined();
  });
});

describe("configuredRelaysConnected", () => {
  const connected = (...urls: readonly string[]) =>
    urls.map((url) => ({ url, status: "connected" }));

  it("is true when every configured relay is connected", () => {
    expect(
      configuredRelaysConnected(connected(...CONFIGURED), CONFIGURED),
    ).toBe(true);
  });

  it("stays true once the pool also holds inbox relays", () => {
    // The regression this replaces a count with: reading the inbox opens sockets
    // outside the configured set, so `connected === configured.length` stops
    // holding and every send is refused as "not every relay answered".
    const health = connected(...CONFIGURED, "wss://auth.nostr1.com");
    expect(configuredRelaysConnected(health, CONFIGURED)).toBe(true);
  });

  it("is false while a configured relay is still connecting", () => {
    const health = [
      { url: "wss://nos.lol", status: "connected" },
      { url: "wss://purplepag.es", status: "connecting" },
    ];
    expect(configuredRelaysConnected(health, CONFIGURED)).toBe(false);
  });

  it("does not count an inbox relay in place of a configured one", () => {
    const health = connected("wss://nos.lol", "wss://auth.nostr1.com");
    expect(configuredRelaysConnected(health, CONFIGURED)).toBe(false);
  });

  it("matches across url spellings, since the pool canonicalises its keys", () => {
    expect(
      configuredRelaysConnected(connected("wss://NOS.lol/"), ["wss://nos.lol"]),
    ).toBe(true);
  });

  it("is false with nothing configured, so absence is never confirmed", () => {
    expect(configuredRelaysConnected(connected("wss://nos.lol"), [])).toBe(
      false,
    );
  });
});
