/**
 * Outbox routing: reads about an author go to that author's write relays.
 */

import { describe, expect, it } from "vitest";
import { microtaskScheduler } from "../internal/scheduler";
import { MemoryEventStore } from "../store/memoryStore";
import { hex, makeEvent, PUBKEYS } from "../testing/fixtures";
import { OutboxRouter, parseRelayList } from "./outboxRouter";

const FALLBACK = ["wss://fallback.one", "wss://fallback.two"];

function relayList(options: {
  readonly pubkey: string;
  readonly tags: readonly (readonly string[])[];
  readonly createdAt?: number;
  readonly id?: string;
}) {
  return makeEvent({
    id: options.id ?? hex(`rl-${options.pubkey.slice(0, 4)}`),
    pubkey: options.pubkey,
    kind: 10002,
    created_at: options.createdAt ?? 1_000,
    tags: options.tags,
  });
}

async function setup(
  events: readonly ReturnType<typeof makeEvent>[],
  config: Partial<{
    maxRelaysPerAuthor: number;
    maxRelaysPerQuery: number;
  }> = {},
) {
  const store = new MemoryEventStore({ scheduler: microtaskScheduler });
  await store.putAll(events);
  const router = new OutboxRouter({
    store,
    fallbackRelays: FALLBACK,
    ...config,
  });
  return { store, router };
}

describe("parseRelayList", () => {
  it("treats a bare r tag as read+write and honours markers", () => {
    const parsed = parseRelayList(
      relayList({
        pubkey: PUBKEYS.alice,
        tags: [
          ["r", "wss://Both.Relay/"],
          ["r", "wss://write.relay", "write"],
          ["r", "wss://read.relay", "read"],
          ["r", "wss://both.relay"],
          ["p", "not-a-relay"],
        ],
      }),
    );
    expect(parsed).toEqual([
      { url: "wss://both.relay", read: true, write: true },
      { url: "wss://write.relay", read: false, write: true },
      { url: "wss://read.relay", read: true, write: false },
    ]);
  });
});

describe("OutboxRouter", () => {
  it("reads an author's events from their advertised write relays", async () => {
    const { router } = await setup([
      relayList({
        pubkey: PUBKEYS.alice,
        tags: [
          ["r", "wss://alice.write", "write"],
          ["r", "wss://alice.inbox", "read"],
        ],
      }),
    ]);
    expect(await router.readRelaysFor(PUBKEYS.alice)).toEqual([
      "wss://alice.write",
    ]);
    // Reaching her is the other direction: her read relays.
    expect(await router.inboxRelaysFor(PUBKEYS.alice)).toEqual([
      "wss://alice.inbox",
    ]);
    expect(await router.writeRelays(PUBKEYS.alice)).toEqual([
      "wss://alice.write",
    ]);
  });

  it("falls back to the configured set for an unknown author", async () => {
    const { router } = await setup([]);
    expect(await router.readRelaysFor(PUBKEYS.carol)).toEqual(FALLBACK);
    const routed = await router.route([PUBKEYS.carol], { kinds: [1] });
    expect(routed).toEqual([
      {
        relay: FALLBACK[0],
        filter: { kinds: [1], authors: [PUBKEYS.carol] },
      },
    ]);
  });

  it("uses the newest relay list, not the first one stored", async () => {
    const { router } = await setup([
      relayList({
        id: hex("old-list"),
        pubkey: PUBKEYS.alice,
        createdAt: 100,
        tags: [["r", "wss://stale.relay"]],
      }),
      relayList({
        id: hex("new-list"),
        pubkey: PUBKEYS.alice,
        createdAt: 200,
        tags: [["r", "wss://current.relay"]],
      }),
    ]);
    expect(await router.readRelaysFor(PUBKEYS.alice)).toEqual([
      "wss://current.relay",
    ]);
  });

  it("collapses authors that share a relay into one filter", async () => {
    const { router } = await setup([
      relayList({
        id: hex("a"),
        pubkey: PUBKEYS.alice,
        tags: [["r", "wss://shared.relay"]],
      }),
      relayList({
        id: hex("b"),
        pubkey: PUBKEYS.bob,
        tags: [["r", "wss://shared.relay"]],
      }),
    ]);
    const routed = await router.route([PUBKEYS.alice, PUBKEYS.bob], {
      kinds: [1],
    });
    expect(routed).toEqual([
      {
        relay: "wss://shared.relay",
        filter: { kinds: [1], authors: [PUBKEYS.alice, PUBKEYS.bob] },
      },
    ]);
  });

  it("caps the relays taken from a single author's list", async () => {
    const { router } = await setup(
      [
        relayList({
          pubkey: PUBKEYS.alice,
          tags: [
            ["r", "wss://one.relay"],
            ["r", "wss://two.relay"],
            ["r", "wss://three.relay"],
            ["r", "wss://four.relay"],
          ],
        }),
      ],
      { maxRelaysPerAuthor: 2 },
    );
    expect(await router.readRelaysFor(PUBKEYS.alice)).toEqual([
      "wss://one.relay",
      "wss://two.relay",
    ]);
  });

  it("caps the total relays in a routing result", async () => {
    const authors = ["a", "b", "c", "d", "e"].map((seed) => hex(seed));
    const events = authors.map((pubkey, index) =>
      relayList({
        id: hex(`list-${index}`),
        pubkey,
        tags: [["r", `wss://relay${index}.example`]],
      }),
    );
    const { router } = await setup(events, { maxRelaysPerQuery: 2 });

    const routed = await router.route(authors, { kinds: [1] });
    expect(routed.length).toBeLessThanOrEqual(2);
    // Each selected relay only carries the authors it actually serves.
    for (const { filter } of routed) {
      expect(filter.authors).toHaveLength(1);
    }
  });

  it("prefers the relay covering the most uncovered authors", async () => {
    const { router } = await setup(
      [
        relayList({
          id: hex("l1"),
          pubkey: PUBKEYS.alice,
          tags: [
            ["r", "wss://big.relay"],
            ["r", "wss://alice.only"],
          ],
        }),
        relayList({
          id: hex("l2"),
          pubkey: PUBKEYS.bob,
          tags: [
            ["r", "wss://big.relay"],
            ["r", "wss://bob.only"],
          ],
        }),
        relayList({
          id: hex("l3"),
          pubkey: PUBKEYS.carol,
          tags: [["r", "wss://carol.only"]],
        }),
      ],
      { maxRelaysPerQuery: 2 },
    );
    const routed = await router.route(
      [PUBKEYS.alice, PUBKEYS.bob, PUBKEYS.carol],
      { kinds: [1] },
    );
    expect(routed[0]?.relay).toBe("wss://big.relay");
    expect(routed[0]?.filter.authors).toEqual([PUBKEYS.alice, PUBKEYS.bob]);
    expect(routed[1]?.relay).toBe("wss://carol.only");
  });

  it("routes to the fallback set when asked for no authors at all", async () => {
    const { router } = await setup([], { maxRelaysPerQuery: 1 });
    const routed = await router.route([], { kinds: [1] });
    expect(routed).toEqual([{ relay: FALLBACK[0], filter: { kinds: [1] } }]);
  });

  it("ignores an author whose list has no write relays", async () => {
    const { router } = await setup([
      relayList({
        pubkey: PUBKEYS.alice,
        tags: [["r", "wss://inbox.only", "read"]],
      }),
    ]);
    expect(await router.readRelaysFor(PUBKEYS.alice)).toEqual(FALLBACK);
  });
});

