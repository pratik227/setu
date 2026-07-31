import {
  balanceFromResult,
  type Hex32,
  type Msat,
  msatFromSat,
  parseWalletInfo,
  supportsNip44,
  WALLET_INFO_KIND,
} from "@setu/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSession } from "../identity/SessionProvider";
import type { WalletInvoice, WalletTransaction } from "./walletMethods";
import {
  listTransactions,
  lookupInvoice,
  makeInvoice,
  methodRuledOut,
  type PaymentResult,
  payInvoice,
  TRANSACTION_PAGE,
  type WalletCallContext,
  type WalletCallResult,
} from "./walletPayments";
import {
  lockWalletSession,
  lockWalletSessionUnless,
  noteWalletCapabilities,
  openWalletSession,
  useWalletSession,
} from "./walletSession";
import {
  forgetWalletConnection,
  readWalletConnection,
  type StoredWalletConnection,
  saveWalletConnection,
  unlockWalletSecret,
  walletSaveMessage,
} from "./walletStorage";
import { callWallet, walletOutcomeMessage } from "./walletTransport";

/**
 * The wallet, as a screen sees it.
 *
 * ## The secret is not in this hook's state
 *
 * It used to be, and that was a bug the moment paying arrived: `useState` gave every
 * caller of this hook a private wallet, so the copy behind a note row was always locked
 * no matter what the wallet screen had unlocked. The key now lives in `walletSession`, a
 * single account-gated module slot — read that file for what the move costs and what
 * pays for it. It is still never returned from here: a caller gets verbs, not a key.
 *
 * ## Locked is a normal state, not an error
 *
 * A stored connection with no unlocked secret is the ordinary state after a reload, and
 * the UI has to distinguish it from "no wallet configured" — one asks for a passphrase,
 * the other asks for a connection string. Both look like "no balance" if you only track
 * one boolean. `lock()` makes returning to that state something a person can choose.
 *
 * ## Nothing is retried automatically, and one thing is deliberately read again
 *
 * A timeout sets an outcome and stops. Re-sending a `pay_invoice` the client cannot
 * account for is how a payment happens twice, so trying again is always a person's
 * decision. The one thing that *is* done without being asked is a balance read after a
 * payment — including after an unresolved one — because reading a balance moves nothing
 * and it is the fastest honest answer to "did that go out?".
 *
 * ## Every outcome is kept, including the one that means nothing is known
 *
 * `lastPayment` holds the full {@link PaymentResult} rather than a message, so the pay
 * surface can render `unknown` as its own state instead of flattening it into the error
 * line where it would read as a failure. That distinction is the entire point of the
 * transport layer's timeout handling; collapsing it here would throw it away at the last
 * step.
 */

export type WalletState =
  /** No connection stored for this account. */
  | { readonly status: "absent" }
  /** Stored, but the secret has not been decrypted this session. */
  | { readonly status: "locked"; readonly connection: StoredWalletConnection }
  | { readonly status: "ready"; readonly connection: StoredWalletConnection };

/** Which request is in flight, so one panel's spinner is not every panel's. */
export type WalletPending =
  | "balance"
  | "pay"
  | "invoice"
  | "lookup"
  | "transactions";

export interface WalletApi {
  readonly state: WalletState;
  /** Balance in msat, once asked for and answered. */
  readonly balance: Msat | undefined;
  /** Methods the wallet advertised, from its kind-13194. */
  readonly methods: readonly string[];
  /** True when the advertised list rules a verb out. Empty list means "unknown". */
  supports(method: string): boolean;
  readonly pending: WalletPending | undefined;
  readonly busy: boolean;
  /** Copy for the last call that did not plainly succeed. */
  readonly error: string | undefined;
  /** Pair from a `nostr+walletconnect://` string. Encrypts under `passphrase`. */
  connect(uri: string, passphrase: string): boolean;
  /** Decrypt a stored connection for this session. False on a wrong passphrase. */
  unlock(passphrase: string): boolean;
  /** Forget the decrypted key without forgetting the pairing. */
  lock(): void;
  refresh(): Promise<void>;
  disconnect(): void;
  dismissError(): void;

