import type { Hex32 } from "@setu/protocol";
import { useCallback, useMemo, useRef } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSession } from "../identity/SessionProvider";
import {
  methodRuledOut,
  type PaymentResult,
  payInvoice,
} from "./walletPayments";
import { walletCapabilities, walletSessionSecret } from "./walletSession";
import { readWalletConnection } from "./walletStorage";

/**
 * The paying half of the wallet, for surfaces that are not the wallet screen.
 *
 * `useWallet` is the wallet *as a screen sees it* — it holds a balance, a busy flag, an
 * error, and it subscribes to the wallet's info event. None of that belongs behind a
 * note row: a feed needs exactly two things, "could this be paid right now" and "pay
 * this", and mounting the full hook per surface would open one extra subscription per
 * surface for a capability list the session store already has.
 *
 * ## Everything a payment needs is read at call time, not captured
 *
 * `canPay` and `pay` are stable for the life of the component and take nothing from the
 * render closure. That is not a micro-optimisation: `useNoteRowActions` documents,
 * with measurements, that a churning action object costs the feed its row memoisation
 * entirely — so a payer whose functions changed identity whenever a balance or a
 * capability list arrived would re-render every row on screen. Reading the secret from
 * the module store inside the call also means it never enters a dependency array, which
 * is the second reason: a dependency array is a place a spending key can be retained
 * long after the component that fetched it stopped caring.
 *
 * ## It deliberately does not subscribe to the wallet at all
 *
 * There is no reactive `ready` flag here, and that is a choice rather than an omission:
 * nothing a feed *renders* depends on whether a wallet is unlocked — the zap control is
 * the same control either way — so subscribing would re-render every surface holding this
 * hook each time a capability list or an unlock arrived, to change nothing on screen. The
 * one place that does need to react, the wallet screen, uses `useWallet`.
 */
export interface WalletPayer {
  /**
   * Stable. True when a payment could be attempted right now.
   *
   * A function rather than a boolean so its answer is current at the moment of the
   * press, without this hook having to re-render to stay accurate.
   */
  readonly canPay: () => boolean;
  /**
   * Stable. Sends exactly one `pay_invoice` and resolves with what is known.
   *
   * Never retries, and a `"unknown"` result means the request went out and the answer
   * never came — see `walletPayments`. A caller must not call this again on that
   * outcome without a person deciding to.
   */
  readonly pay: (invoice: string) => Promise<PaymentResult>;
}

export function useWalletPayer(): WalletPayer {
  const engine = useEngine();
  const { session } = useSession();
  const account = session?.pubkey;

  // Read through refs so the two callbacks below never depend on them.
  const accountRef = useRef(account);
  accountRef.current = account;
  const engineRef = useRef(engine);
  engineRef.current = engine;

  const canPay = useCallback((): boolean => {
    const owner = accountRef.current;
    if (!walletSessionSecret(owner)) return false;
    if (!readWalletConnection(owner)) return false;
    // A wallet that advertised its methods and did not list pay_invoice would answer
    // NOT_IMPLEMENTED *after* a request was signed and published. Reading the list
    // first is the difference between falling back cleanly and a 30-second dead end.
    return !methodRuledOut(walletCapabilities(owner).methods, "pay_invoice");
  }, []);

  const pay = useCallback(async (invoice: string): Promise<PaymentResult> => {
    const owner = accountRef.current;
    const secret = walletSessionSecret(owner);
    const stored = readWalletConnection(owner);
    if (!secret || !stored) {
      // Local dead end: nothing was signed and nothing published.
      return {
        kind: "failed",
        message:
          "No unlocked wallet connection, so nothing was sent. Unlock the wallet and try again.",
      };
    }
    return payInvoice(
      {
        pool: engineRef.current.pool,
        walletPubkey: stored.walletPubkey as Hex32,
        relays: stored.relays,
        secret,
        nip44: walletCapabilities(owner).nip44,
      },
      invoice,
    );
  }, []);

  // One object for the life of the component, because both members are stable.
  return useMemo(() => ({ canPay, pay }), [canPay, pay]);
}
