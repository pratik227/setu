/**
 * Relay transport behaviour, driven entirely through a fake socket.
 *
 * The test that matters most is "a dropped EOSE surfaces a timeout instead of
 * hanging" — that is the specific failure this pool was written to avoid.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishResult } from "../contracts";
import { FakeSocketFactory, tick } from "../testing/fakeSocket";
import { hex, makeEvent } from "../testing/fixtures";
import { computeBackoffDelay, DEFAULT_BACKOFF } from "./backoff";
import { normalizeRelayUrl } from "./normalize";
import { RelayConnection } from "./relayConnection";
import type { PoolSubscriptionCallbacks } from "./relayPool";
import { WebSocketRelayPool } from "./relayPool";

const RELAY_A = "wss://a.relay";
const RELAY_B = "wss://b.relay";

/** Pools in tests never touch the network for NIP-11 unless a test says so. */
const _noNip11 = async () => undefined;

function makePool(factory: FakeSocketFactory): WebSocketRelayPool {
  return new WebSocketRelayPool({
    createSocket: factory.create,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeRelayUrl", () => {
  it("collapses case and trailing-slash variants onto one key", () => {
    expect(normalizeRelayUrl("wss://Relay.Example/")).toBe(
      "wss://relay.example",
    );
    expect(normalizeRelayUrl("relay.example")).toBe("wss://relay.example");
    expect(normalizeRelayUrl("wss://relay.example/nostr/")).toBe(
      "wss://relay.example/nostr",
    );
    expect(normalizeRelayUrl("  wss://relay.example?x=1 ")).toBe(
      "wss://relay.example",
    );
  });
});

describe("computeBackoffDelay", () => {
  it("follows an exponential schedule capped at maxMs", () => {
    const mid = { random: () => 0.5 };
    const schedule = [0, 1, 2, 3, 4, 5, 6, 20].map((attempt) =>
      computeBackoffDelay(attempt, mid),
    );
    expect(schedule).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("jitters within +/- jitterRatio and never exceeds the cap", () => {
    for (const random of [() => 0, () => 0.25, () => 0.999]) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const delay = computeBackoffDelay(attempt, { random });
        const raw = Math.min(
          DEFAULT_BACKOFF.maxMs,
          DEFAULT_BACKOFF.baseMs * 2 ** attempt,
        );
        expect(delay).toBeGreaterThanOrEqual(
          Math.floor(raw * (1 - DEFAULT_BACKOFF.jitterRatio)),
        );
        expect(delay).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
      }
    }
  });
});

describe("RelayConnection reconnection", () => {
  it("backs off exponentially and resets the schedule on a successful open", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory({ autoOpen: false });
    const connection = new RelayConnection({
      url: RELAY_A,
      createSocket: factory.create,
      backoff: { random: () => 0.5 },
      handlers: {
        onMessage: () => undefined,
        onOpen: () => undefined,
        onDisconnect: () => undefined,
      },
    });

    connection.ensureOpen();
    factory.last(RELAY_A).simulateClose();
    expect(connection.lastBackoffDelay).toBe(1_000);

    vi.advanceTimersByTime(1_000);
    factory.last(RELAY_A).simulateClose();
    expect(connection.lastBackoffDelay).toBe(2_000);

    vi.advanceTimersByTime(2_000);
    factory.last(RELAY_A).simulateClose();
    expect(connection.lastBackoffDelay).toBe(4_000);
    expect(connection.failureCount).toBe(3);
    expect(connection.status).toBe("failed");

    // A successful open must reset both the schedule and the failure count.
    vi.advanceTimersByTime(4_000);
    factory.last(RELAY_A).simulateOpen();
    expect(connection.status).toBe("connected");
    expect(connection.failureCount).toBe(0);

    factory.last(RELAY_A).simulateClose();
    expect(connection.lastBackoffDelay).toBe(1_000);
    connection.close();
  });
});

