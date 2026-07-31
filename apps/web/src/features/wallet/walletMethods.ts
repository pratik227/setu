import { type Msat, msat } from "@setu/protocol";

/**
 * Reading the result bodies of the paying NIP-47 methods.
 *
 * `nip47.ts` parses the envelope — `ok` versus a refusal — and stops there, because the
 * per-method payloads are an app-layer concern. This is that layer, and it exists as a
 * separate pure module for one reason: these functions decide what a *number from a
 * stranger's wallet service* is allowed to become, and that is worth testing without a
 * relay, a hook or a render in the way.
 *
 * Three rules run through all of it:
 *
 *  - **A missing field is `undefined`, never a zero and never a default.** The failure
 *    mode is a wallet that answered without an amount being rendered as a transaction of
 *    0 sats, or an unsettled invoice being drawn as paid. Both are statements about
 *    someone's money that nothing in the reply supports.
 *  - **Amounts go through `msat()`.** Not a cast. The branded type is the only thing
 *    standing between a sat figure and a 1000× payment, and a `value as Msat` here would
 *    quietly let an unvalidated `-1` or `1.5` through into arithmetic the UI trusts.
 *  - **Settlement is only ever read, never inferred.** `state: "settled"` or a real
 *    `settled_at` — anything else is `"pending"` at best and `"unknown"` at worst.
 */

/**
 * A non-negative integer msat from an untrusted field.
 *
 * Floored rather than rounded: every amount here is either being displayed or summed,
 * and rounding a fractional msat up reports a payment as larger than it was. (Rounding
 * is right in `msatFromSat`, where the input is a user's sat figure and rounding down
 * would underpay — the two directions are not inconsistent, they are the same rule
 * applied to the direction the error can hurt.)
 */
function msatField(value: unknown): Msat | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return msat(Math.floor(value));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A unix-seconds timestamp, or undefined. Zero counts as absent, not as 1970. */
function timeField(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value <= 0) return undefined;
  return Math.floor(value);
}

/** What a `pay_invoice` success says. Both fields are optional in the wild. */
export interface WalletPaymentReceipt {
  /**
   * Proof of payment. Wallets are supposed to return it and most do; its absence is
   * not evidence the payment did not happen, so it does not downgrade the outcome.
   */
  readonly preimage?: string;
  readonly feesPaid?: Msat;
}

export function paymentFromResult(
  result: Record<string, unknown>,
): WalletPaymentReceipt {
  const preimage = stringField(result.preimage);
  const feesPaid = msatField(result.fees_paid);
  return {
    ...(preimage !== undefined ? { preimage } : {}),
    ...(feesPaid !== undefined ? { feesPaid } : {}),
  };
}

/** An invoice the wallet minted for us to be paid through. */
export interface WalletInvoice {
  /** The BOLT11 string. Required — without it there is nothing to be paid. */
  readonly invoice: string;
  readonly paymentHash?: string;
  readonly amount?: Msat;
  readonly description?: string;
  readonly createdAt?: number;
  readonly expiresAt?: number;
}

/**
 * The invoice from a `make_invoice` result, or `undefined`.
 *
 * `undefined` when the `invoice` field is missing, even if every other field arrived:
 * a "created" invoice with no BOLT11 string cannot be shown to anyone or paid by
 * anyone, and rendering the surrounding metadata as a successful receive would be an
 * invitation to wait for money that can never arrive.
 */
