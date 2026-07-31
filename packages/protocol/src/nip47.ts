/**
 * NIP-47 Nostr Wallet Connect: the protocol half.
 *
 * A wallet service listens on a relay for encrypted requests signed by a key the
 * user handed to this client, and answers with encrypted responses. That makes this
 * the only part of Setu where an event this client signs can *move money*, and the
 * three rules below exist because of that rather than because of the wire format.
 *
 * ## The connection secret is a spending key
 *
 * `nostr+walletconnect://<wallet-pubkey>?relay=…&secret=<32 bytes hex>` — and that
 * secret is a full private key whose signature authorises payments up to whatever
 * budget the wallet set. It is not an API token that can be revoked from this side.
 * So:
 *
 *  - it is never logged, never put in an error message, and never included in a
 *    thrown error's text (see {@link parseWalletUri}, which reports *where* a URI is
 *    malformed without echoing it);
 *  - it must never enter the NIP-78 settings document. `settingsDocument.ts` already
 *    states that its field list is closed and cannot carry a key — this is the exact
 *    thing that rule was written for;
 *  - it is a *different key from the user's identity*. Requests are signed by the
 *    connection secret, not by the account, which is what stops a wallet service
 *    from learning which npub is paying.
 *
 * ## Amounts are millisatoshis, and the type says so
 *
 * Every amount on this wire is msat. A sat/msat mix-up is not an off-by-one, it is a
 * factor of a thousand in a payment — the kind of bug that is discovered by the user
 * losing money. So amounts are branded ({@link Msat}) and the only ways to obtain one
 * are {@link msatFromSat} and {@link msat}, which makes an unconverted sat figure a
 * compile error rather than a silent 1000× underpayment.
 *
 * ## A missing response is not a failure
 *
 * A wallet that never answers and a wallet that refuses are different facts, and only
 * one of them means the payment did not happen. This module models the reply as
 * `ok | error` and leaves *timeout* to the caller, which must treat it as unknown —
 * never as "not paid". Retrying a pay_invoice you cannot account for is how a payment
 * gets made twice.
 *
 * Nothing here does I/O, encryption or signing: it builds and parses. The transport,
 * the NIP-44 calls and the timeout policy belong to the app layer.
 */

import { isHex32, isHexOfBytes } from "./hex";
import type { EventTemplate, Hex32, NostrEvent } from "./types";

/** Wallet service capability announcement (public, unencrypted content). */
export const WALLET_INFO_KIND = 13194;
/** Client → wallet, encrypted. */
export const WALLET_REQUEST_KIND = 23194;
/** Wallet → client, encrypted. */
export const WALLET_RESPONSE_KIND = 23195;
/** Wallet → client notification, NIP-04 encrypted. */
export const WALLET_NOTIFICATION_NIP04_KIND = 23196;
/** Wallet → client notification, NIP-44 encrypted. */
export const WALLET_NOTIFICATION_NIP44_KIND = 23197;

/**
 * An amount in millisatoshis.
 *
 * Branded on purpose. See the module doc: the whole point is that a `number` holding
 * sats cannot be passed where msat is expected.
 */
export type Msat = number & { readonly __msat: unique symbol };

/** Assert a number is already in msat. Use at the boundary where msat arrives. */
export function msat(value: number): Msat {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RangeError("an msat amount must be a non-negative integer");
  }
  return value as Msat;
}

/** Convert sats to msat. The only sanctioned way to turn a sat figure into one. */
export function msatFromSat(sats: number): Msat {
  if (!Number.isFinite(sats) || sats < 0) {
    throw new RangeError("a sat amount must be a non-negative number");
  }
  // Rounded, not truncated: a fractional sat can only come from a rate conversion,
  // and rounding down there silently underpays by up to a sat every time.
  return msat(Math.round(sats * 1000));
}

