import type { RelayPool } from "@setu/core";
import {
  type Hex32,
  type Msat,
  type WalletErrorCode,
  walletErrorMessage,
} from "@setu/protocol";
import {
  invoiceFromResult,
  paymentFromResult,
  transactionFromResult,
  transactionsFromResult,
  type WalletInvoice,
  type WalletPaymentReceipt,
  type WalletTransaction,
} from "./walletMethods";
import { callWallet, type WalletOutcome } from "./walletTransport";

/**
 * The five NIP-47 verbs, as outcomes a screen can render without lying.
 *
 * `walletTransport` answers "what came back off the wire"; this answers "what does that
 * mean for the money", and the whole reason it is a layer of its own is the third case
 * below. Every verb here resolves to exactly one of four kinds:
 *
 *  - **`ok`** — the wallet answered and the answer parsed.
 *  - **`refused`** — the wallet answered *no*. For a payment this is the good failure:
 *    nothing was sent, and the user can act on the reason.
 *  - **`unknown`** — nothing came back in time. **This is not a failure.** The request
 *    was signed, encrypted and accepted by a relay, so for `pay_invoice` the wallet may
 *    have paid, may be paying now, or may never have seen it. There is no local fact
 *    that distinguishes those, and there is no way to find out except to look at the
 *    wallet. It must be rendered as unresolved — never "failed", never "sent".
 *  - **`failed`** — a *local* dead end: no unlocked secret, an unusable stored key, or
 *    no relay accepted the request. Conclusive, because nothing was published.
 *
 * ## Nothing in this module retries, and nothing above it may either
 *
 * There is no retry, no backoff and no "one more attempt" on any path, and that is
 * deliberate for `pay_invoice` specifically: an automatic second attempt after an
 * `unknown` is how a person pays twice for one thing. Trying again is a decision that
 * belongs to someone who has looked at their wallet and knows the first attempt did not
 * land. The read verbs are safe to call again, but they are not called again from here
 * either — a caller that wants a second look asks for one.
 *
 * ## Why a payment gets its own, longer deadline
 *
 * A Lightning payment can take a while: the wallet has to find a route and wait for the
 * hops. Cutting it off at the balance-read timeout would manufacture the one outcome
 * nobody can resolve — an `unknown` for a payment that was merely slow. So paying waits
 * {@link PAY_TIMEOUT_MS}, which trades a longer spinner for fewer unanswerable states.
 */

/**
 * How long to wait for a `pay_invoice` reply.
 *
 * Twice the general timeout. See the module doc: the cost of waiting is a spinner, the
 * cost of giving up early is a payment whose fate cannot be determined.
 */
export const PAY_TIMEOUT_MS = 60_000;

/** How many transactions to ask for when the caller does not say. */
export const TRANSACTION_PAGE = 20;

/** Everything a call needs except the method. Assembled once per surface. */
export interface WalletCallContext {
  readonly pool: RelayPool;
  readonly walletPubkey: Hex32;
  readonly relays: readonly string[];
  /** Raw connection secret, read from the session store at call time. */
  readonly secret: Uint8Array;
  readonly nip44?: boolean;
}

export type WalletCallResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "refused";
      readonly code: WalletErrorCode;
      readonly message: string;
    }
  /** No reply. The request was published, so the wallet may still have acted. */
  | { readonly kind: "unknown"; readonly message: string }
  /** Nothing was published, so nothing happened. */
  | { readonly kind: "failed"; readonly message: string };

/**
 * A payment's outcome.
 *
 * `paid` rather than `ok`, because at a call site `ok` is one careless glance away from
 * being read as "the call worked" when what it means is "money left the wallet".
 */
