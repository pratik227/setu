import { EmptyState, ScrollArea } from "@setu/ui";
import { Wallet } from "lucide-react";
import { useSession } from "../identity/SessionProvider";
import { useWallet } from "./useWallet";
import { WalletPayPanel } from "./WalletPayPanel";
import { WalletReceivePanel } from "./WalletReceivePanel";
import { WalletSection } from "./WalletSettings";
import { WalletTransactionsPanel } from "./WalletTransactionsPanel";

/**
 * The wallet, as its own destination.
 *
 * It was a panel in Settings, which is the wrong home for it: settings are things you
 * change once, and a balance is something you check. Buried three scrolls down a
 * settings page it was effectively invisible — the same reason the sidebar now carries
 * a Wallet row rather than leaving this behind a gear icon.
 *
 * ## One hook, four panels
 *
 * This screen owns the single `useWallet` instance and hands it down. Each panel calling
 * the hook itself would give the screen four wallets: four subscriptions to the same
 * kind-13194, four independent busy flags — so the receive panel would spin while the
 * pay panel worked — and four copies of the "one request at a time" guard, which is the
 * one that stops a double-press becoming a double payment.
 *
 * ## Paying and receiving appear only when the key is available
 *
 * A locked or absent connection cannot do either, so the controls are not rendered
 * rather than rendered disabled. A disabled Pay button on a locked wallet invites a
 * reader to work out why; the pairing panel above it is already saying why.
 */
export function WalletScreen() {
  const { session } = useSession();
  const wallet = useWallet();

  if (!session) {
    return (
      <EmptyState
        icon={<Wallet className="size-6" />}
        title="Sign in to connect a wallet"
        description="A wallet connection is stored per account and encrypted with your passphrase, so there is nothing to pair until this client has an identity."
      />
    );
  }

  return (
    <ScrollArea className="px-4 py-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-12">
        <WalletSection wallet={wallet} />
        {wallet.state.status === "ready" ? (
          <>
            <WalletPayPanel wallet={wallet} />
            <WalletReceivePanel wallet={wallet} />
            <WalletTransactionsPanel wallet={wallet} />
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
}
