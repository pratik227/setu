import type { PublishResult, RelayPool } from "@setu/core";
import {
  encryptNip04,
  generateSecretKey,
  getPublicKey,
  type Hex32,
  type NostrEvent,
  WALLET_REQUEST_KIND,
  WALLET_RESPONSE_KIND,
} from "@setu/protocol";
import { describe, expect, it, vi } from "vitest";
import { callWallet, walletOutcomeMessage } from "./walletTransport";

const walletSecret = generateSecretKey();
const walletPubkey = getPublicKey(walletSecret) as Hex32;
const connectionSecret = generateSecretKey();
const connectionPubkey = getPublicKey(connectionSecret) as Hex32;
const RELAYS = ["wss://wallet.example"];

/**
 * A pool that plays the wallet's part.
 *
 * `reply` is called with the published request and returns the body the "wallet" sends
 * back, so a test can answer, refuse, stay silent, or answer the wrong request.
 */
function fakePool(options: {
  reply?: (request: NostrEvent) => string | undefined;
  /** Reply content sent verbatim, not encrypted — for the undecryptable case. */
  rawReply?: string;
  /** Override the `e` tag on the reply, to test request matching. */
  replyToId?: string;
  publishResults?: readonly PublishResult[];
}): { pool: RelayPool; published: NostrEvent[]; closed: () => number } {
  const published: NostrEvent[] = [];
  let closes = 0;
  let onEvent: ((event: NostrEvent, relay: string) => void) | undefined;

  const pool = {
    subscribe: (
      _filters: unknown,
      callbacks: { onEvent?: (event: NostrEvent, relay: string) => void },
    ) => {
      onEvent = callbacks.onEvent;
      return {
        id: "sub",
        close: () => {
          closes += 1;
        },
      };
    },
    publish: async (event: NostrEvent) => {
      published.push(event);
      const body = options.rawReply ?? options.reply?.(event);
      if (body !== undefined) {
        const reply: NostrEvent = {
          id: "f".repeat(64),
          pubkey: walletPubkey,
          created_at: event.created_at,
          kind: WALLET_RESPONSE_KIND,
          tags: [
            ["p", connectionPubkey],
            ["e", options.replyToId ?? event.id],
          ],
          content:
            options.rawReply !== undefined
              ? options.rawReply
              : encryptNip04(walletSecret, connectionPubkey, body),
          sig: "0".repeat(128),
        };
        // Delivered on a later tick, the way a socket would.
        setTimeout(() => onEvent?.(reply, RELAYS[0] as string), 0);
      }
      return (
        options.publishResults ?? [{ relay: RELAYS[0] as string, ok: true }]
      );
    },
  } as unknown as RelayPool;

  return { pool, published, closed: () => closes };
}

const base = {
  walletPubkey,
  relays: RELAYS,
  secret: connectionSecret,
} as const;