export function invoiceFromResult(
  result: Record<string, unknown>,
): WalletInvoice | undefined {
  const invoice = stringField(result.invoice);
  if (invoice === undefined) return undefined;
  const paymentHash = stringField(result.payment_hash);
  const amount = msatField(result.amount);
  const description = stringField(result.description);
  const createdAt = timeField(result.created_at);
  const expiresAt = timeField(result.expires_at);
  return {
    invoice,
    ...(paymentHash !== undefined ? { paymentHash } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/**
 * Where a payment got to.
 *
 * `"unknown"` is a real member and not a stand-in for pending: a wallet that reports
 * neither a state nor a settlement time has told us nothing, and the row has to say so
 * rather than pick the friendlier of the two guesses.
 */
export type WalletTransactionState =
  | "settled"
  | "pending"
  | "failed"
  | "expired"
  | "unknown";

/**
 * One entry from `list_transactions`, or the answer to `lookup_invoice`.
 *
 * `direction` carries `"unknown"` for the same reason: a wallet that omits `type` has
 * not said whether money came in or went out, and drawing an unlabelled row as incoming
 * would show a credit that may have been a debit.
 */
export interface WalletTransaction {
  readonly direction: "incoming" | "outgoing" | "unknown";
  readonly state: WalletTransactionState;
  readonly amount?: Msat;
  readonly feesPaid?: Msat;
  readonly description?: string;
  readonly invoice?: string;
  readonly paymentHash?: string;
  readonly preimage?: string;
  readonly createdAt?: number;
  readonly settledAt?: number;
}

function directionOf(value: unknown): WalletTransaction["direction"] {
  if (value === "incoming" || value === "outgoing") return value;
  return "unknown";
}

function stateOf(record: Record<string, unknown>): WalletTransactionState {
  const declared = record.state;
  if (
    declared === "settled" ||
    declared === "pending" ||
    declared === "failed" ||
    declared === "expired"
  ) {
    return declared;
  }
  // Older wallets predate the `state` field and only report a settlement time. A
  // present `settled_at` is conclusive; its absence is not, so this falls to
  // "unknown" rather than "pending".
  return timeField(record.settled_at) !== undefined ? "settled" : "unknown";
}

/** One transaction from an untrusted value, or `undefined` if it is not an object. */
export function transactionFromResult(
  value: unknown,
): WalletTransaction | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const amount = msatField(record.amount);
  const feesPaid = msatField(record.fees_paid);
  const description = stringField(record.description);
  const invoice = stringField(record.invoice);
  const paymentHash = stringField(record.payment_hash);
  const preimage = stringField(record.preimage);
  const createdAt = timeField(record.created_at);
  const settledAt = timeField(record.settled_at);
  return {
    direction: directionOf(record.type),
    state: stateOf(record),
    ...(amount !== undefined ? { amount } : {}),
    ...(feesPaid !== undefined ? { feesPaid } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(invoice !== undefined ? { invoice } : {}),
    ...(paymentHash !== undefined ? { paymentHash } : {}),
    ...(preimage !== undefined ? { preimage } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(settledAt !== undefined ? { settledAt } : {}),
  };
}

/**
 * The list from a `list_transactions` result.
 *
 * Unreadable entries are dropped rather than turned into empty rows, and a missing or
 * non-array `transactions` field yields an empty list. The caller distinguishes "the
 * wallet has no history" from "the wallet did not answer" by the outcome kind, not by
 * the length of this array.
 */
export function transactionsFromResult(
  result: Record<string, unknown>,
): readonly WalletTransaction[] {
  const raw = result.transactions;
  if (!Array.isArray(raw)) return [];
  const rows: WalletTransaction[] = [];
  for (const entry of raw) {
    const row = transactionFromResult(entry);
    if (row) rows.push(row);
  }
  return rows;
}

export type InvoiceCheck =
  | { readonly ok: true; readonly invoice: string }
  | { readonly ok: false; readonly message: string };

/**
 * Normalise something a person pasted into a BOLT11 invoice.
 *
 * Two rejections are worth the words rather than letting the wallet answer them, and
 * both are things people actually paste:
 *
 *  - an `lnurl1…` string or a lightning address, which needs an HTTP round trip to
 *    become an invoice and cannot be handed to `pay_invoice` at all;
 *  - anything else, including a truncated copy — a wallet asked to pay it answers with
 *    a refusal 30 seconds later, and the local check is instant and unambiguous.
 *
 * Lowercased because BOLT11 is bech32: a mixed-case string is invalid, an uppercase one
 * is the same invoice, and wallets differ on whether they will take it.
 */
export function readInvoice(raw: string): InvoiceCheck {
  const trimmed = raw
    .trim()
    .replace(/^lightning:/i, "")
    .trim();
  if (trimmed === "") {
    return { ok: false, message: "Paste a Lightning invoice to pay." };
  }
  const invoice = trimmed.toLowerCase();
  if (invoice.startsWith("lnurl")) {
    return {
      ok: false,
      message:
        "That is an LNURL, not an invoice. It has to be turned into an invoice first, which needs a request to the recipient's server.",
    };
  }
  if (invoice.includes("@")) {
    return {
      ok: false,
      message:
        "That is a lightning address, not an invoice. Zap a note or profile to have Setu fetch an invoice for it.",
    };
  }
  // `ln` + a currency prefix + bech32 data. Deliberately loose about the currency so a
  // regtest or signet invoice is payable, and deliberately strict about the charset so
  // a half-copied string is caught here.
  if (!/^ln[a-z0-9]{20,}$/.test(invoice)) {
    return {
      ok: false,
      message:
        "That does not look like a complete BOLT11 invoice. Check whether the whole string was copied.",
    };
  }
  return { ok: true, invoice };
}
