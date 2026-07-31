import { satFromMsat } from "@setu/protocol";
import { Button, Input, Label, Panel, Spinner } from "@setu/ui";
import { Lock, RefreshCw, ShieldAlert, Unplug, Wallet } from "lucide-react";
import { useState } from "react";
import { useSession } from "../identity/SessionProvider";
import type { WalletApi } from "./useWallet";

/**
 * Pairing a Lightning wallet over NIP-47, and what the screen owes the reader.
 *
 * A connection string here is a **spending key**, so this panel says four things most
 * wallet pairings do not:
 *
 *  - **What the string is.** People paste these having been told it is a "connection".
 *    Knowing it authorises payments up to a budget *the wallet* sets — not one Setu can
 *    enforce — is what makes the budget decision an informed one.
 *  - **That Setu cannot revoke it.** Disconnecting deletes this device's copy. It does
 *    not tell the wallet anything, so a leaked string stays live until its owner revokes
 *    it at the wallet. Saying so is the difference between a user who revokes and one
 *    who assumes we did.
 *  - **Why there is a passphrase.** It is not ceremony: without it the key sits in
 *    `localStorage` in the clear, readable by any script that gets into the page.
 *  - **What the unlocked key can now do.** It pays zaps, which it could not before, so
 *    the panel says so and offers a lock — the key stays in memory across screens until
 *    something drops it, and "something" should include the user.
 *
 * The balance is shown as a plain number with no fiat conversion, because a rate would
 * be a claim sourced from a third party this client does not talk to.
 *
 * The wallet API is passed in rather than taken from `useWallet` here: the screen mounts
 * this panel beside the pay, receive and history panels, and four independent hook
 * instances would mean four subscriptions to the same capability event and four
 * disagreeing busy flags.
 */

function ConnectForm({
  onConnect,
  busy,
}: {
  onConnect(uri: string, passphrase: string): boolean;
  busy: boolean;
}) {
  const [uri, setUri] = useState("");
  const [passphrase, setPassphrase] = useState("");

  const submit = () => {
    if (uri.trim() === "" || passphrase === "") return;
    // Cleared on success only. On failure the string stays so the reader can see what
    // they pasted — a wallet URI is long and retyping it is the usual reason people
    // give up on pairing.
    if (onConnect(uri.trim(), passphrase)) {
      setUri("");
      setPassphrase("");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-1">
        <Label htmlFor="wallet-uri">Connection string</Label>
        <Input
          id="wallet-uri"
          value={uri}
          onChange={(event) => setUri(event.target.value)}
          placeholder="nostr+walletconnect://…"
          // `password`, not `text`: this is a spending key, and it should not be
          // shoulder-readable or land in a form-history suggestion list.
          type="password"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-2xs text-muted-foreground">
          From your wallet's “Nostr Wallet Connect” screen. It contains a key
          that can spend up to the budget your wallet sets — Setu cannot raise
          or enforce that limit.
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="wallet-passphrase">Passphrase</Label>
        <Input
          id="wallet-passphrase"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          type="password"
          autoComplete="new-password"
        />
        <p className="text-2xs text-muted-foreground">
          Encrypts the key on this device. Without one it would sit in browser
          storage in the clear, readable by any script that gets into the page.
          You will be asked for it again after a reload.
        </p>
      </div>

      <div>
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? <Spinner size={14} /> : <Wallet />}
          Pair wallet
        </Button>
      </div>
    </div>
  );
}

function UnlockForm({ onUnlock }: { onUnlock(passphrase: string): boolean }) {
  const [passphrase, setPassphrase] = useState("");
  return (
    <div className="space-y-1">
      <Label htmlFor="wallet-unlock">Passphrase</Label>
      <div className="flex gap-2">
        <Input
          id="wallet-unlock"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onUnlock(passphrase)) {
              setPassphrase("");
            }
          }}
          type="password"
          autoComplete="current-password"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (onUnlock(passphrase)) setPassphrase("");
          }}
        >
          Unlock
        </Button>
      </div>
      <p className="text-2xs text-muted-foreground">
        A wallet is paired on this device but its key is encrypted. Unlocking
        keeps it in memory for this session only.
      </p>
    </div>
  );
}

export function WalletSection({ wallet }: { readonly wallet: WalletApi }) {
  const { session } = useSession();

  if (!session) return null;

  return (
    <Panel title="Lightning wallet">
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">
          Connect a wallet over NIP-47 so Setu can read your balance, pay
          invoices and pay zaps. Requests are signed with a key that belongs to
          this pairing alone, never your identity key — so the wallet service
          never learns which account is asking.
        </p>

        {wallet.state.status === "absent" ? (
          <ConnectForm onConnect={wallet.connect} busy={wallet.busy} />
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <span className="text-xs text-muted-foreground">Wallet</span>
              <span className="font-mono text-2xs break-all">
                {wallet.state.connection.walletPubkey.slice(0, 16)}…
              </span>
              <span className="text-xs text-muted-foreground">
                {wallet.state.connection.relays.length}{" "}
                {wallet.state.connection.relays.length === 1
                  ? "relay"
                  : "relays"}
              </span>
            </div>

            {wallet.state.status === "locked" ? (
              <UnlockForm onUnlock={wallet.unlock} />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs">
                  {wallet.balance === undefined ? (
                    <span className="text-muted-foreground">
                      Balance not read yet
                    </span>
                  ) : (
                    <>
                      <span className="font-semibold tabular-nums">
                        {satFromMsat(wallet.balance).toLocaleString()}
                      </span>{" "}
                      <span className="text-muted-foreground">sats</span>
                    </>
                  )}
                </span>
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
                  {wallet.balance === undefined ? "Read balance" : "Refresh"}
                </Button>
                <Button size="xs" variant="ghost" onClick={wallet.lock}>
                  <Lock />
                  Lock
                </Button>
              </div>
            )}

            {wallet.methods.length > 0 ? (
              <p className="text-2xs text-muted-foreground">
                This wallet supports: {wallet.methods.join(", ")}.
              </p>
            ) : null}

            <div className="border-t border-border/60 pt-3">
              <Button size="xs" variant="outline" onClick={wallet.disconnect}>
                <Unplug />
                Disconnect
              </Button>
              <p className="mt-1.5 text-2xs text-muted-foreground">
                Removes this device's copy of the key. It does <em>not</em>{" "}
                revoke anything at the wallet — if the connection string has
                leaked, revoke it there as well.
              </p>
            </div>
          </>
        )}

        {wallet.error ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1">{wallet.error}</span>
            <button
              type="button"
              onClick={wallet.dismissError}
              className="shrink-0 underline hover:no-underline"
            >
              Dismiss
            </button>
          </p>
        ) : null}

        {wallet.state.status === "ready" ? (
          <p className="text-2xs text-muted-foreground/80">
            While this connection is unlocked, zapping a note pays through it:
            Setu fetches the invoice, shows you the amount it asks for, and
            sends nothing until you confirm. Locking, or a reload, returns zaps
            to opening your own wallet.
          </p>
        ) : (
          <p className="text-2xs text-muted-foreground/80">
            Zaps open your own wallet while this connection is locked. Unlock it
            and they are paid through the connection instead, after a
            confirmation step that shows the amount.
          </p>
        )}
      </div>
    </Panel>
  );
}
