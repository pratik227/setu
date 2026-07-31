import { describe, expect, it } from "vitest";
import { Kind } from "./kinds";
import {
  buildAuthEvent,
  CLIENT_AUTH_KIND,
  isAuthEventFor,
  isAuthRequired,
  isRestricted,
  sameRelay,
} from "./nip42";

const RELAY = "wss://relay.example.com";
const CHALLENGE = "abc123";

describe("sameRelay", () => {
  it("ignores a trailing slash and host case", () => {
    // Relays disagree about both. Rejecting a correct proof would make the client
    // re-sign forever against a relay it is genuinely connected to.
    expect(
      sameRelay("wss://Relay.Example.com/", "wss://relay.example.com"),
    ).toBe(true);
    expect(
      sameRelay("wss://relay.example.com//", "wss://relay.example.com"),
    ).toBe(true);
  });

  it("keeps different hosts, paths and schemes apart", () => {
    expect(sameRelay("wss://a.example.com", "wss://b.example.com")).toBe(false);
    expect(
      sameRelay("wss://relay.example.com/one", "wss://relay.example.com/two"),
    ).toBe(false);
    expect(sameRelay("ws://relay.example.com", "wss://relay.example.com")).toBe(
      false,
    );
  });

  it("treats an unparseable url as no match", () => {
    expect(sameRelay("not a url", "not a url")).toBe(false);
  });
});

describe("buildAuthEvent", () => {
  it("names the relay and echoes the challenge", () => {
    const event = buildAuthEvent({ relay: RELAY, challenge: CHALLENGE });
    expect(event.kind).toBe(CLIENT_AUTH_KIND);
    expect(event.kind).toBe(Kind.ClientAuth);
    expect(event.tags).toEqual([
      ["relay", RELAY],
      ["challenge", CHALLENGE],
    ]);
  });
});

describe("isAuthEventFor", () => {
  const event = buildAuthEvent({ relay: RELAY, challenge: CHALLENGE });

  it("accepts a proof for the right relay and challenge", () => {
    expect(isAuthEventFor(event, RELAY, CHALLENGE)).toBe(true);
    expect(isAuthEventFor(event, "wss://Relay.Example.com/", CHALLENGE)).toBe(
      true,
    );
  });

  it("rejects a proof naming a different relay", () => {
    // THE attack: relay A obtains a proof you made for relay B and presents it to
    // B as you. This check is why the pool cannot be tricked into signing one.
    expect(isAuthEventFor(event, "wss://evil.example.com", CHALLENGE)).toBe(
      false,
    );
  });

  it("rejects a different or reused challenge", () => {
    expect(isAuthEventFor(event, RELAY, "other")).toBe(false);
    // Compared byte-for-byte: the challenge is opaque, and normalising it would
    // let a near-miss through.
    expect(isAuthEventFor(event, RELAY, ` ${CHALLENGE}`)).toBe(false);
    expect(isAuthEventFor(event, RELAY, CHALLENGE.toUpperCase())).toBe(false);
  });

  it("rejects the wrong kind", () => {
    expect(
      isAuthEventFor({ ...event, kind: Kind.ShortTextNote }, RELAY, CHALLENGE),
    ).toBe(false);
  });

  it("rejects an event missing either tag", () => {
    expect(
      isAuthEventFor({ ...event, tags: [["relay", RELAY]] }, RELAY, CHALLENGE),
    ).toBe(false);
    expect(
      isAuthEventFor(
        { ...event, tags: [["challenge", CHALLENGE]] },
        RELAY,
        CHALLENGE,
      ),
    ).toBe(false);
    expect(isAuthEventFor({ ...event, tags: [] }, RELAY, CHALLENGE)).toBe(
      false,
    );
  });
});

describe("reason prefixes", () => {
  it("recognises auth-required", () => {
    // Reading this is what turns a query that silently returned nothing into one
    // the client knows to retry after authenticating.
    expect(
      isAuthRequired("auth-required: we only serve registered users"),
    ).toBe(true);
    expect(isAuthRequired("blocked: spam")).toBe(false);
    expect(isAuthRequired(undefined)).toBe(false);
    expect(isAuthRequired(42)).toBe(false);
  });

  it("recognises restricted", () => {
    expect(isRestricted("restricted: not a paid account")).toBe(true);
    expect(isRestricted("auth-required: log in")).toBe(false);
  });
});