describe("callWallet", () => {
  it("round-trips a get_balance", async () => {
    const { pool } = fakePool({
      reply: () => '{"result_type":"get_balance","result":{"balance":21000}}',
    });
    const outcome = await callWallet({ ...base, pool, method: "get_balance" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.response.ok).toBe(true);
    expect(outcome.response.ok && outcome.response.result.balance).toBe(21_000);
  });

  it("signs with the connection key, not any account key", async () => {
    // The privacy property of the whole feature: the wallet sees a key that exists
    // only for this pairing, so it never learns which npub is paying.
    const { pool, published } = fakePool({
      reply: () => '{"result_type":"get_balance","result":{"balance":1}}',
    });
    await callWallet({ ...base, pool, method: "get_balance" });

    expect(published[0]?.pubkey).toBe(connectionPubkey);
    expect(published[0]?.kind).toBe(WALLET_REQUEST_KIND);
    expect(published[0]?.tags).toContainEqual(["p", walletPubkey]);
  });

  it("encrypts the request — the method is not on the wire in the clear", async () => {
    const { pool, published } = fakePool({
      reply: () => '{"result_type":"pay_invoice","result":{}}',
    });
    await callWallet({
      ...base,
      pool,
      method: "pay_invoice",
      params: { invoice: "lnbc1secret" },
    });

    expect(published[0]?.content).not.toContain("pay_invoice");
    expect(published[0]?.content).not.toContain("lnbc1secret");
  });

  it("gives the request an expiration so it cannot be replayed later", async () => {
    const { pool, published } = fakePool({
      reply: () => '{"result_type":"get_balance","result":{"balance":1}}',
    });
    await callWallet({ ...base, pool, method: "get_balance" });

    const expiration = published[0]?.tags.find(
      (tag) => tag[0] === "expiration",
    );
    expect(expiration).toBeDefined();
    expect(Number(expiration?.[1])).toBeGreaterThan(
      published[0]?.created_at ?? 0,
    );
  });

  it("surfaces a wallet error as a refusal, not a success", async () => {
    const { pool } = fakePool({
      reply: () =>
        '{"error":{"code":"INSUFFICIENT_BALANCE","message":"not enough"}}',
    });
    const outcome = await callWallet({ ...base, pool, method: "pay_invoice" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.response.ok).toBe(false);
    expect(!outcome.response.ok && outcome.response.code).toBe(
      "INSUFFICIENT_BALANCE",
    );
  });

  it("times out when the wallet says nothing", async () => {
    vi.useFakeTimers();
    try {
      const { pool } = fakePool({});
      const pending = callWallet({
        ...base,
        pool,
        method: "get_balance",
        timeoutMs: 1000,
      });
      // Let the signing microtasks settle before the clock jumps.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a total publish failure as failed, which is conclusive", async () => {
    // No relay took the request, so the wallet cannot have seen it — there is no
    // ambiguity to preserve here and the user can be told plainly.
    const { pool } = fakePool({
      publishResults: [
        { relay: RELAYS[0] as string, ok: false, message: "blocked" },
      ],
    });
    const outcome = await callWallet({ ...base, pool, method: "pay_invoice" });

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("blocked");
  });

  it("ignores a reply to a different request", async () => {
    // Two calls in flight must not resolve with each other's answer. The `#e` filter
    // does this on a real relay; this asserts the transport does not accept a
    // mismatched `e` tag if one arrives anyway.
    vi.useFakeTimers();
    try {
      const { pool } = fakePool({
        reply: () => '{"result_type":"get_balance","result":{"balance":1}}',
        replyToId: "9".repeat(64),
      });
      const pending = callWallet({
        ...base,
        pool,
        method: "get_balance",
        timeoutMs: 500,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the subscription on every path", async () => {
    // A leaked REQ against a wallet relay is a subscription slot that never returns.
    const answered = fakePool({
      reply: () => '{"result_type":"get_balance","result":{"balance":1}}',
    });
    await callWallet({ ...base, pool: answered.pool, method: "get_balance" });
    expect(answered.closed()).toBe(1);

    const refused = fakePool({
      publishResults: [{ relay: RELAYS[0] as string, ok: false }],
    });
    await callWallet({ ...base, pool: refused.pool, method: "get_balance" });
    expect(refused.closed()).toBe(1);
  });

  it("reports an undecryptable reply as failed", async () => {
    // Correctly addressed and correctly tagged, so it passes the anti-spoof guard —
    // and then does not decrypt. That has to be reported, not silently ignored, or a
    // tampered reply would look like a wallet that never answered.
    const { pool } = fakePool({ rawReply: "garbage?iv=garbage" });
    const outcome = await callWallet({
      ...base,
      pool,
      method: "get_balance",
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toMatch(/decrypt/i);
  });

  it("ignores a reply from someone other than the wallet", async () => {
    // A relay can return anything. An impostor's reply must not resolve the call —
    // for `pay_invoice` that would be a third party reporting a payment as sent.
    vi.useFakeTimers();
    try {
      const impostor = getPublicKey(generateSecretKey()) as Hex32;
      const pool = {
        subscribe: (
          _f: unknown,
          cb: { onEvent?: (e: NostrEvent, r: string) => void },
        ) => {
          setTimeout(
            () =>
              cb.onEvent?.(
                {
                  id: "f".repeat(64),
                  pubkey: impostor,
                  created_at: 1,
                  kind: WALLET_RESPONSE_KIND,
                  tags: [["e", "0".repeat(64)]],
                  content: "anything",
                  sig: "0".repeat(128),
                },
                RELAYS[0] as string,
              ),
            0,
          );
          return { id: "s", close: () => {} };
        },
        publish: async () => [{ relay: RELAYS[0] as string, ok: true }],
      } as unknown as RelayPool;

      const pending = callWallet({
        ...base,
        pool,
        method: "get_balance",
        timeoutMs: 500,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("walletOutcomeMessage", () => {
  it("says nothing for a success", () => {
    expect(
      walletOutcomeMessage({
        kind: "ok",
        response: { ok: true, resultType: "get_balance", result: {} },
      }),
    ).toBeUndefined();
  });

  it("is non-committal about a timeout", () => {
    // We do not know whether the payment happened, and implying either answer is
    // worse than saying so.
    const message = walletOutcomeMessage({ kind: "timeout" }) ?? "";
    expect(message).toMatch(/may still have/i);
  });

  it("passes a refusal's own message through", () => {
    expect(
      walletOutcomeMessage({
        kind: "ok",
        response: { ok: false, code: "PAYMENT_FAILED", message: "no route" },
      }),
    ).toBe("no route");
  });
});
