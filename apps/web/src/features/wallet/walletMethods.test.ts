import { msat, satFromMsat } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import {
  invoiceFromResult,
  paymentFromResult,
  readInvoice,
  transactionFromResult,
  transactionsFromResult,
} from "./walletMethods";

/**
 * These are the parsers standing between a stranger's wallet service and a number a
 * screen presents as money, so each case below names the lie it stops.
 */

describe("paymentFromResult", () => {
  it("reads a preimage and fees", () => {
    const receipt = paymentFromResult({ preimage: "abc", fees_paid: 1500 });
    expect(receipt.preimage).toBe("abc");
    expect(receipt.feesPaid).toBe(1500);
  });

  it("omits a preimage the wallet did not send rather than inventing one", () => {
    // A wallet that answered `ok` paid. Fabricating a preimage — or refusing to treat
    // the payment as made — would both be wrong; the field is simply absent.
    expect(paymentFromResult({})).toEqual({});
  });

  it("drops a negative fee instead of subtracting it", () => {
    // `msat()` refuses negatives, and a fee of −1000 rendered as "−1 sat of fees"
    // would show a payment that earned money.
    expect(paymentFromResult({ fees_paid: -1000 }).feesPaid).toBeUndefined();
  });

  it("floors a fractional amount so a fee is never reported larger than it was", () => {
    expect(paymentFromResult({ fees_paid: 1500.9 }).feesPaid).toBe(1500);
  });
});

describe("invoiceFromResult", () => {
  it("requires the invoice string", () => {
    // The failure this prevents: a receive panel showing "invoice created, 1000 sats"
    // with nothing anybody can pay, and a user waiting for money that cannot arrive.
    expect(
      invoiceFromResult({ amount: 1000, payment_hash: "aa" }),
    ).toBeUndefined();
    expect(invoiceFromResult({ invoice: "   " })).toBeUndefined();
  });

  it("keeps the fields it can read and leaves the rest absent", () => {
    const invoice = invoiceFromResult({
      invoice: "lnbc10n1p",
      amount: 1000,
      payment_hash: "hash",
      description: "coffee",
      created_at: 1_700_000_000,
      expires_at: 0,
    });
    expect(invoice?.invoice).toBe("lnbc10n1p");
    expect(invoice?.amount).toBe(1000);
    expect(invoice?.description).toBe("coffee");
    // A zero timestamp is absent, not 1970 — the expiry line must not claim an
    // invoice expired fifty years ago.
    expect(invoice?.expiresAt).toBeUndefined();
  });
});

describe("transactionFromResult", () => {
  it("never guesses a direction", () => {
    // A credit that was really a debit is the worst row this list could draw, so a
    // wallet that omitted `type` gets an unlabelled row.
    expect(transactionFromResult({ amount: 1000 })?.direction).toBe("unknown");
    expect(transactionFromResult({ type: "outgoing" })?.direction).toBe(
      "outgoing",
    );
  });

  it("only calls a transaction settled when the wallet said so", () => {
    // `unknown` rather than `pending` for a silent wallet: both are guesses, and one
    // of them is a guess about whether someone has been paid.
    expect(transactionFromResult({})?.state).toBe("unknown");
    expect(transactionFromResult({ state: "pending" })?.state).toBe("pending");
    expect(transactionFromResult({ settled_at: 1_700_000_000 })?.state).toBe(
      "settled",
    );
    // A wallet predating `state` reports settlement by time only.
    expect(transactionFromResult({ settled_at: 0 })?.state).toBe("unknown");
    // An unrecognised state is not promoted to settled.
    expect(transactionFromResult({ state: "weird" })?.state).toBe("unknown");
  });

  it("leaves an unreadable amount absent rather than zero", () => {
    // A row reading "0 sats" is a claim; "amount not stated" is the truth.
    expect(transactionFromResult({ amount: "1000" })?.amount).toBeUndefined();
    expect(
      transactionFromResult({ amount: Number.NaN })?.amount,
    ).toBeUndefined();
  });

  it("rejects a non-object", () => {
    expect(transactionFromResult(null)).toBeUndefined();
    expect(transactionFromResult("lnbc")).toBeUndefined();
  });
});

describe("transactionsFromResult", () => {
  it("drops unreadable entries and keeps the rest", () => {
    const rows = transactionsFromResult({
      transactions: [{ type: "incoming", amount: 2000 }, null, 7],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe("incoming");
    expect(rows[0]?.amount && satFromMsat(rows[0].amount)).toBe(2);
  });

  it("returns an empty list for a missing field, which the caller reads as history", () => {
    // "The wallet has no transactions" and "the wallet never answered" are told apart
    // by the outcome kind in `walletPayments`, not by this length.
    expect(transactionsFromResult({})).toEqual([]);
    expect(transactionsFromResult({ transactions: "none" })).toEqual([]);
  });
});

describe("readInvoice", () => {
  it("accepts a BOLT11 invoice and lowercases it", () => {
    const result = readInvoice("  LNBC210N1PABCDEFGHIJKLMNOP  ");
    expect(result.ok && result.invoice).toBe("lnbc210n1pabcdefghijklmnop");
  });

  it("strips a lightning: scheme", () => {
    const result = readInvoice("lightning:lnbc210n1pabcdefghijklmnop");
    expect(result.ok && result.invoice).toBe("lnbc210n1pabcdefghijklmnop");
  });

  it("refuses an LNURL and a lightning address by name", () => {
    // Both are pasted constantly and neither can be handed to `pay_invoice`. Saying
    // which it is beats a 30-second wait for the wallet to refuse.
    expect(readInvoice("lnurl1dp68gurn8ghj7").ok).toBe(false);
    expect(readInvoice("someone@example.com").ok).toBe(false);
  });

  it("refuses a truncated invoice locally", () => {
    expect(readInvoice("lnbc21").ok).toBe(false);
    expect(readInvoice("").ok).toBe(false);
  });

  it("never echoes a rejected string back in the message", () => {
    // Same discipline as `parseWalletUri`: a message that quotes its input is a
    // message that can end up in a log with a credential in it. Nothing pasted into a
    // payment field is safe to repeat.
    const result = readInvoice("lnurl1secretlookingthing");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toContain("secret");
  });
});

describe("the msat brand", () => {
  it("is the only way an amount is constructed here", () => {
    // Not a test of these parsers so much as of the rule they follow: `msat()` is
    // total on the values the parsers admit, and a cast would have let −1 through.
    expect(() => msat(-1)).toThrow();
    expect(() => msat(1.5)).toThrow();
  });
});
