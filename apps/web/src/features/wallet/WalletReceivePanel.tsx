import { satFromMsat } from "@setu/protocol";
import { Button, Input, Label, Panel, Spinner } from "@setu/ui";
import { Copy, Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { copyText } from "../notes/noteLink";
import { absoluteTime } from "../notes/relativeTime";
import type { WalletApi } from "./useWallet";

/**
 * Being paid: ask the wallet for an invoice, then ask whether it was paid.
 *
 * ## Why the "check" button exists and is not a subscription
 *
 * A settled invoice produces no Nostr event, so nothing arrives to tell this screen that
 * money came in. `lookup_invoice` is the only honest answer to "has it been paid?", and
 * it is offered as a button rather than a poll: a poll would send an encrypted, signed
 * request to a relay every few seconds for as long as the panel is open, which is a lot
 * of traffic and metadata to spend on a question the user can ask when they care.
 *
 * ## What the status line will not say
 *
 * It reports settled only when the wallet said `settled` or gave a settlement time.
 * Anything else reads as pending or unknown — see `walletMethods`. An invoice drawn as
 * paid because a field was missing is money someone believes they have.
 *
 * The amount is entered in sats because that is what people think in, and converted with
 * `msatFromSat` in `useWallet` — the one sanctioned crossing. Nothing here multiplies by
 * a thousand.
 */
export function WalletReceivePanel({ wallet }: { readonly wallet: WalletApi }) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [copied, setCopied] = useState<string | undefined>();

  const sats = Number.parseInt(amount, 10);
  const valid = Number.isFinite(sats) && sats > 0;
  const creating = wallet.pending === "invoice";
  const checking = wallet.pending === "lookup";
  const unsupported = !wallet.supports("make_invoice");
  const { invoice, invoiceStatus } = wallet;

  const create = () => {
    if (!valid) return;
    setCopied(undefined);
    void wallet.createInvoice({
      amountSats: sats,
      ...(description.trim() !== "" ? { description: description.trim() } : {}),
    });
  };

  return (
    <Panel title="Receive">
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">
          Have the connected wallet mint an invoice you can hand to whoever is
          paying.
        </p>

        {unsupported ? (
          <p className="text-2xs text-muted-foreground">
            This connection does not advertise{" "}
            <span className="font-mono">make_invoice</span>, so the wallet is
            likely to refuse.
          </p>
        ) : null}

        {invoice ? (
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <p className="text-xs">
              {invoice.amount === undefined ? (
                "Invoice created."
              ) : (
                <>
                  Invoice for{" "}
                  <span className="font-semibold tabular-nums">
                    {satFromMsat(invoice.amount).toLocaleString()}
                  </span>{" "}
                  sats
                  {invoice.expiresAt !== undefined
                    ? `, expiring ${absoluteTime(invoice.expiresAt)}`
                    : ""}
                  .
                </>
              )}
            </p>
            <p className="font-mono text-2xs break-all">{invoice.invoice}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void copyText(invoice.invoice).then((result) => {
                    setCopied(
                      result.ok
                        ? "Invoice copied"
                        : "The clipboard was refused — select the invoice above instead.",
                    );
                  });
                }}
              >
                <Copy />
                Copy
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void wallet.checkInvoice()}
                disabled={wallet.busy}
              >
                {checking ? <Spinner size={12} /> : <RefreshCw />}
                Check if paid
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setCopied(undefined);
                  wallet.clearInvoice();
                }}
              >
                <X />
                Clear
              </Button>
            </div>
            {copied ? (
              <p className="text-2xs text-muted-foreground">{copied}</p>
            ) : null}
            {invoiceStatus ? (
              <p className="text-2xs text-muted-foreground">
                {invoiceStatus.state === "settled"
                  ? `Paid${
                      invoiceStatus.settledAt !== undefined
                        ? ` at ${absoluteTime(invoiceStatus.settledAt)}`
                        : ""
                    }.`
                  : invoiceStatus.state === "pending"
                    ? "Not paid yet."
                    : invoiceStatus.state === "unknown"
                      ? "The wallet did not say whether this has been paid."
                      : `The wallet reports this invoice as ${invoiceStatus.state}.`}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-3">
              <div className="w-32 space-y-1">
                <Label htmlFor="wallet-receive-amount">Amount (sats)</Label>
                <Input
                  id="wallet-receive-amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="numeric"
                  placeholder="1000"
                />
              </div>
              <div className="min-w-40 flex-1 space-y-1">
                <Label htmlFor="wallet-receive-note">Description</Label>
                <Input
                  id="wallet-receive-note"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What it is for (optional)"
                />
              </div>
            </div>
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={create}
                disabled={!valid || wallet.busy}
              >
                {creating ? <Spinner size={14} /> : <Plus />}
                Create invoice
              </Button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
