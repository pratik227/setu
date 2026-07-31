/**
 * Who is allowed to learn the reader's pubkey.
 *
 * These assertions are privacy assertions, not plumbing ones: every `false` here
 * is a relay that must never receive a signed AUTH event, and the `true` for an
 * inbox relay is the difference between an account being reachable by private
 * message and an account that can also read one.
 */

import { describe, expect, it } from "vitest";
import { isChosenRelay } from "./engine";

const CONFIGURED = ["wss://nos.lol", "wss://purplepag.es"] as const;

describe("isChosenRelay", () => {
  it("recognises a configured relay across url spellings", () => {
    expect(isChosenRelay({ relays: CONFIGURED }, "wss://nos.lol")).toBe(true);
    expect(isChosenRelay({ relays: CONFIGURED }, "wss://NOS.lol/")).toBe(true);
  });

  it("refuses a relay reached incidentally, which is the default", () => {
    // The outbox router routes reads to authors' own write relays, so the pool
    // connects to relays the account never chose. Answering their challenges
    // would hand each of them a pubkey it had no other way to learn.
    expect(isChosenRelay({ relays: CONFIGURED }, "wss://stranger.relay")).toBe(
      false,
    );
  });

  it("accepts a relay the app nominated, such as the account's own DM inbox", () => {
    const inbox = ["wss://auth.nostr1.com"];
    const options = {
      relays: CONFIGURED,
      alsoAuthenticate: (relay: string) => inbox.includes(relay),
    };
    expect(isChosenRelay(options, "wss://auth.nostr1.com")).toBe(true);
    expect(isChosenRelay(options, "wss://stranger.relay")).toBe(false);
  });

  it("widens as the nomination list grows, without a rebuild", () => {
    // The list arrives after the engine exists: a kind-10050 is fetched, not
    // configured. An allowance snapshotted at construction would leave the relay
    // holding this account's private mail permanently anonymous.
    const inbox = new Set<string>();
    const options = {
      relays: CONFIGURED,
      alsoAuthenticate: (relay: string) => inbox.has(relay),
    };
    expect(isChosenRelay(options, "wss://inbox.example")).toBe(false);
    inbox.add("wss://inbox.example");
    expect(isChosenRelay(options, "wss://inbox.example")).toBe(true);
  });
});
