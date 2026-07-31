import { describe, expect, it } from "vitest";
import { parseRelayInfo, type RelayInfo } from "./relayInfo";
import {
  MIN_SEARCH_QUERY_LENGTH,
  planRelaySearch,
  SEARCH_LIMIT,
  searchFilters,
  searchReach,
} from "./searchRouting";

function info(
  url: string,
  doc: Record<string, unknown> = {},
): [string, RelayInfo] {
  return [url, parseRelayInfo(url, doc)];
}

const SEARCHER = info("wss://a", { supported_nips: [1, 50] });
const PLAIN = info("wss://b", { supported_nips: [1, 45] });
const PAID_SEARCHER = info("wss://c", {
  supported_nips: [50],
  limitation: { payment_required: true },
});
const AUTH_SEARCHER = info("wss://d", {
  supported_nips: [50],
  limitation: { auth_required: true },
});

function infos(...entries: readonly [string, RelayInfo][]) {
  return new Map(entries);
}

describe("planRelaySearch", () => {
  it("keeps only relays that advertise NIP-50", () => {
    const routing = planRelaySearch({
      urls: ["wss://a", "wss://b"],
      infos: infos(SEARCHER, PLAIN),
    });
    expect(routing.usable.map((r) => r.url)).toEqual(["wss://a"]);
    expect(routing.unsupported).toEqual(["wss://b"]);
    expect(routing.silent).toEqual([]);
    expect(routing.pending).toEqual([]);
  });

  it("treats a relay with no document as pending until it is resolved", () => {
    const urls = ["wss://a", "wss://e"];
    const unresolved = planRelaySearch({ urls, infos: infos(SEARCHER) });
    expect(unresolved.pending).toEqual(["wss://e"]);
    expect(unresolved.silent).toEqual([]);

    const resolved = planRelaySearch({
      urls,
      infos: infos(SEARCHER),
      resolved: new Set(["wss://a", "wss://e"]),
    });
    expect(resolved.pending).toEqual([]);
    expect(resolved.silent).toEqual(["wss://e"]);
  });

  it("never asks a relay whose capability is unknown", () => {
    const routing = planRelaySearch({
      urls: ["wss://e"],
      infos: infos(),
      resolved: new Set(["wss://e"]),
    });
    expect(routing.usable).toEqual([]);
    expect(searchFilters({ routing, query: "gardening", kinds: [1] })).toEqual(
      [],
    );
  });

  it("orders ungated relays ahead of gated ones", () => {
    const routing = planRelaySearch({
      urls: ["wss://c", "wss://a", "wss://d"],
      infos: infos(SEARCHER, PAID_SEARCHER, AUTH_SEARCHER),
    });
    expect(routing.usable.map((r) => r.url)).toEqual([
      "wss://a",
      "wss://c",
      "wss://d",
    ]);
    expect(routing.usable.map((r) => r.gate)).toEqual([
      "none",
      "payment-required",
      "auth-required",
    ]);
  });

  it("is deterministic regardless of input order", () => {
    const forward = planRelaySearch({
      urls: ["wss://a", "wss://c"],
      infos: infos(SEARCHER, PAID_SEARCHER),
    });
    const reverse = planRelaySearch({
      urls: ["wss://c", "wss://a"],
      infos: infos(SEARCHER, PAID_SEARCHER),
    });
    expect(forward.usable).toEqual(reverse.usable);
  });

  it("handles an empty relay set", () => {
    const routing = planRelaySearch({ urls: [], infos: infos() });
    expect(routing).toEqual({
      usable: [],
      unsupported: [],
      silent: [],
      pending: [],
    });
  });
});

describe("searchReach", () => {
  it("is ready when an ungated relay can search", () => {
    const routing = planRelaySearch({
      urls: ["wss://a", "wss://c"],
      infos: infos(SEARCHER, PAID_SEARCHER),
    });
    expect(searchReach(routing)).toBe("ready");
  });

  it("is gated when every capable relay wants payment or AUTH first", () => {
    const routing = planRelaySearch({
      urls: ["wss://c", "wss://d"],
      infos: infos(PAID_SEARCHER, AUTH_SEARCHER),
    });
    expect(searchReach(routing)).toBe("gated");
  });

  it("is unknown while a capability fetch is outstanding", () => {
    const routing = planRelaySearch({
      urls: ["wss://b", "wss://e"],
      infos: infos(PLAIN),
    });
    expect(searchReach(routing)).toBe("unknown");
  });

  it("is unavailable only once every relay has answered", () => {
    const routing = planRelaySearch({
      urls: ["wss://b", "wss://e"],
      infos: infos(PLAIN),
      resolved: new Set(["wss://b", "wss://e"]),
    });
    expect(searchReach(routing)).toBe("unavailable");
  });

  it("reports unavailable for an empty relay set rather than unknown", () => {
    expect(searchReach(planRelaySearch({ urls: [], infos: infos() }))).toBe(
      "unavailable",
    );
  });
});

describe("searchFilters", () => {
  const routing = planRelaySearch({
    urls: ["wss://a", "wss://b"],
    infos: infos(SEARCHER, PLAIN),
  });

  it("builds one bounded filter per capable relay", () => {
    expect(
      searchFilters({ routing, query: "gardening", kinds: [0, 1] }),
    ).toEqual([
      {
        relay: "wss://a",
        filter: { kinds: [0, 1], search: "gardening", limit: SEARCH_LIMIT },
      },
    ]);
  });

  it("always carries a limit", () => {
    for (const { filter } of searchFilters({
      routing,
      query: "gardening",
      kinds: [1],
    })) {
      expect(filter.limit).toBeGreaterThan(0);
    }
  });

  it("clamps the limit to what the relay says it will honour", () => {
    const capped = planRelaySearch({
      urls: ["wss://a"],
      infos: infos(
        info("wss://a", {
          supported_nips: [50],
          limitation: { max_limit: 10 },
        }),
      ),
    });
    const [first] = searchFilters({
      routing: capped,
      query: "gardening",
      kinds: [1],
    });
    expect(first?.filter.limit).toBe(10);
  });

  it("trims the query before sending it", () => {
    const [first] = searchFilters({
      routing,
      query: "  gardening  ",
      kinds: [1],
    });
    expect(first?.filter.search).toBe("gardening");
  });

  it("refuses a query shorter than the minimum", () => {
    const short = "x".repeat(MIN_SEARCH_QUERY_LENGTH - 1);
    expect(searchFilters({ routing, query: short, kinds: [1] })).toEqual([]);
    expect(searchFilters({ routing, query: "   ", kinds: [1] })).toEqual([]);
  });

  it("refuses when no kinds are named", () => {
    expect(searchFilters({ routing, query: "gardening", kinds: [] })).toEqual(
      [],
    );
  });

  it("honours an explicit limit", () => {
    const [first] = searchFilters({
      routing,
      query: "gardening",
      kinds: [1],
      limit: 5,
    });
    expect(first?.filter.limit).toBe(5);
  });
});