/**
 * Whole sats from an msat amount, for display.
 *
 * Floors, and that is the right direction for a *balance*: showing 5 sats when 5.9
 * are spendable is conservative, while showing 6 invites an attempt to send more
 * than the wallet holds.
 */
export function satFromMsat(amount: Msat): number {
  return Math.floor(amount / 1000);
}

/** A parsed `nostr+walletconnect://` URI. */
export interface WalletConnection {
  /** The wallet service's pubkey — the peer requests are encrypted to. */
  readonly walletPubkey: Hex32;
  /** Relays the wallet listens on. At least one; order preserved. */
  readonly relays: readonly string[];
  /**
   * The connection secret: a private key that signs requests.
   *
   * Held as hex because that is how it arrives. Treat it as a credential — see the
   * module doc for the three places it must never go.
   */
  readonly secret: string;
}

export type WalletUriError =
  | "not-a-wallet-uri"
  | "missing-pubkey"
  | "bad-pubkey"
  | "missing-relay"
  | "bad-relay"
  | "missing-secret"
  | "bad-secret";

export type WalletUriResult =
  | { readonly ok: true; readonly connection: WalletConnection }
  | { readonly ok: false; readonly reason: WalletUriError };

/**
 * Parse a wallet connection URI.
 *
 * Returns a *reason code* rather than throwing a message, and the reason never
 * contains any part of the input. That is deliberate: the obvious implementation
 * throws `new Error(\`bad wallet URI: ${uri}\`)`, and the string that lands in a
 * console, a log aggregator or a bug report then contains a live spending key. The
 * caller maps the code to copy (see {@link walletUriMessage}).
 *
 * The scheme is checked without `new URL()` doing the work, because a custom scheme
 * with `//` is parsed inconsistently across engines: some put the pubkey in `hostname`
 * (lowercasing it, which is harmless for hex but not something to rely on) and some
 * leave it in `pathname`. Splitting the string is boring and behaves the same
 * everywhere.
 */
