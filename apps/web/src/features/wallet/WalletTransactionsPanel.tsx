import { satFromMsat } from "@setu/protocol";
import { Button, Panel, PanelRow, Spinner } from "@setu/ui";
import { ArrowDownLeft, ArrowUpRight, HelpCircle, List } from "lucide-react";
import { absoluteTime, relativeTime } from "../notes/relativeTime";
import type { WalletApi } from "./useWallet";
import type { WalletTransaction } from "./walletMethods";

/**
 * Recent wallet history, on request.
 *
 * ## Loaded on a press, not on mount
 *
 * `list_transactions` is a signed, encrypted request to a relay that hands the wallet
 * service a fresh piece of information — that this client is watching right now. Firing
 * it every time the wallet screen mounts spends that for a list most visits do not look
 * at. So it is a button, and the empty state says what pressing it does.
 *
 * ## Three things this list refuses to guess
 *
 *  - **Direction.** A row whose `type` the wallet omitted is drawn with a neutral mark
 *    and no sign, not as money in. A credit that was actually a debit is worse than an
 *    unlabelled row.
 *  - **Amount.** A row with no readable amount says so rather than showing 0 sats.
 *  - **Settlement.** Only a stated `settled` or a real settlement time reads as paid;
 *    everything else is labelled as it arrived. See `walletMethods`.
 *
 * An answered-but-empty history and a history never asked for are different states, and
 * `transactions === undefined` is what keeps them apart — the same reason a balance is
 * `undefined` rather than 0 until read.
 */
export function WalletTransactionsPanel({
  wallet,
}: {
  readonly wallet: WalletApi;
}) {
  const loading = wallet.pending === "transactions";
  const rows = wallet.transactions;
  const unsupported = !wallet.supports("list_transactions");

  return (
    <Panel
      title="Recent activity"
      action={
        <Button
          size="xs"
          variant="outline"
          onClick={() => void wallet.loadTransactions()}
          disabled={wallet.busy}
        >
          {loading ? <Spinner size={12} /> : <List />}
          {rows === undefined ? "Load" : "Reload"}
        </Button>
      }
    >
      <div className="pb-2">
        {unsupported ? (
          <p className="px-4 pb-2 text-2xs text-muted-foreground">
            This connection does not advertise{" "}
            <span className="font-mono">list_transactions</span>, so the wallet
            is likely to refuse.
          </p>
        ) : null}

        {rows === undefined ? (
          <p className="px-4 pb-2 text-xs text-muted-foreground">
            Not loaded. Asking sends one encrypted request to the wallet, so
            Setu waits until you want it.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 pb-2 text-xs text-muted-foreground">
            The wallet reported no transactions for this connection.
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {rows.map((row, index) => (
              <li key={rowKey(row, index)}>
                <TransactionRow row={row} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/**
 * A stable-ish key.
 *
 * The payment hash when there is one; otherwise the index, because two rows a wallet
 * described identically are still two rows and dropping one to a key collision would
 * hide a payment.
 */
function rowKey(row: WalletTransaction, index: number): string {
  return row.paymentHash ?? `${row.createdAt ?? 0}:${index}`;
}

function TransactionRow({ row }: { readonly row: WalletTransaction }) {
  const at = row.settledAt ?? row.createdAt;
  const sats = row.amount === undefined ? undefined : satFromMsat(row.amount);
  const sign =
    row.direction === "incoming"
      ? "+"
      : row.direction === "outgoing"
        ? "−"
        : "";

  return (
    <PanelRow className="flex items-baseline gap-2">
      <span className="mt-0.5 shrink-0 text-muted-foreground">
        {row.direction === "incoming" ? (
          <ArrowDownLeft className="size-3.5" aria-label="Received" />
        ) : row.direction === "outgoing" ? (
          <ArrowUpRight className="size-3.5" aria-label="Sent" />
        ) : (
          <HelpCircle className="size-3.5" aria-label="Direction not stated" />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">
          {row.description ?? "No description"}
        </span>
        <span className="block text-2xs text-muted-foreground">
          {stateLabel(row)}
          {at !== undefined ? (
            <>
              {" · "}
              <span title={absoluteTime(at)}>{relativeTime(at)}</span>
            </>
          ) : null}
        </span>
      </span>

      <span className="shrink-0 text-xs tabular-nums">
        {sats === undefined ? (
          <span className="text-muted-foreground">amount not stated</span>
        ) : (
          `${sign}${sats.toLocaleString()} sats`
        )}
      </span>
    </PanelRow>
  );
}

function stateLabel(row: WalletTransaction): string {
  switch (row.state) {
    case "settled":
      return "Settled";
    case "pending":
      return "Pending";
    case "failed":
      return "Failed";
    case "expired":
      return "Expired";
    default:
      // The wallet stated neither a state nor a settlement time. Saying so is the only
      // honest option: "pending" would be a guess about someone's money.
      return "State not stated";
  }
}