  /** Send one payment. Never called twice for one invoice by anything here. */
  pay(invoice: string): Promise<PaymentResult>;
  /** The last payment's outcome, kept in full so `unknown` stays `unknown`. */
  readonly lastPayment: PaymentResult | undefined;
  clearPayment(): void;

  /** Ask the wallet for an invoice to receive against. */
  createInvoice(input: {
    readonly amountSats: number;
    readonly description?: string;
  }): Promise<void>;
  readonly invoice: WalletInvoice | undefined;
  /** What `lookup_invoice` last said about {@link invoice}. */
  readonly invoiceStatus: WalletTransaction | undefined;
  checkInvoice(): Promise<void>;
  clearInvoice(): void;

  /** `undefined` until asked for — distinct from an answered empty history. */
  readonly transactions: readonly WalletTransaction[] | undefined;
  loadTransactions(): Promise<void>;
}

export function useWallet(): WalletApi {
  const engine = useEngine();
  const { session } = useSession();
  const account = session?.pubkey;

  const [stored, setStored] = useState<StoredWalletConnection | undefined>(() =>
    readWalletConnection(account),
  );
  const unlocked = useWalletSession(account);
  const secret = unlocked.secret;
  const [balance, setBalance] = useState<Msat | undefined>();
  const [pending, setPending] = useState<WalletPending | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [lastPayment, setLastPayment] = useState<PaymentResult | undefined>();
  const [invoice, setInvoice] = useState<WalletInvoice | undefined>();
  const [invoiceStatus, setInvoiceStatus] = useState<
    WalletTransaction | undefined
  >();
  const [transactions, setTransactions] = useState<
    readonly WalletTransaction[] | undefined
  >();

  /*
   * One request at a time, tracked in a ref rather than read off `pending`.
   *
   * State is a render behind, so two presses in the same tick both see `pending`
   * undefined. For a balance read that is a wasted REQ; for `pay` it is two published
   * payment requests for one invoice, which is the exact accident this whole feature is
   * written to avoid.
   */
  const inFlight = useRef(false);

  // Re-read and drop everything account-specific when the account changes, during
  // render. One account's wallet must never be reachable while another is signed in,
  // and an effect would leave a frame where it was.
  const [loadedFor, setLoadedFor] = useState(account);
  if (loadedFor !== account) {
    setLoadedFor(account);
    setStored(readWalletConnection(account));
    setBalance(undefined);
    setError(undefined);
    setLastPayment(undefined);
    setInvoice(undefined);
    setInvoiceStatus(undefined);
    setTransactions(undefined);
  }

  /*
   * The secret itself is dropped in an effect, not in the block above.
   *
   * `lockWalletSession` notifies every subscriber, and calling it during render would
   * be a store write while React is rendering a different component. It is safe to be
   * one commit late because every read of the slot is gated on the account anyway: a
   * mismatched account already reads as locked, this only stops the bytes lingering.
   */
  useEffect(() => {
    lockWalletSessionUnless(account);
  }, [account]);

  const state: WalletState = useMemo(() => {
    if (!stored) return { status: "absent" };
    return secret
      ? { status: "ready", connection: stored }
      : { status: "locked", connection: stored };
  }, [stored, secret]);

  /*
   * The wallet's capability announcement, read from its own relays.
   *
   * Kind 13194 is *not* ephemeral, so unlike the request/response pair it does reach
   * the store — which means this can be a normal subscription rather than a socket
   * read. Worth having before any button is offered: `NOT_IMPLEMENTED` arrives after a
   * request has been signed and published, so reading the list first is the difference
   * between a control that is absent and one that can only fail.
   *
   * The answer goes into the session store rather than local state, so the zap path
   * gets it without opening a second subscription per surface.
   */
  useEffect(() => {
    if (!stored || !account) return;
    const filter = {
      kinds: [WALLET_INFO_KIND],
      authors: [stored.walletPubkey],
      limit: 1,
    };
    const subscription = engine.subscriptions.subscribe({
      filters: stored.relays.map((relay) => ({ relay, filter })),
    });
    const unobserve = engine.store.observe(filter, (rows) => {
      const info = rows[0]?.event;
      if (!info) return;
      noteWalletCapabilities(account, {
        methods: parseWalletInfo(info),
        nip44: supportsNip44(info),
      });
    });
    return () => {
      unobserve();
      subscription.close();
    };
  }, [engine, stored, account]);

  const context = useCallback((): WalletCallContext | undefined => {
    if (!stored || !secret) return undefined;
    return {
      pool: engine.pool,
      walletPubkey: stored.walletPubkey as Hex32,
      relays: stored.relays,
      secret,
      nip44: unlocked.nip44,
    };
  }, [engine, stored, secret, unlocked.nip44]);

  const connect = useCallback(
    (uri: string, passphrase: string): boolean => {
      if (!account) {
        setError("Sign in before pairing a wallet.");
        return false;
      }
      const result = saveWalletConnection(account, uri, passphrase);
      if (!result.ok) {
        setError(walletSaveMessage(result.reason));
        return false;
      }
      // Unlocked immediately, so pairing does not require typing the passphrase
      // twice: it was just supplied, and the plaintext key is already derivable.
      const bytes = unlockWalletSecret(result.stored, passphrase);
      setStored(result.stored);
      if (bytes) openWalletSession(account, bytes);
      setError(undefined);
      return true;
    },
    [account],
  );

  const unlock = useCallback(
    (passphrase: string): boolean => {
      if (!stored || !account) return false;
      const bytes = unlockWalletSecret(stored, passphrase);
      if (!bytes) {
        // "Wrong passphrase or corrupt ciphertext" — NIP-49 cannot tell them apart and
        // an oracle that could is not worth building.
        setError("That passphrase did not open the stored connection.");
        return false;
      }
      openWalletSession(account, bytes);
      setError(undefined);
      return true;
    },
    [stored, account],
  );

  /**
   * Read the balance. Split out because a payment triggers one too.
   *
   * Takes the context as an argument rather than closing over it so the post-payment
   * read cannot run against a connection that changed mid-flight.
   */
  const readBalance = useCallback(
    async (call: WalletCallContext, report: boolean) => {
      const outcome = await callWallet({
        pool: call.pool,
        walletPubkey: call.walletPubkey,
        relays: call.relays,
        secret: call.secret,
        method: "get_balance",
        ...(call.nip44 ? { nip44: true } : {}),
      });
      const message = walletOutcomeMessage(outcome);
      // A follow-up read's failure is not reported: it would overwrite the payment
      // outcome the user is reading with a complaint about a balance they did not ask
      // for. The stale balance simply stays stale.
      if (report && message) setError(message);
      if (outcome.kind === "ok" && outcome.response.ok) {
        // `undefined` rather than 0 when the field is missing: a zero balance for a
        // wallet that did not answer the question is a statement about someone's money
        // that nothing supports.
        setBalance(balanceFromResult(outcome.response.result));
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    const call = context();
    if (!call || inFlight.current) return;
    inFlight.current = true;
    setPending("balance");
    setError(undefined);
    try {
      await readBalance(call, true);
    } finally {
      inFlight.current = false;
      setPending(undefined);
    }
  }, [context, readBalance]);

  const disconnect = useCallback(() => {
    forgetWalletConnection(account);
    lockWalletSession();
    setStored(undefined);
    setBalance(undefined);
    setError(undefined);
    setLastPayment(undefined);
    setInvoice(undefined);
    setInvoiceStatus(undefined);
    setTransactions(undefined);
  }, [account]);

  const lock = useCallback(() => {
    lockWalletSession();
    // The balance goes with the key. It was read under a session that is over, and a
    // figure left on screen after locking implies a live connection there is not.
    setBalance(undefined);
    setLastPayment(undefined);
    setInvoice(undefined);
    setInvoiceStatus(undefined);
    setTransactions(undefined);
  }, []);

  const pay = useCallback(
    async (bolt11: string): Promise<PaymentResult> => {
      const call = context();
      if (!call) {
        return {
          kind: "failed",
          message: "Unlock the wallet before paying. Nothing was sent.",
        };
      }
      if (inFlight.current) {
        // Refused rather than queued: a queued payment is a payment nobody pressed.
        return {
          kind: "failed",
          message:
            "Another wallet request is still in flight. Nothing was sent — wait for it to finish.",
        };
      }
      inFlight.current = true;
      setPending("pay");
      setError(undefined);
      setLastPayment(undefined);
      try {
        const result = await payInvoice(call, bolt11);
        setLastPayment(result);
        return result;
      } finally {
        inFlight.current = false;
        setPending(undefined);
      }
    },
    [context],
  );

  /*
   * A balance read after a payment, including an unresolved one.
   *
   * Run as an effect keyed on the outcome rather than inline in `pay`, so it cannot
   * extend the payment's own in-flight window: `pay` has already released the lock and
   * reported, and this is an ordinary read that happens to be useful right now. It is
   * *not* a retry — nothing is re-sent — and after an `unknown` it is the one piece of
   * evidence available about whether the money left.
   */
  useEffect(() => {
    if (!lastPayment) return;
    if (lastPayment.kind !== "paid" && lastPayment.kind !== "unknown") return;
    const call = context();
    if (!call) return;
    void readBalance(call, false);
  }, [lastPayment, context, readBalance]);

  const createInvoice = useCallback(
    async (input: { amountSats: number; description?: string }) => {
      const call = context();
      if (!call || inFlight.current) return;
      inFlight.current = true;
      setPending("invoice");
      setError(undefined);
      setInvoiceStatus(undefined);
      try {
        const result: WalletCallResult<WalletInvoice> = await makeInvoice(
          call,
          {
            // The only sanctioned sat → msat conversion. A plain ×1000 here would be the
            // 1000× bug the branded type exists to make impossible.
            amount: msatFromSat(input.amountSats),
            ...(input.description ? { description: input.description } : {}),
          },
        );
        if (result.kind === "ok") setInvoice(result.value);
        else setError(result.message);
      } finally {
        inFlight.current = false;
        setPending(undefined);
      }
    },
    [context],
  );

  const checkInvoice = useCallback(async () => {
    const call = context();
    if (!call || !invoice || inFlight.current) return;
    inFlight.current = true;
    setPending("lookup");
    setError(undefined);
    try {
      const result = await lookupInvoice(call, {
        ...(invoice.paymentHash ? { paymentHash: invoice.paymentHash } : {}),
        invoice: invoice.invoice,
      });
      if (result.kind === "ok") setInvoiceStatus(result.value);
      else setError(result.message);
    } finally {
      inFlight.current = false;
      setPending(undefined);
    }
  }, [context, invoice]);

  const loadTransactions = useCallback(async () => {
    const call = context();
    if (!call || inFlight.current) return;
    inFlight.current = true;
    setPending("transactions");
    setError(undefined);
    try {
      const result = await listTransactions(call, { limit: TRANSACTION_PAGE });
      if (result.kind === "ok") setTransactions(result.value);
      else setError(result.message);
    } finally {
      inFlight.current = false;
      setPending(undefined);
    }
  }, [context]);

  const supports = useCallback(
    (method: string) => !methodRuledOut(unlocked.methods, method),
    [unlocked.methods],
  );

  return {
    state,
    balance,
    methods: unlocked.methods,
    supports,
    pending,
    busy: pending !== undefined,
    error,
    connect,
    unlock,
    lock,
    refresh,
    disconnect,
    dismissError: () => setError(undefined),
    pay,
    lastPayment,
    clearPayment: () => setLastPayment(undefined),
    createInvoice,
    invoice,
    invoiceStatus,
    checkInvoice,
    clearInvoice: () => {
      setInvoice(undefined);
      setInvoiceStatus(undefined);
    },
    transactions,
    loadTransactions,
  };
}