export function parseWalletUri(uri: string): WalletUriResult {
  const trimmed = uri.trim();
  const schemes = ["nostr+walletconnect://", "nostrwalletconnect://"];
  const scheme = schemes.find((candidate) =>
    trimmed.toLowerCase().startsWith(candidate),
  );
  if (scheme === undefined) return { ok: false, reason: "not-a-wallet-uri" };

  const rest = trimmed.slice(scheme.length);
  const queryAt = rest.indexOf("?");
  const rawPubkey = (queryAt === -1 ? rest : rest.slice(0, queryAt))
    // A trailing slash before the query is legal and common.
    .replace(/\/+$/, "");
  if (rawPubkey === "") return { ok: false, reason: "missing-pubkey" };

  // Lowercased before validating: hex is case-insensitive and some wallets emit
  // uppercase, but every comparison downstream (and every filter) is lowercase.
  const walletPubkey = rawPubkey.toLowerCase();
  if (!isHex32(walletPubkey)) return { ok: false, reason: "bad-pubkey" };

  const params = new URLSearchParams(
    queryAt === -1 ? "" : rest.slice(queryAt + 1),
  );

  const relays: string[] = [];
  for (const value of params.getAll("relay")) {
    const relay = value.trim();
    if (relay === "") continue;
    if (!/^wss?:\/\//i.test(relay)) return { ok: false, reason: "bad-relay" };
    if (!relays.includes(relay)) relays.push(relay);
  }
  if (relays.length === 0) return { ok: false, reason: "missing-relay" };

  const rawSecret = params.get("secret");
  if (rawSecret === null || rawSecret.trim() === "") {
    return { ok: false, reason: "missing-secret" };
  }
  const secret = rawSecret.trim().toLowerCase();
  // 32 bytes exactly. An nsec would also be a valid key but a different encoding,
  // and accepting both here would mean guessing which one a caller handed us.
  if (!isHexOfBytes(secret, 32)) return { ok: false, reason: "bad-secret" };

  return {
    ok: true,
    connection: { walletPubkey: walletPubkey as Hex32, relays, secret },
  };
}

/** Reader-facing copy for a rejected URI. Never echoes the input. */
export function walletUriMessage(reason: WalletUriError): string {
  switch (reason) {
    case "not-a-wallet-uri":
      return "That is not a wallet connection string. It should begin with nostr+walletconnect://";
    case "missing-pubkey":
    case "bad-pubkey":
      return "That connection string does not name a wallet service correctly.";
    case "missing-relay":
      return "That connection string names no relay, so there is nowhere to reach the wallet.";
    case "bad-relay":
      return "That connection string names a relay that is not a wss:// address.";
    case "missing-secret":
      return "That connection string carries no secret, so Setu cannot authorise anything with it.";
    case "bad-secret":
      return "That connection string's secret is not a 32-byte key.";
  }
}

/**
 * The methods this client will ask for.
 *
 * A closed list rather than `string`: a request is a signed, encrypted event that may
 * move money, and "whatever the caller typed" is not a category of thing worth being
 * able to send.
 */
export type WalletMethod =
  | "get_info"
  | "get_balance"
  | "pay_invoice"
  | "make_invoice"
  | "lookup_invoice"
  | "list_transactions";

/** A request payload, before encryption. */
export interface WalletRequest {
  readonly method: WalletMethod;
  readonly params: Record<string, unknown>;
}

/** `{"method":…,"params":…}` — the plaintext to encrypt to the wallet. */
export function walletRequestPayload(request: WalletRequest): string {
  return JSON.stringify({ method: request.method, params: request.params });
}

/**
 * The event that carries an already-encrypted request.
 *
 * `content` is ciphertext the caller produced; this function never encrypts, so it
 * cannot accidentally send plaintext. The `p` tag is what lets the wallet's
 * subscription find the request at all.
 */
export function buildWalletRequest(input: {
  readonly walletPubkey: Hex32;
  readonly content: string;
  readonly createdAt: number;
  /** Set when the request was encrypted with NIP-44 rather than NIP-04. */
  readonly nip44?: boolean;
  /**
   * NIP-40 deadline, so a request the wallet never read does not sit on the relay
   * indefinitely waiting to be replayed. Strongly recommended for pay_invoice.
   */
  readonly expiration?: number;
}): EventTemplate {
  const tags: string[][] = [["p", input.walletPubkey]];
  if (input.nip44) tags.push(["encryption", "nip44_v2"]);
  if (input.expiration !== undefined) {
    tags.push(["expiration", String(Math.floor(input.expiration))]);
  }
  return {
    kind: WALLET_REQUEST_KIND,
    created_at: Math.floor(input.createdAt),
    content: input.content,
    tags,
  };
}

/** A wallet's reply, once decrypted. */
export type WalletResponse =
  | {
      readonly ok: true;
      readonly resultType: string;
      readonly result: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly code: WalletErrorCode;
      readonly message: string;
    };

/**
 * NIP-47 error codes.
 *
 * `OTHER` is the documented catch-all, and an unrecognised code maps to it rather
 * than being dropped — a wallet is free to add codes, and treating an unknown one as
 * success would report a failed payment as sent.
 */
export const WALLET_ERROR_CODES = [
  "RATE_LIMITED",
  "NOT_IMPLEMENTED",
  "INSUFFICIENT_BALANCE",
  "QUOTA_EXCEEDED",
  "RESTRICTED",
  "UNAUTHORIZED",
  "INTERNAL",
  "PAYMENT_FAILED",
  "NOT_FOUND",
  "OTHER",
] as const;

export type WalletErrorCode = (typeof WALLET_ERROR_CODES)[number];

function asErrorCode(value: unknown): WalletErrorCode {
  return WALLET_ERROR_CODES.includes(value as WalletErrorCode)
    ? (value as WalletErrorCode)
    : "OTHER";
}

/**
 * Parse a decrypted response body.
 *
 * Anything unparseable is an *error*, never a success with empty fields. The failure
 * mode being guarded is a response whose `result` did not arrive being read as
 * `{ok: true, result: {}}`, which a caller would render as a completed payment of an
 * unknown amount.
 */
export function parseWalletResponse(plaintext: string): WalletResponse {
  let body: unknown;
  try {
    body = JSON.parse(plaintext);
  } catch {
    return {
      ok: false,
      code: "OTHER",
      message: "The wallet's reply was not readable.",
    };
  }
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      code: "OTHER",
      message: "The wallet's reply was not readable.",
    };
  }

  const record = body as Record<string, unknown>;

  // Checked before `result`, and this order is load-bearing: a wallet may send both
  // fields with `result: null` beside a real error, and reading `result` first would
  // turn a refusal into a success.
  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const detail = error as Record<string, unknown>;
    return {
      ok: false,
      code: asErrorCode(detail.code),
      message:
        typeof detail.message === "string" && detail.message !== ""
          ? detail.message
          : walletErrorMessage(asErrorCode(detail.code)),
    };
  }

  const result = record.result;
  if (typeof result !== "object" || result === null) {
    return {
      ok: false,
      code: "OTHER",
      message: "The wallet replied without a result.",
    };
  }

  return {
    ok: true,
    resultType:
      typeof record.result_type === "string" ? record.result_type : "",
    result: result as Record<string, unknown>,
  };
}

