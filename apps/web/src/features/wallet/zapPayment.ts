import { bolt11Sats } from "../notes/bolt11";

/**
 * Whether a zap's invoice may be paid through the wallet connection, decided locally.
 *
 * The zap path fetches an invoice from a **stranger's LNURL server** and then, if a
 * wallet is connected, could hand it straight to `pay_invoice`. That last step removes
 * the one place a person used to see the amount before authorising it — their own wallet
 * app — so the check that used to be implicit has to become explicit here.
 *
 * A pure function, separate from the hook, because these three rules are the whole
 * safety argument for automatic zap payment and they are worth asserting without a
 * relay, a fetch or a render in the way:
 *
 *  - **An invoice with no amount is never paid automatically.** A zero-amount invoice
 *    leaves the amount to the payer, and "the wallet decides how much" is not something
 *    to trigger from a single press on a note. It is handed off instead, where the
 *    reader's own wallet asks them.
 *  - **An invoice that asks for more than was requested is never paid automatically.**
 *    The service is told the amount in the callback; an invoice that comes back larger
 *    means it disagreed, and paying 100,000 sats because a server said so when 21 were
 *    intended is exactly the failure this exists to stop. Asking for *less* is allowed:
 *    it cannot overcharge, and it is also what a sub-satoshi rounding produces.
 *  - **The amount shown to the reader comes from the invoice, not from the request.**
 *    The invoice is what the wallet will actually pay. Confirming against the requested
 *    figure would mean confirming a number that is not the one being spent.
 *
 * Falling back to the hand-off rather than erroring is deliberate: a refusal to
 * auto-pay is not a reason the zap cannot happen, it is a reason a person should be the
 * one to approve it.
 */

export type ZapRoute =
  /** Payable through the connection, pending the reader's confirmation. */
  | { readonly route: "wallet"; readonly amountSats: number }
  /**
   * Pay it the old way. `reason` is present only when a *wallet was available* and
   * something about the invoice ruled it out — that sentence has to reach the reader, or
   * a connected wallet silently not being used looks like a broken feature.
   */
  | { readonly route: "handoff"; readonly reason?: string };

export function planWalletZap(input: {
  readonly invoice: string;
  /** What the zap request and the callback were told, in msat. */
  readonly requestedMsat: number;
  /** Whether an unlocked connection that advertises pay_invoice exists right now. */
  readonly canPay: boolean;
}): ZapRoute {
  if (!input.canPay) return { route: "handoff" };

  const invoiceSats = bolt11Sats(input.invoice);
  if (invoiceSats === undefined || invoiceSats <= 0) {
    return {
      route: "handoff",
      reason:
        "The invoice does not state an amount, so Setu did not pay it from your connected wallet.",
    };
  }

  // Compared in msat, and the invoice figure is floored by `bolt11Sats` — so an invoice
  // for exactly the requested amount passes, and a request for a fractional sat cannot
  // fail this check through rounding alone.
  if (invoiceSats * 1000 > input.requestedMsat) {
    return {
      route: "handoff",
      reason: `The lightning service asked for ${invoiceSats.toLocaleString()} sats rather than the ${Math.floor(
        input.requestedMsat / 1000,
      ).toLocaleString()} requested, so Setu did not pay it from your connected wallet.`,
    };
  }

  return { route: "wallet", amountSats: invoiceSats };
}
