import { satFromMsat } from "@setu/protocol";
import { Button, Label, Panel, Spinner, Textarea } from "@setu/ui";
import { Check, RefreshCw, Send, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { bolt11Sats } from "../notes/bolt11";
import type { WalletApi } from "./useWallet";
import { readInvoice } from "./walletMethods";

/**
 * Paying an invoice, in two presses.
 *
 * ## Why there is a review step at all
 *
 * A pasted invoice is an opaque string: nobody reads an amount out of `lnbc210n1p…`.
 * A single "Pay" button next to a text box is therefore a button whose consequence is
 * invisible until after it happens, so this decodes the amount from the invoice itself
 * and shows it, and only then offers to pay. The amount comes from the invoice and never
 * from anything the user typed — the invoice is what the wallet will actually settle.
 *
 * ## The three outcomes are three different things on screen
 *
 * `refused` and `failed` are errors: nothing was paid, and the reason helps. `paid` is a
 * confirmation. And `unknown` — no reply from the wallet — is neither, so it gets its own
 * block, its own wording and **no retry button**. The one action offered there is a
 * balance read, which moves nothing and is the fastest way for someone to find out what
 * actually happened. Putting a "Try again" next to an unresolved payment is how a person
 * pays twice for one thing.
 *
 * ## Nothing pays without the review being current
 *
 * Confirming clears the review, so the button is gone the moment it is pressed and a
 * second payment needs the whole two-step again. `useWallet` refuses a concurrent request
 * as well; both guards are cheap and the failure they prevent is not.
 */
export function WalletPayPanel({ wallet }: { readonly wallet: WalletApi }) {
  const [raw, setRaw] = useState("");
  const [review, setReview] = useState<
    { readonly invoice: string; readonly sats: number | undefined } | undefined
  >();
  const [problem, setProblem] = useState<string | undefined>();

  const paying = wallet.pending === "pay";
  const payment = wallet.lastPayment;
  const unsupported = !wallet.supports("pay_invoice");

  const startReview = () => {
    const checked = readInvoice(raw);
    if (!checked.ok) {
      setReview(undefined);
      setProblem(checked.message);
      return;
    }
    setProblem(undefined);
    wallet.clearPayment();
    setReview({ invoice: checked.invoice, sats: bolt11Sats(checked.invoice) });
  };

  const confirm = () => {
    if (!review || review.sats === undefined) return;
    // Cleared first: the control disappears as it is pressed, so a double-click cannot
    // send the same invoice twice even before `useWallet`'s in-flight guard sees it.
    setReview(undefined);
    void wallet.pay(review.invoice);
  };

  return (
    <Panel title="Pay an invoice">
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">
          Paste a BOLT11 invoice. Setu shows you the amount it encodes before
          anything is sent, and asks again before sending it.
        </p>

        {unsupported ? (
          <p className="text-2xs text-muted-foreground">
            This wallet's connection does not advertise{" "}
            <span className="font-mono">pay_invoice</span>, so it would refuse a
            payment. The field is left here in case its capability list is
            incomplete.
          </p>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="wallet-invoice">Invoice</Label>
          <Textarea
            id="wallet-invoice"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            placeholder="lnbc…"
            rows={3}
            spellCheck={false}
            className="font-mono text-2xs"
          />
        </div>

        {problem ? <p className="text-xs text-destructive">{problem}</p> : null}

        {review ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            {review.sats === undefined ? (
              <p className="text-xs">
                This invoice does not state an amount, so there is no figure to
                confirm and Setu will not send it. Ask for an invoice with an
                amount on it.
              </p>
            ) : (
              <>
                <p className="text-xs">
                  Send{" "}
                  <span className="font-semibold tabular-nums">
                    {review.sats.toLocaleString()}
                  </span>{" "}
                  sats from your connected wallet?
                </p>
                <p className="mt-1 text-2xs text-muted-foreground">
                  The amount is read from the invoice itself. Your wallet may
                  add a routing fee on top.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={confirm} disabled={paying}>
                    {paying ? <Spinner size={14} /> : <Send />}
                    Pay {review.sats.toLocaleString()} sats
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReview(undefined)}
                  >
                    <X />
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={startReview}
              disabled={paying || raw.trim() === ""}
            >
              {paying ? <Spinner size={14} /> : <Send />}
              Review payment
            </Button>
          </div>
        )}

        {payment ? <PaymentOutcome wallet={wallet} /> : null}
      </div>
    </Panel>
  );
}

/**
 * The last payment's outcome.
 *
 * Split out because the unresolved case needs several sentences and a button, and
 * inlining it made the paying flow above hard to read — which for a payment surface is
 * itself a safety property.
 */
function PaymentOutcome({ wallet }: { readonly wallet: WalletApi }) {
  const payment = wallet.lastPayment;
  if (!payment) return null;

  if (payment.kind === "paid") {
    const fees = payment.receipt.feesPaid;
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
        <p className="flex items-start gap-1.5 text-xs">
          <Check className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Your wallet reported the payment as made
            {fees !== undefined
              ? `, with ${satFromMsat(fees).toLocaleString()} sats of routing fees`
              : ""}
            .
          </span>
        </p>
        {payment.receipt.preimage ? (
          <p className="mt-1 font-mono text-2xs break-all text-muted-foreground">
            {payment.receipt.preimage}
          </p>
        ) : null}
        <Dismiss wallet={wallet} />
      </div>
    );
  }

  if (payment.kind === "unknown") {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
        <p className="flex items-start gap-1.5 text-xs font-medium">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>This payment is unresolved</span>
        </p>
        <p className="mt-1 text-2xs text-muted-foreground">{payment.message}</p>
        <p className="mt-1 text-2xs text-muted-foreground">
          The request reached a relay, so the wallet may have paid it, may be
          paying it now, or may never have seen it. Setu cannot tell which, and
          sending it again could pay the same invoice twice.
        </p>
        <div className="mt-2 flex gap-2">
          {/* A read, not a retry: it moves nothing and it is the fastest evidence
              available about whether the money left. */}
          <Button
            size="xs"
            variant="outline"
            onClick={() => void wallet.refresh()}
            disabled={wallet.busy}
          >
            {wallet.pending === "balance" ? (
              <Spinner size={12} />
            ) : (
              <RefreshCw />
            )}
            Read balance
          </Button>
          <Button size="xs" variant="ghost" onClick={wallet.clearPayment}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5">
      <p className="flex items-start gap-1.5 text-xs">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <span>{payment.message}</span>
      </p>
      <p className="mt-1 text-2xs text-muted-foreground">Nothing was sent.</p>
      <Dismiss wallet={wallet} />
    </div>
  );
}

function Dismiss({ wallet }: { readonly wallet: WalletApi }) {
  return (
    <div className="mt-2">
      <Button size="xs" variant="ghost" onClick={wallet.clearPayment}>
        Dismiss
      </Button>
    </div>
  );
}