/** Reader-facing copy per error code. */
export function walletErrorMessage(code: WalletErrorCode): string {
  switch (code) {
    case "RATE_LIMITED":
      return "The wallet is rate limiting requests. Try again shortly.";
    case "NOT_IMPLEMENTED":
      return "This wallet does not support that operation.";
    case "INSUFFICIENT_BALANCE":
      return "The wallet does not have enough balance for that payment.";
    case "QUOTA_EXCEEDED":
      return "This connection has reached the spending limit the wallet set for it.";
    case "RESTRICTED":
      return "The wallet refused: this connection is not permitted to do that.";
    case "UNAUTHORIZED":
      return "The wallet did not accept this connection. It may have been revoked.";
    case "INTERNAL":
      return "The wallet reported an internal error.";
    case "PAYMENT_FAILED":
      return "The payment failed and was not sent.";
    case "NOT_FOUND":
      return "The wallet could not find that invoice.";
    case "OTHER":
      return "The wallet refused without giving a reason.";
  }
}

/**
 * Which methods a wallet says it supports, from its kind-13194.
 *
 * The info event's content is a plaintext space-separated list. Parsed rather than
 * assumed because `NOT_IMPLEMENTED` arrives *after* a request has been signed and
 * published — reading the list first means never offering the user a control that can
 * only fail.
 */
export function parseWalletInfo(event: NostrEvent): readonly string[] {
  if (event.kind !== WALLET_INFO_KIND) return [];
  return event.content
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** True when the wallet advertised NIP-44 support for request encryption. */
export function supportsNip44(event: NostrEvent): boolean {
  if (event.kind !== WALLET_INFO_KIND) return false;
  for (const tag of event.tags) {
    if (tag[0] !== "encryption") continue;
    for (const value of tag.slice(1)) {
      if (value?.toLowerCase().startsWith("nip44")) return true;
    }
  }
  return false;
}

/**
 * The balance from a `get_balance` result, in msat.
 *
 * Returns `undefined` rather than 0 when the field is missing or not a number.
 * Showing a zero balance for a wallet that simply did not answer the question is the
 * same class of lie as `formatCount` refusing to print 0 for an uncounted total.
 */
export function balanceFromResult(
  result: Record<string, unknown>,
): Msat | undefined {
  const balance = result.balance;
  if (typeof balance !== "number" || !Number.isFinite(balance)) {
    return undefined;
  }
  if (balance < 0) return undefined;
  return Math.floor(balance) as Msat;
}
