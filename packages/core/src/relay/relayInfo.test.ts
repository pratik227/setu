import { describe, expect, it } from "vitest";
import {
  clampLimit,
  DEFAULT_MAX_SUBSCRIPTIONS,
  NIP,
  parseRelayInfo,
  type RelayInfo,
  relayGate,
  relaysFor,
  subscriptionBudget,
  suitability,
  supports,
} from "./relayInfo";

const URL_A = "wss://a.example.com/";
const URL_B = "wss://b.example.com/";
const URL_C = "wss://c.example.com/";

describe("parseRelayInfo", () => {
  it("reads a full document", () => {
    const info = parseRelayInfo(URL_A, {
      name: "Example",
      description: "A relay",
      pubkey: "a".repeat(64),
      contact: "mailto:op@example.com",
      software: "strfry",
      version: "1.0",
      supported_nips: [1, 11, 45, 50],
      limitation: {
        max_limit: 500,
        max_subscriptions: 20,
        max_filters: 10,
        auth_required: false,
        payment_required: true,
        min_pow_difficulty: 8,
      },
      payments_url: "https://example.com/pay",
      language_tags: ["en", "de"],
      tags: ["bitcoin"],
    });

    expect(info.name).toBe("Example");
    expect(info.supportedNips).toEqual([1, 11, 45, 50]);
    expect(info.limitation.maxLimit).toBe(500);
    expect(info.limitation.paymentRequired).toBe(true);
    expect(info.limitation.authRequired).toBe(false);
    expect(info.languageTags).toEqual(["en", "de"]);
  });

  it("survives a document that is not an object", () => {
    // A relay serving HTML at its NIP-11 endpoint is common. It must not throw.
    for (const body of [null, undefined, "not json", 42, []]) {
      const info = parseRelayInfo(URL_A, body);
      expect(info.url).toBe(URL_A);
      expect(info.supportedNips).toEqual([]);
      expect(info.limitation).toEqual({});
    }
  });

  it("drops unusable values rather than defaulting them", () => {
    // "Did not say" and "said zero" lead to opposite decisions: the first means use
    // our own bound, the second would mean ask for nothing.
    const info = parseRelayInfo(URL_A, {
      limitation: {
        max_limit: "lots",
        max_subscriptions: -5,
        auth_required: "yes",
      },
      supported_nips: null,
      name: "",
    });
    expect(info.limitation.maxLimit).toBeUndefined();
    expect(info.limitation.maxSubscriptions).toBeUndefined();
    expect(info.limitation.authRequired).toBeUndefined();
    expect(info.supportedNips).toEqual([]);
    expect("name" in info).toBe(false);
  });

  it("keeps a genuine zero for max_limit distinct from absent", () => {
    const zero = parseRelayInfo(URL_A, { limitation: { max_limit: 0 } });
    expect(zero.limitation.maxLimit).toBe(0);
  });

  it("ignores non-numeric entries in supported_nips and sorts the rest", () => {
    const info = parseRelayInfo(URL_A, {
      supported_nips: [50, "42", 1, null, 11, 1],
    });
    expect(info.supportedNips).toEqual([1, 11, 50]);
  });
});

describe("supports", () => {
  const info = parseRelayInfo(URL_A, { supported_nips: [1, 45] });

  it("answers from the advertised list", () => {
    expect(supports(info, NIP.Count)).toBe(true);
    expect(supports(info, NIP.Search)).toBe(false);
  });

  it("claims nothing for an unknown relay", () => {
    // A relay we have no document for has made no claims. Assuming support would
    // send it queries it cannot answer.
    expect(supports(undefined, NIP.Count)).toBe(false);
  });
});

describe("clampLimit", () => {
  it("caps a request to the relay's ceiling", () => {
    // Not tidiness: a relay caps silently, so an uncapped request returns a
    // truncated set that looks complete, and pagination can never trust it.
    const info = parseRelayInfo(URL_A, { limitation: { max_limit: 100 } });
    expect(clampLimit(500, info)).toBe(100);
    expect(clampLimit(50, info)).toBe(50);
  });

  it("leaves the request alone when the relay names no ceiling", () => {
    expect(clampLimit(500, undefined)).toBe(500);
    expect(clampLimit(500, parseRelayInfo(URL_A, {}))).toBe(500);
  });

  it("ignores a nonsensical ceiling of zero", () => {
    // Honouring it literally would mean asking for no events at all.
    const info = parseRelayInfo(URL_A, { limitation: { max_limit: 0 } });
    expect(clampLimit(40, info)).toBe(40);
  });
});