describe("WebSocketRelayPool", () => {
  it("opens one socket per normalised relay and issues one REQ per relay", async () => {
    const factory = new FakeSocketFactory();
    const pool = makePool(factory);

    pool.subscribe(
      [
        { relay: "wss://A.Relay/", filter: { kinds: [1] } },
        { relay: RELAY_A, filter: { kinds: [7] } },
        { relay: RELAY_B, filter: { kinds: [1] } },
      ],
      {},
    );
    await tick(3);

    expect(factory.sockets).toHaveLength(2);
    const reqs = factory.last(RELAY_A).framesOfType("REQ");
    expect(reqs).toHaveLength(1);
    // Both filters for that relay travel in the single REQ.
    expect(reqs[0]?.slice(2)).toEqual([{ kinds: [1] }, { kinds: [7] }]);
    pool.close();
  });

  it("delivers EVENT/EOSE per relay and completes when all have EOSE'd", async () => {
    const factory = new FakeSocketFactory();
    const pool = makePool(factory);
    const events: { id: string; relay: string }[] = [];
    const eosed: string[] = [];
    let completed = 0;

    const handle = pool.subscribe(
      [
        { relay: RELAY_A, filter: { kinds: [1] } },
        { relay: RELAY_B, filter: { kinds: [1] } },
      ],
      {
        onEvent: (event, relay) => events.push({ id: event.id, relay }),
        onEose: (relay) => eosed.push(relay),
        onComplete: () => {
          completed += 1;
        },
      },
    );
    await tick(3);

    const subId = handle.id;
    const note = makeEvent({ id: hex("pool-1") });
    factory.last(RELAY_A).simulateMessage(["EVENT", subId, note]);
    // Junk must not reach the caller.
    factory.last(RELAY_A).simulateMessage(["EVENT", subId, { id: "nope" }]);
    factory.last(RELAY_A).simulateMessage(["EOSE", subId]);
    expect(completed).toBe(0);
    factory.last(RELAY_B).simulateMessage(["EOSE", subId]);

    expect(events).toEqual([{ id: note.id, relay: RELAY_A }]);
    expect(eosed).toEqual([RELAY_A, RELAY_B]);
    expect(completed).toBe(1);

    handle.close();
    expect(factory.last(RELAY_A).framesOfType("CLOSE")[0]).toEqual([
      "CLOSE",
      subId,
    ]);
    pool.close();
  });

  it("surfaces a timeout instead of hanging when a relay never sends EOSE", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory();
    const pool = new WebSocketRelayPool({
      createSocket: factory.create,
      subscriptionTimeoutMs: 5_000,
    });
    const failures: { relay: string; reason: string }[] = [];
    let timedOut: readonly string[] | undefined;
    let completed = 0;

    const handle = pool.subscribe(
      [
        { relay: RELAY_A, filter: { kinds: [1] } },
        { relay: RELAY_B, filter: { kinds: [1] } },
      ],
      {
        onFailed: (relay, reason) => failures.push({ relay, reason }),
        onTimeout: (relays) => {
          timedOut = relays;
        },
        onComplete: () => {
          completed += 1;
        },
      } satisfies PoolSubscriptionCallbacks,
    );
    await vi.advanceTimersByTimeAsync(0);
    factory.last(RELAY_A).simulateMessage(["EOSE", handle.id]);

    // B never answers. Without a timeout the caller would wait forever.
    expect(completed).toBe(0);
    vi.advanceTimersByTime(5_000);

    expect(timedOut).toEqual([RELAY_B]);
    expect(failures).toEqual([
      { relay: RELAY_B, reason: "timed out waiting for EOSE" },
    ]);
    expect(completed).toBe(1);
    pool.close();
  });

  it("completes immediately when every requested relay is filtered out", async () => {
    const factory = new FakeSocketFactory();
    const pool = makePool(factory);
    pool.block(RELAY_A);
    let completed = 0;
    const failures: string[] = [];

    pool.subscribe([{ relay: RELAY_A, filter: { kinds: [1] } }], {
      onComplete: () => {
        completed += 1;
      },
      onFailed: (relay) => failures.push(relay),
    } satisfies PoolSubscriptionCallbacks);
    await tick(3);

    expect(completed).toBe(1);
    expect(failures).toEqual([RELAY_A]);
    expect(factory.sockets).toHaveLength(0);
    pool.close();
  });

  it("sends neither REQ nor EVENT to a blocked relay", async () => {
    const factory = new FakeSocketFactory();
    const pool = makePool(factory);

    // Connect first, then block: enforcement must not be a connect-time-only check.
    pool.subscribe([{ relay: RELAY_A, filter: { kinds: [1] } }], {});
    await tick(3);
    expect(factory.countFor(RELAY_A)).toBe(1);
    const before = factory.last(RELAY_A).sent.length;

    pool.block(RELAY_A);
    pool.subscribe([{ relay: RELAY_A, filter: { kinds: [7] } }], {});
    const results = await pool.publish(makeEvent({ id: hex("blk") }), [
      "wss://A.Relay/",
    ]);
    await tick(3);

    expect(factory.countFor(RELAY_A)).toBe(1);
    expect(factory.last(RELAY_A).sent.length).toBe(before);
    expect(results).toEqual<PublishResult[]>([
      { relay: RELAY_A, ok: false, message: "relay is blocked" },
    ]);
    pool.close();
  });

  it("resolves publish per relay, preserving the rejection message verbatim", async () => {
    const factory = new FakeSocketFactory();
    const pool = makePool(factory);
    const event = makeEvent({ id: hex("pub") });

    const promise = pool.publish(event, [RELAY_A, RELAY_B, "wss://A.Relay"]);
    await tick(3);

    expect(factory.sockets).toHaveLength(2);
    expect(factory.last(RELAY_A).framesOfType("EVENT")[0]).toEqual([
      "EVENT",
      event,
    ]);
    factory.last(RELAY_A).simulateMessage(["OK", event.id, true, ""]);
    factory
      .last(RELAY_B)
      .simulateMessage(["OK", event.id, false, "blocked: pubkey not allowed"]);

    const results = await promise;
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining<PublishResult>([
        { relay: RELAY_A, ok: true },
        {
          relay: RELAY_B,
          ok: false,
          message: "blocked: pubkey not allowed",
        },
      ]),
    );
    pool.close();
  });

  it("fails a publish on timeout rather than leaking the promise", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory();
    const pool = new WebSocketRelayPool({
      createSocket: factory.create,
      publishTimeoutMs: 3_000,
    });
    const promise = pool.publish(makeEvent({ id: hex("slow") }), [RELAY_A]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await promise).toEqual<PublishResult[]>([
      { relay: RELAY_A, ok: false, message: "timed out waiting for OK" },
    ]);
    pool.close();
  });

  it("fails a pending publish as soon as the socket drops", async () => {
    const factory = new FakeSocketFactory();
    const pool = makePool(factory);
    const promise = pool.publish(makeEvent({ id: hex("drop") }), [RELAY_A]);
    await tick(3);
    factory.last(RELAY_A).simulateClose();

    const [result] = await promise;
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("disconnected before OK");
    pool.close();
  });

  it("marks a relay refusing after repeated CLOSEDs and stops sending it REQs", async () => {
    const factory = new FakeSocketFactory();
    const pool = new WebSocketRelayPool({
      createSocket: factory.create,
      refusalThreshold: 2,
    });

    for (let i = 0; i < 2; i += 1) {
      const handle = pool.subscribe(
        [{ relay: RELAY_A, filter: { kinds: [1] } }],
        {},
      );
      await tick(3);
      factory
        .last(RELAY_A)
        .simulateMessage(["CLOSED", handle.id, "error: too many filters"]);
    }
    expect(pool.health().find((h) => h.url === RELAY_A)?.refusing).toBe(true);

    const reqsBefore = factory.last(RELAY_A).framesOfType("REQ").length;
    const failures: string[] = [];
    pool.subscribe([{ relay: RELAY_A, filter: { kinds: [1] } }], {
      onFailed: (relay) => failures.push(relay),
    } satisfies PoolSubscriptionCallbacks);
    await tick(3);

    expect(factory.last(RELAY_A).framesOfType("REQ")).toHaveLength(reqsBefore);
    expect(failures).toEqual([RELAY_A]);
    pool.close();
  });

  it("reports CLOSED and NOTICE to the caller", async () => {
    const factory = new FakeSocketFactory();
    const notices: { relay: string; message: string }[] = [];
    const pool = new WebSocketRelayPool({
      createSocket: factory.create,
      onNotice: (relay, message) => notices.push({ relay, message }),
    });
    const closed: { relay: string; reason: string }[] = [];
    const handle = pool.subscribe(
      [{ relay: RELAY_A, filter: { kinds: [1] } }],
      { onClosed: (relay, reason) => closed.push({ relay, reason }) },
    );
    await tick(3);

    factory.last(RELAY_A).simulateMessage(["NOTICE", "rate limited"]);
    factory
      .last(RELAY_A)
      .simulateMessage(["CLOSED", handle.id, "auth-required"]);

    expect(notices).toEqual([{ relay: RELAY_A, message: "rate limited" }]);
    expect(closed).toEqual([{ relay: RELAY_A, reason: "auth-required" }]);
    pool.close();
  });

  it("re-issues pending REQs after a reconnect", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory();
    const pool = new WebSocketRelayPool({
      createSocket: factory.create,
      backoff: { baseMs: 10, random: () => 0.5 },
    });
    const handle = pool.subscribe(
      [{ relay: RELAY_A, filter: { kinds: [1] } }],
      {},
    );
    await vi.advanceTimersByTimeAsync(0);
    factory.last(RELAY_A).simulateClose();
    await vi.advanceTimersByTimeAsync(20);

    expect(factory.countFor(RELAY_A)).toBe(2);
    expect(factory.last(RELAY_A).framesOfType("REQ")[0]).toEqual([
      "REQ",
      handle.id,
      { kinds: [1] },
    ]);
    pool.close();
  });

  it("applies relay limits pushed in from the NIP-11 cache", async () => {
    // The pool no longer fetches NIP-11 itself — `RelayInfoCache` owns that, and
    // having both fetch meant two requests per relay and two caches that could
    // disagree. What still matters is that the numbers reach the connection.
    const factory = new FakeSocketFactory();
    const pool = new WebSocketRelayPool({ createSocket: factory.create });

    await pool.connect([RELAY_A, RELAY_B]);
    await tick(5);
    pool.setRelayLimits(RELAY_A, { maxSubscriptions: 20, maxFilters: 10 });

    const health = pool.health();
    const a = health.find((h) => h.url === RELAY_A);
    const b = health.find((h) => h.url === RELAY_B);
    expect(a?.maxSubscriptions).toBe(20);
    expect(a?.maxFilters).toBe(10);
    // A relay we know nothing about still connects and works.
    expect(b?.status).toBe("connected");
    expect(b?.maxSubscriptions).toBeUndefined();
    pool.close();
  });

  it("connect() resolves even when a relay cannot be opened at all", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory({ throwFor: [RELAY_A] });
    const pool = new WebSocketRelayPool({
      createSocket: factory.create,
      connectTimeoutMs: 1_000,
      backoff: { baseMs: 50_000, random: () => 0.5 },
    });
    const connected = pool.connect([RELAY_A]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(connected).resolves.toBeUndefined();
    const health = pool.health().find((h) => h.url === RELAY_A);
    expect(health?.failureCount).toBeGreaterThan(0);
    pool.close();
  });
});
