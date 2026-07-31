import type { PublishResult, RelayPool } from "@setu/core";
import {
  decryptNip04,
  encryptNip04,
  generateSecretKey,
  getPublicKey,
  type Hex32,
  msatFromSat,
  type NostrEvent,
  WALLET_RESPONSE_KIND,
} from "@setu/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  listTransactions,
  lookupInvoice,
  makeInvoice,
  methodRuledOut,
  PAY_TIMEOUT_MS,
  payInvoice,
} from "./walletPayments";

/**
 * The paying verbs against a fake wallet.
 *
 * Every case here is a way of getting a payment's story wrong, and the first two
 * describes are the ones that cost real money if they regress:
 *
 *  - a wallet that never answers must not resolve as a failure, because the request was
 *    published and the money may be gone;
 *  - nothing may send a second request off the back of the first.
 *
 * The fake pool is the pattern from `walletTransport.test.ts`, deliberately copied rather
 * than shared: these tests assert on the *decrypted request body*, which that file has no
 * reason to expose, and a shared helper that grew both jobs would be harder to read than
 * two small ones. No live relay and no real wallet is involved on any path.
 */

const walletSecret = generateSecretKey();
const walletPubkey = getPublicKey(walletSecret) as Hex32;
const connectionSecret = generateSecretKey();
const connectionPubkey = getPublicKey(connectionSecret) as Hex32;
const RELAYS = ["wss://wallet.example"];

function fakePool(options: {
  reply?: (request: NostrEvent) => string | undefined;
  publishResults?: readonly PublishResult[];
}): { pool: RelayPool; published: NostrEvent[] } {
  const published: NostrEvent[] = [];
  let onEvent: ((event: NostrEvent, relay: string) => void) | undefined;

  const pool = {
    subscribe: (
      _filters: unknown,
      callbacks: { onEvent?: (event: NostrEvent, relay: string) => void },
    ) => {
      onEvent = callbacks.onEvent;
      return { id: "sub", close: () => {} };
    },
    publish: async (event: NostrEvent) => {
      published.push(event);
      const body = options.reply?.(event);
      if (body !== undefined) {
        const reply: NostrEvent = {
          id: "f".repeat(64),
          pubkey: walletPubkey,
          created_at: event.created_at,
          kind: WALLET_RESPONSE_KIND,
          tags: [
            ["p", connectionPubkey],
            ["e", event.id],
          ],
          content: encryptNip04(walletSecret, connectionPubkey, body),
          sig: "0".repeat(128),
        };
        setTimeout(() => onEvent?.(reply, RELAYS[0] as string), 0);
      }
      return (
        options.publishResults ?? [{ relay: RELAYS[0] as string, ok: true }]
      );
    },
  } as unknown as RelayPool;

  return { pool, published };
}

/** The request the wallet would have read, for asserting on params. */
function requestBody(event: NostrEvent): {
  method: string;
  params: Record<string, unknown>;
} {
  return JSON.parse(
    decryptNip04(walletSecret, connectionPubkey, event.content),
  ) as { method: string; params: Record<string, unknown> };
}

function context(pool: RelayPool) {
  return { pool, walletPubkey, relays: RELAYS, secret: connectionSecret };
}

const INVOICE = "lnbc210n1pabcdefghijklmnop";

