import { describe, expect, it } from "vitest";
import { planWalletZap } from "./zapPayment";

/**
 * The three rules that decide whether a zap's invoice may be paid without anyone reading
 * it, and what each one is protecting against.
 *
 * The invoices below are real BOLT11 human-readable prefixes with dummy data parts — the
 * amount lives entirely in the prefix, so that is all `bolt11Sats` needs and all these
 * cases exercise.
 */

/** 21 sats: `lnbc` + 210 + `n` (nano-BTC) → 210 × 1e-9 × 1e8 = 21. */
const INVOICE_21_SATS = "lnbc210n1pabcdefghijklmnop";
/** 100,000 sats. The overcharge case. */
const INVOICE_100K_SATS = "lnbc1m1pabcdefghijklmnop";
/** No amount at all: the `1` is the bech32 separator, not a figure. */
const INVOICE_NO_AMOUNT = "lnbc1pabcdefghijklmnop";

describe("planWalletZap", () => {
  it("pays through the wallet when the invoice matches what was asked for", () => {
    const plan = planWalletZap({
      invoice: INVOICE_21_SATS,
      requestedMsat: 21_000,
      canPay: true,
    });
    expect(plan).toEqual({ route: "wallet", amountSats: 21 });
  });

  it("hands off when there is no wallet, and says nothing about why", () => {
    // The ordinary case for most readers. A reason here would be a message explaining
    // the absence of a feature they never turned on.
    const plan = planWalletZap({
      invoice: INVOICE_21_SATS,
      requestedMsat: 21_000,
      canPay: false,
    });
    expect(plan).toEqual({ route: "handoff" });
  });

  it("refuses to auto-pay an invoice that asks for more than was requested", () => {
    /*
     * The failure this prevents, and the reason this file exists: the invoice comes from
     * a stranger's LNURL server, which is told the amount and could answer with any
     * amount at all. Paying 100,000 sats because a server asked, when 21 were intended,
     * is a loss with no recourse — Lightning payments do not reverse.
     */
    const plan = planWalletZap({
      invoice: INVOICE_100K_SATS,
      requestedMsat: 21_000,
      canPay: true,
    });
    expect(plan.route).toBe("handoff");
    // Digit-grouping is `toLocaleString`'s business and differs by locale — this test
    // ran on a machine that groups 100000 as "1,00,000" — so the separators are stripped
    // before asserting that both figures are named.
    const digits =
      plan.route === "handoff"
        ? (plan.reason ?? "").replace(/[^\d ]/g, "")
        : "";
    expect(digits).toContain("100000");
    // The requested figure is named too, so the discrepancy is legible.
    expect(digits).toContain("21");
  });

  it("refuses to auto-pay an amountless invoice", () => {
    // A zero-amount invoice leaves the amount to the payer. "The wallet decides how
    // much" is not something to trigger from one press on a small icon.
    const plan = planWalletZap({
      invoice: INVOICE_NO_AMOUNT,
      requestedMsat: 21_000,
      canPay: true,
    });
    expect(plan.route).toBe("handoff");
    expect(plan.route === "handoff" && plan.reason).toMatch(/does not state/i);
  });

  it("allows an invoice that asks for less, including a rounded sub-satoshi request", () => {
    // Undercharging cannot cost anyone anything, and `bolt11Sats` floors — so a request
    // for 21.5 sats yields a 21-sat invoice that must not read as a mismatch.
    const plan = planWalletZap({
      invoice: INVOICE_21_SATS,
      requestedMsat: 21_500,
      canPay: true,
    });
    expect(plan).toEqual({ route: "wallet", amountSats: 21 });
  });

  it("reports the amount from the invoice, not the amount requested", () => {
    // The confirmation has to name the figure the wallet will actually settle. Showing
    // the requested number would be confirming a number nobody is going to pay.
    const plan = planWalletZap({
      invoice: INVOICE_21_SATS,
      requestedMsat: 1_000_000,
      canPay: true,
    });
    expect(plan.route === "wallet" && plan.amountSats).toBe(21);
  });
});
