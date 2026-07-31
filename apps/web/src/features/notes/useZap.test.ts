import { describe, expect, it } from "vitest";
import { PAYMENT_UNKNOWN_MESSAGE } from "../wallet/walletPayments";
import {
  ZAP_CONFIRMATION_TTL_MS,
  zapConfirmationExpired,
  zapPaymentState,
} from "./useZap";

/**
 * How a finished zap payment is reported to a note row.
 *
 * The hook itself needs a relay, a signer and a renderer; this mapping does not, and it
 * is the part where a payment's outcome could be mis-stated. `noteRowStatus` renders a
 * `handed-off` state as a *notice* and an `error` state as an error, so which of the two
 * a case produces is exactly the difference between "this may have happened, go and look"
 * and "this failed".
 */

const CONFIRMATION = {
  invoice: "lnbc210n1pabcdefghijklmnop",
  amountSats: 21,
} as const;

describe("zapPaymentState", () => {
  it("says the wallet paid, and that the zap is not the payment", () => {
    // The receipt is what makes a zap appear anywhere, and it comes from the recipient's
    // service — so a paid invoice with no receipt yet is normal and the copy says so
    // rather than leaving someone wondering where their zap went.
    const state = zapPaymentState({ kind: "paid", receipt: {} }, CONFIRMATION);
    expect(state.status).toBe("handed-off");
    expect(state.status === "handed-off" && state.message).toMatch(/paid 21/i);
    expect(state.status === "handed-off" && state.message).toMatch(/receipt/i);
  });

  it("reports an unanswered payment as a notice, never as an error", () => {
    /*
     * The most important case in this file. A timeout means the request was published
     * and the wallet may have paid it. Rendering that in the row's *error* slot would
     * tell a reader their payment failed when it may well have succeeded — and the
     * natural response to a failure is to try again, which is how one zap becomes two
     * payments.
     */
    const state = zapPaymentState(
      { kind: "unknown", message: PAYMENT_UNKNOWN_MESSAGE },
      CONFIRMATION,
    );
    expect(state.status).toBe("handed-off");
    expect(state.status).not.toBe("error");
    // Passed through unchanged, so the transport layer's non-committal wording is what
    // the reader sees.
    expect(state.status === "handed-off" && state.message).toBe(
      PAYMENT_UNKNOWN_MESSAGE,
    );
    const message = state.status === "handed-off" ? state.message : "";
    expect(message.toLowerCase()).not.toContain("failed");
    expect(message.toLowerCase()).not.toContain("sent successfully");
  });

  it("keeps the invoice on an unanswered payment", () => {
    // If the wallet did not pay it, it is still payable by hand — and this is the only
    // copy of it that exists anywhere.
    const state = zapPaymentState(
      { kind: "unknown", message: PAYMENT_UNKNOWN_MESSAGE },
      CONFIRMATION,
    );
    expect(state.status === "handed-off" && state.invoice).toBe(
      CONFIRMATION.invoice,
    );
  });

  it("does not offer an invoice for a payment the wallet made", () => {
    // A paid invoice shown beside "your wallet paid" is an invitation to pay it twice.
    const state = zapPaymentState(
      { kind: "paid", receipt: { preimage: "abc" } },
      CONFIRMATION,
    );
    expect(state.status === "handed-off" && state.invoice).toBeUndefined();
  });

  it("lets a confirmation go stale", () => {
    // A press hours after the amount was on screen is not a confirmation of that
    // amount. Past the window the next press fetches a fresh invoice and asks again,
    // which costs a round trip and removes a way to spend money by accident.
    const at = 1_700_000_000_000;
    expect(zapConfirmationExpired(at, at + 1000)).toBe(false);
    expect(zapConfirmationExpired(at, at + ZAP_CONFIRMATION_TTL_MS)).toBe(
      false,
    );
    expect(zapConfirmationExpired(at, at + ZAP_CONFIRMATION_TTL_MS + 1)).toBe(
      true,
    );
  });

  it("reports a refusal and a local dead end as errors", () => {
    // Both mean nothing was sent, which is a fact worth stating plainly — the opposite
    // of the unknown case.
    expect(
      zapPaymentState(
        { kind: "refused", code: "INSUFFICIENT_BALANCE", message: "no funds" },
        CONFIRMATION,
      ),
    ).toEqual({ status: "error", message: "no funds" });
    expect(
      zapPaymentState(
        { kind: "failed", message: "not published" },
        CONFIRMATION,
      ).status,
    ).toBe("error");
  });
});