export type PaymentResult =
  | { readonly kind: "paid"; readonly receipt: WalletPaymentReceipt }
  | {
      readonly kind: "refused";
      readonly code: WalletErrorCode;
      readonly message: string;
    }
  | { readonly kind: "unknown"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/** The copy every unresolved payment gets. Non-committal on purpose. */
export const PAYMENT_UNKNOWN_MESSAGE =
  "The wallet did not reply, so Setu cannot tell whether this was paid. Check the wallet before trying again — nothing will be retried automatically.";

/** The same for a read: we learned nothing, and nothing was moved either way. */
const READ_UNKNOWN_MESSAGE =
  "The wallet did not reply in time. Nothing was changed; ask again when you like.";

/**
 * Turn one transport outcome into a result, given a reader for the payload.
 *
 * The reader returning `undefined` is a *refusal*, not an empty success: a reply whose
 * payload could not be read tells us nothing, and the alternative is a screen showing an
 * invoice with no string in it or a settled state nobody reported.
 */
function mapOutcome<T>(
  outcome: WalletOutcome,
  unknownMessage: string,
  read: (result: Record<string, unknown>) => T | undefined,
  emptyMessage: string,
): WalletCallResult<T> {
  switch (outcome.kind) {
    case "timeout":
      return { kind: "unknown", message: unknownMessage };
    case "failed":
      return { kind: "failed", message: outcome.message };
    case "ok": {
      if (!outcome.response.ok) {
        return {
          kind: "refused",
          code: outcome.response.code,
          message:
            outcome.response.message ||
            walletErrorMessage(outcome.response.code),
        };
      }
      const value = read(outcome.response.result);
      if (value === undefined) {
        return { kind: "refused", code: "OTHER", message: emptyMessage };
      }
      return { kind: "ok", value };
    }
  }
}

/**
 * Pay a BOLT11 invoice.
 *
 * The invoice is passed through as given — normalising or re-encoding an invoice on the
 * way to a payment is not this layer's business, and {@link readInvoice} in
 * `walletMethods` is where a pasted string is vetted before it gets here.
 *
 * No `amount` parameter is sent. NIP-47 allows one for zero-amount invoices, but wallets
 * disagree about what it means when the invoice already carries an amount, and "two
 * numbers, one of which the wallet may ignore" is not a shape worth having on a payment
 * request. Zero-amount invoices are refused earlier, where the user can see why.
 */
export async function payInvoice(
  context: WalletCallContext,
  invoice: string,
): Promise<PaymentResult> {
  if (invoice.trim() === "") {
    return { kind: "failed", message: "There is no invoice to pay." };
  }
  const outcome = await callWallet({
    pool: context.pool,
    walletPubkey: context.walletPubkey,
    relays: context.relays,
    secret: context.secret,
    method: "pay_invoice",
    params: { invoice },
    ...(context.nip44 ? { nip44: true } : {}),
    timeoutMs: PAY_TIMEOUT_MS,
  });

  const result = mapOutcome(
    outcome,
    PAYMENT_UNKNOWN_MESSAGE,
    // An `ok` envelope is the wallet stating it paid. A missing preimage does not
    // downgrade that — see `walletMethods` — so the reader cannot fail here.
    (payload) => paymentFromResult(payload),
    "The wallet's reply about the payment could not be read.",
  );
  return result.kind === "ok"
    ? { kind: "paid", receipt: result.value }
    : result;
}

/**
 * Ask the wallet for an invoice to be paid *to* this user.
 *
 * `amount` is msat and branded, so a sat figure cannot arrive here by accident — the
 * caller converts with `msatFromSat`, which is the only place the ×1000 happens.
 */
export async function makeInvoice(
  context: WalletCallContext,
  input: {
    readonly amount: Msat;
    readonly description?: string;
    readonly expirySeconds?: number;
  },
): Promise<WalletCallResult<WalletInvoice>> {
  const outcome = await callWallet({
    pool: context.pool,
    walletPubkey: context.walletPubkey,
    relays: context.relays,
    secret: context.secret,
    method: "make_invoice",
    params: {
      amount: input.amount,
      ...(input.description ? { description: input.description } : {}),
      ...(input.expirySeconds !== undefined
        ? { expiry: Math.floor(input.expirySeconds) }
        : {}),
    },
    ...(context.nip44 ? { nip44: true } : {}),
  });
  return mapOutcome(
    outcome,
    READ_UNKNOWN_MESSAGE,
    invoiceFromResult,
    "The wallet replied without an invoice, so there is nothing to be paid.",
  );
}

/**
 * Look one invoice up, by payment hash or by the invoice itself.
 *
 * This is the honest way to answer "has it been paid?" — and the only one, since a
 * settled invoice produces no event this client subscribes to.
 */
export async function lookupInvoice(
  context: WalletCallContext,
  input: {
    readonly paymentHash?: string;
    readonly invoice?: string;
  },
): Promise<WalletCallResult<WalletTransaction>> {
  if (!input.paymentHash && !input.invoice) {
    return {
      kind: "failed",
      message: "There is nothing to look up: no invoice and no payment hash.",
    };
  }
  const outcome = await callWallet({
    pool: context.pool,
    walletPubkey: context.walletPubkey,
    relays: context.relays,
    secret: context.secret,
    method: "lookup_invoice",
    params: {
      ...(input.paymentHash ? { payment_hash: input.paymentHash } : {}),
      ...(input.invoice ? { invoice: input.invoice } : {}),
    },
    ...(context.nip44 ? { nip44: true } : {}),
  });
  return mapOutcome(
    outcome,
    READ_UNKNOWN_MESSAGE,
    transactionFromResult,
    "The wallet's reply about that invoice could not be read.",
  );
}

/** Recent transactions, newest first as the wallet returns them. */
export async function listTransactions(
  context: WalletCallContext,
  input: { readonly limit?: number; readonly unpaid?: boolean } = {},
): Promise<WalletCallResult<readonly WalletTransaction[]>> {
  const outcome = await callWallet({
    pool: context.pool,
    walletPubkey: context.walletPubkey,
    relays: context.relays,
    secret: context.secret,
    method: "list_transactions",
    params: {
      limit: Math.max(1, Math.floor(input.limit ?? TRANSACTION_PAGE)),
      ...(input.unpaid !== undefined ? { unpaid: input.unpaid } : {}),
    },
    ...(context.nip44 ? { nip44: true } : {}),
  });
  return mapOutcome(
    outcome,
    READ_UNKNOWN_MESSAGE,
    // An empty list is a legitimate answer — a wallet with no history — so the reader
    // returns the array rather than treating emptiness as unreadable.
    (payload) => transactionsFromResult(payload),
    "The wallet's transaction list could not be read.",
  );
}

/** True when a wallet's advertised method list rules a verb out. */
export function methodRuledOut(
  methods: readonly string[],
  method: string,
): boolean {
  // An empty list means "not learnt yet", not "supports nothing": the info event may
  // simply not have arrived. Refusing every verb on an empty list would leave a paired,
  // unlocked wallet with no usable controls at all.
  return methods.length > 0 && !methods.includes(method);
}