describe("orderFallback", () => {
  const THREE = [
    "wss://fallback.one",
    "wss://fallback.two",
    "wss://fallback.three",
  ];

  async function routerWith(
    orderFallback: (kinds?: readonly number[]) => readonly string[] | undefined,
  ) {
    const store = new MemoryEventStore({ scheduler: microtaskScheduler });
    return new OutboxRouter({
      store,
      fallbackRelays: THREE,
      maxRelaysPerAuthor: 2,
      orderFallback,
    });
  }

  it("decides which relays the capped fallback reaches", async () => {
    // The case the hook exists for: the specialist sits LAST in the configured
    // list, and slice(0, 2) would never consult it. Ordering fixes which relays
    // are asked at all, not just their sequence.
    const router = await routerWith(() => [THREE[2]!, THREE[0]!, THREE[1]!]);
    const relays = await router.readRelaysFor(PUBKEYS.alice, [0]);
    expect(relays).toEqual([THREE[2], THREE[0]]);
  });

  it("passes the routed kinds to the hook", async () => {
    let seen: readonly number[] | undefined;
    const router = await routerWith((kinds) => {
      seen = kinds;
      return undefined;
    });
    await router.route([PUBKEYS.alice], { kinds: [0, 10002] });
    expect(seen).toEqual([0, 10002]);
  });

  it("ignores a hook that drops or invents a relay", async () => {
    // The hook may reorder, never re-decide membership: a scoring heuristic must
    // not be able to disconnect a relay the user configured.
    for (const bad of [
      () => [THREE[0]!],
      () => [...THREE, "wss://invented.example"],
      () => [THREE[0]!, THREE[1]!, "wss://swapped.example"],
    ]) {
      const router = await routerWith(bad);
      const relays = await router.readRelaysFor(PUBKEYS.alice, [0]);
      expect(relays).toEqual([THREE[0], THREE[1]]);
    }
  });

  it("ignores a throwing hook rather than failing the read", async () => {
    const router = await routerWith(() => {
      throw new Error("scorecard exploded");
    });
    await expect(router.readRelaysFor(PUBKEYS.alice, [0])).resolves.toEqual([
      THREE[0],
      THREE[1],
    ]);
  });

  it("accepts a permutation whatever its URL spelling", async () => {
    const router = await routerWith(() => [
      "wss://Fallback.Three/",
      "wss://fallback.one",
      "wss://fallback.two",
    ]);
    const relays = await router.readRelaysFor(PUBKEYS.alice, [0]);
    expect(relays).toEqual([THREE[2], THREE[0]]);
  });

  it("never consults the hook for an author with a relay list", async () => {
    // Ordering applies to the fallback only. An author who published where they
    // write has answered the question themselves.
    const store = new MemoryEventStore({ scheduler: microtaskScheduler });
    await store.putAll([
      relayList({
        pubkey: PUBKEYS.alice,
        tags: [["r", "wss://alice.example", "write"]],
      }),
    ]);
    let called = 0;
    const router = new OutboxRouter({
      store,
      fallbackRelays: THREE,
      orderFallback: () => {
        called += 1;
        return undefined;
      },
    });
    const relays = await router.readRelaysFor(PUBKEYS.alice, [0]);
    expect(relays).toEqual(["wss://alice.example"]);
    expect(called).toBe(0);
  });
});