describe("subscriptionBudget", () => {
  it("leaves one subscription of headroom below the stated maximum", () => {
    // Going over is not an error — the relay drops the connection or ignores the
    // REQ, and the screen it belonged to simply never loads.
    const info = parseRelayInfo(URL_A, {
      limitation: { max_subscriptions: 8 },
    });
    expect(subscriptionBudget(info)).toBe(7);
  });

  it("never returns less than one", () => {
    const info = parseRelayInfo(URL_A, {
      limitation: { max_subscriptions: 1 },
    });
    expect(subscriptionBudget(info)).toBe(1);
  });

  it("applies our own ceiling when the relay is generous", () => {
    const info = parseRelayInfo(URL_A, {
      limitation: { max_subscriptions: 500 },
    });
    expect(subscriptionBudget(info)).toBe(DEFAULT_MAX_SUBSCRIPTIONS);
  });

  it("falls back to our own ceiling when the relay says nothing", () => {
    expect(subscriptionBudget(undefined)).toBe(DEFAULT_MAX_SUBSCRIPTIONS);
  });
});

describe("relayGate", () => {
  it("reports auth and payment gates", () => {
    // This is the most misleading state a client can show: the relay is reachable
    // and returns nothing, so the network looks dead when one door is just shut.
    expect(
      relayGate(parseRelayInfo(URL_A, { limitation: { auth_required: true } })),
    ).toBe("auth-required");
    expect(
      relayGate(
        parseRelayInfo(URL_A, { limitation: { payment_required: true } }),
      ),
    ).toBe("payment-required");
  });

  it("prefers auth when a relay states both", () => {
    // AUTH is the nearer obstacle: you cannot pay your way past a challenge you
    // have not answered.
    const info = parseRelayInfo(URL_A, {
      limitation: { auth_required: true, payment_required: true },
    });
    expect(relayGate(info)).toBe("auth-required");
  });

  it("reports no gate for an open or unknown relay", () => {
    expect(relayGate(parseRelayInfo(URL_A, {}))).toBe("none");
    expect(relayGate(undefined)).toBe("none");
  });
});

describe("suitability", () => {
  it("derives capabilities from the advertised NIPs", () => {
    const info = parseRelayInfo(URL_A, { supported_nips: [45, 50, 17] });
    expect(suitability(info)).toEqual({
      counts: true,
      search: true,
      privateMessages: true,
      openToRead: true,
    });
  });

  it("accepts NIP-59 alone as evidence a relay can carry private messages", () => {
    const info = parseRelayInfo(URL_A, { supported_nips: [59] });
    expect(suitability(info).privateMessages).toBe(true);
  });

  it("marks a gated relay as not open to read", () => {
    const info = parseRelayInfo(URL_A, {
      limitation: { payment_required: true },
    });
    expect(suitability(info).openToRead).toBe(false);
  });
});

describe("relaysFor", () => {
  const infos = new Map<string, RelayInfo>([
    [URL_A, parseRelayInfo(URL_A, { supported_nips: [45] })],
    [URL_B, parseRelayInfo(URL_B, { supported_nips: [1] })],
  ]);

  it("puts capable relays first and drops known-incapable ones", () => {
    expect(relaysFor("counts", [URL_B, URL_A], infos)).toEqual([URL_A]);
  });

  it("keeps relays we know nothing about", () => {
    // A missing NIP-11 document is common — plenty of working relays serve none —
    // so treating silence as refusal would shrink the usable set to the chatty ones.
    expect(relaysFor("counts", [URL_A, URL_B, URL_C], infos)).toEqual([
      URL_A,
      URL_C,
    ]);
  });

  it("returns nothing when every relay is known to be incapable", () => {
    // An empty list is the honest answer, and lets the caller say "no relay here
    // can answer that" instead of asking one that will silently ignore it.
    expect(relaysFor("counts", [URL_B], infos)).toEqual([]);
  });
});