describe("payInvoice", () => {
  it("reports a wallet that never answers as unknown, not failed", () => {
    /*
     * The single most important assertion in this file.
     *
     * The request was signed, encrypted and accepted by a relay. A `failed` here would
     * tell someone their payment did not happen, and the honest answer is that nobody
     * knows — the wallet may have paid, may be paying, or may never have seen it. The
     * wording is asserted too, because the kind being right and the sentence saying
     * "payment failed" would fool the reader just as effectively.
     */
    vi.useFakeTimers();
    return (async () => {
      try {
        const { pool } = fakePool({});
        const pending = payInvoice(context(pool), INVOICE);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(PAY_TIMEOUT_MS);
        const result = await pending;

        expect(result.kind).toBe("unknown");
        const message = result.kind === "unknown" ? result.message : "";
        expect(message).toMatch(/cannot tell whether/i);
        expect(message).toMatch(/check the wallet/i);
        expect(message.toLowerCase()).not.toContain("failed");
        expect(message.toLowerCase()).not.toContain("was sent");
      } finally {
        vi.useRealTimers();
      }
    })();
  });

  it("publishes exactly one request and never a second", async () => {
    // Nothing in this layer retries. An automatic second attempt after a slow wallet
    // is how one zap becomes two payments.
    vi.useFakeTimers();
    try {
      const { pool, published } = fakePool({});
      const pending = payInvoice(context(pool), INVOICE);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(PAY_TIMEOUT_MS * 3);
      await pending;
      expect(published).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a wallet result as paid", async () => {
    const { pool } = fakePool({
      reply: () =>
        '{"result_type":"pay_invoice","result":{"preimage":"deadbeef","fees_paid":1000}}',
    });
    const result = await payInvoice(context(pool), INVOICE);
    expect(result.kind).toBe("paid");
    expect(result.kind === "paid" && result.receipt.preimage).toBe("deadbeef");
  });

  it("reports a refusal as refused, with the wallet's own reason", async () => {
    // A refusal is the *good* failure: nothing was sent, and the reason is actionable.
    // It must never be flattened into the unknown case, which forbids trying again.
    const { pool } = fakePool({
      reply: () =>
        '{"error":{"code":"INSUFFICIENT_BALANCE","message":"not enough"}}',
    });
    const result = await payInvoice(context(pool), INVOICE);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.code).toBe(
      "INSUFFICIENT_BALANCE",
    );
    expect(result.kind === "refused" && result.message).toBe("not enough");
  });

  it("reports a total publish failure as failed, which is conclusive", async () => {
    // No relay took it, so the wallet cannot have seen it. This is the one payment
    // failure that can be stated plainly.
    const { pool } = fakePool({
      publishResults: [
        { relay: RELAYS[0] as string, ok: false, message: "blocked" },
      ],
    });
    const result = await payInvoice(context(pool), INVOICE);
    expect(result.kind).toBe("failed");
  });

  it("sends the invoice and nothing else", async () => {
    // No `amount` alongside an invoice that already carries one: wallets disagree about
    // which wins, and "two numbers, one of which may be ignored" is not a shape to put
    // on a payment.
    const { pool, published } = fakePool({
      reply: () => '{"result_type":"pay_invoice","result":{"preimage":"a"}}',
    });
    await payInvoice(context(pool), INVOICE);
    const body = requestBody(published[0] as NostrEvent);
    expect(body.method).toBe("pay_invoice");
    expect(body.params).toEqual({ invoice: INVOICE });
  });

  it("refuses an empty invoice without publishing anything", async () => {
    const { pool, published } = fakePool({});
    const result = await payInvoice(context(pool), "   ");
    expect(result.kind).toBe("failed");
    expect(published).toHaveLength(0);
  });

  it("waits longer than a balance read before giving up", () => {
    // A route can take tens of seconds. Cutting a payment off at the general timeout
    // would manufacture the one outcome nobody can resolve.
    expect(PAY_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});

describe("makeInvoice", () => {
  it("sends msat, not sats", async () => {
    // The 1000× bug, asserted on the wire: 21 sats must leave as 21000.
    const { pool, published } = fakePool({
      reply: () =>
        '{"result_type":"make_invoice","result":{"invoice":"lnbc210n1p","amount":21000}}',
    });
    const result = await makeInvoice(context(pool), {
      amount: msatFromSat(21),
      description: "tip",
    });
    expect(result.kind).toBe("ok");
    expect(requestBody(published[0] as NostrEvent).params).toEqual({
      amount: 21_000,
      description: "tip",
    });
  });

  it("treats a result with no invoice as a refusal", async () => {
    // Otherwise the receive panel shows a created invoice with nothing to pay.
    const { pool } = fakePool({
      reply: () => '{"result_type":"make_invoice","result":{"amount":21000}}',
    });
    const result = await makeInvoice(context(pool), {
      amount: msatFromSat(21),
    });
    expect(result.kind).toBe("refused");
  });
});

describe("lookupInvoice", () => {
  it("asks by payment hash and invoice together when both are known", async () => {
    const { pool, published } = fakePool({
      reply: () =>
        '{"result_type":"lookup_invoice","result":{"type":"incoming","settled_at":1700000000,"amount":21000}}',
    });
    const result = await lookupInvoice(context(pool), {
      paymentHash: "hash",
      invoice: INVOICE,
    });
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.value.state).toBe("settled");
    expect(requestBody(published[0] as NostrEvent).params).toEqual({
      payment_hash: "hash",
      invoice: INVOICE,
    });
  });

  it("refuses locally when there is nothing to look up", async () => {
    const { pool, published } = fakePool({});
    const result = await lookupInvoice(context(pool), {});
    expect(result.kind).toBe("failed");
    expect(published).toHaveLength(0);
  });
});

describe("listTransactions", () => {
  it("accepts an empty history as an answer", async () => {
    // An answered empty list is not a refusal: a new connection legitimately has no
    // history, and reporting that as an error would send the user looking for a fault.
    const { pool } = fakePool({
      reply: () =>
        '{"result_type":"list_transactions","result":{"transactions":[]}}',
    });
    const result = await listTransactions(context(pool));
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.value).toEqual([]);
  });

  it("reports a timeout as unknown rather than an empty history", async () => {
    // The failure this prevents: "you have no transactions" for a wallet that simply
    // did not reply.
    vi.useFakeTimers();
    try {
      const { pool } = fakePool({});
      const pending = listTransactions(context(pool));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      expect(result.kind).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("methodRuledOut", () => {
  it("treats an empty list as unknown, not as unsupported", () => {
    // The info event may not have arrived. Refusing every verb on an empty list would
    // leave a paired, unlocked wallet with no usable controls at all.
    expect(methodRuledOut([], "pay_invoice")).toBe(false);
    expect(methodRuledOut(["get_balance"], "pay_invoice")).toBe(true);
    expect(methodRuledOut(["pay_invoice"], "pay_invoice")).toBe(false);
  });
});
