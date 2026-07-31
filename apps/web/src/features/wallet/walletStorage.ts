import {
  decryptSecretKey,
  encryptSecretKey,
  parseWalletUri,
  type WalletUriError,
  walletUriMessage,
} from "@setu/protocol";

/**
 * The wallet connection at rest: ciphertext on disk, key only in memory.
 *
 * The stored secret is a **private key that authorises payments**, and unlike an API
 * token it cannot be revoked from this side — only the wallet can cut it off, and only
 * if its owner notices. So it is held the same way an imported `nsec` is: encrypted
 * with NIP-49 under the user's passphrase (`identity/storage.ts` describes the same
 * trade), and decrypted into memory when they unlock.
 *
 * What that buys, concretely: a stolen laptop, a backup of `localStorage`, or a
 * malicious browser extension reading storage gets `ncryptsec1…` and nothing spendable.
 * What it costs: paying needs an unlocked session, and pairing needs a passphrase step.
 * That is the right side of the trade for a key whose blast radius is money.
 *
 * ## What is *not* here
 *
 * The wallet pubkey and its relay list are stored in the clear beside the ciphertext,
 * deliberately. They are not secrets — the pubkey is public by construction and the
 * relays are addresses — and keeping them readable means the pairing UI can say
 * *which* wallet is connected while the session is locked, rather than showing "a
 * wallet is configured, unlock to find out which".
 *
 * ## And never in the settings document
 *
 * `settingsDocument.ts` states that its field list is closed and cannot carry a key.
 * This is the case that rule was written for: syncing a spending key to every relay the
 * account writes to would be an unrecallable compromise. Nothing in this module is
 * reachable from the sync layer.
 */

/** One key per account: two accounts must not share a wallet connection. */
function storageKey(pubkey: string): string {
  return `setu-wallet:${pubkey}`;
}

/** `localStorage`, or undefined where it is blocked. Same guard as `localSettings`. */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Accessing it *throws* on some configurations. A wallet that lives for the
    // session only is a worse product but not a broken one.
    return undefined;
  }
}

/** What is written to disk. `secret` is NIP-49 ciphertext, never a raw key. */
export interface StoredWalletConnection {
  readonly walletPubkey: string;
  readonly relays: readonly string[];
  /** `ncryptsec1…` — the connection secret, encrypted under the user's passphrase. */
  readonly ncryptsec: string;
}

export type WalletSaveError =
  | WalletUriError
  /** The passphrase produced no ciphertext — an empty passphrase, normally. */
  | "encryption-failed";

export type WalletSaveResult =
  | { readonly ok: true; readonly stored: StoredWalletConnection }
  | { readonly ok: false; readonly reason: WalletSaveError };

/**
 * Parse a connection string and store it encrypted.
 *
 * The raw secret exists as a local for the duration of the `encryptSecretKey` call and
 * is never written anywhere, never logged, and never returned to the caller. The
 * success value carries the *ciphertext*, so a caller that renders the result cannot
 * accidentally render the key.
 */
export function saveWalletConnection(
  accountPubkey: string,
  uri: string,
  passphrase: string,
): WalletSaveResult {
  const parsed = parseWalletUri(uri);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  /*
   * An empty passphrase is refused here, not left to NIP-49.
   *
   * `encryptSecretKey("")` succeeds and returns a perfectly well-formed
   * `ncryptsec1…` — scrypt over an empty string is still a key. But that ciphertext is
   * openable by anyone who tries the empty passphrase first, which makes it plaintext
   * with extra steps. For an identity key that would be bad; for a key that authorises
   * payments it is the whole threat model gone, so the refusal is explicit and the
   * storage layer owns it rather than trusting every caller to check.
   */
  if (passphrase.trim() === "") {
    return { ok: false, reason: "encryption-failed" };
  }

  const ncryptsec = encryptSecretKey(parsed.connection.secret, passphrase);
  if (!ncryptsec) return { ok: false, reason: "encryption-failed" };

  const stored: StoredWalletConnection = {
    walletPubkey: parsed.connection.walletPubkey,
    relays: parsed.connection.relays,
    ncryptsec,
  };
  try {
    storage()?.setItem(storageKey(accountPubkey), JSON.stringify(stored));
  } catch {
    // Quota or a disabled store. Reported as success anyway: the returned connection
    // is usable for this session, which is more useful than refusing to pair at all.
  }
  return { ok: true, stored };
}

/**
 * The stored connection for an account, or undefined.
 *
 * Validated field by field rather than cast. A corrupt row must read as "no wallet
 * configured" — the alternative is a connection whose relay list is not an array,
 * which would throw somewhere inside the transport rather than at the read.
 */
export function readWalletConnection(
  accountPubkey: string | undefined,
): StoredWalletConnection | undefined {
  if (!accountPubkey) return undefined;
  const raw = storage()?.getItem(storageKey(accountPubkey));
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = parsed as Record<string, unknown>;
    if (typeof value.walletPubkey !== "string") return undefined;
    if (typeof value.ncryptsec !== "string") return undefined;
    if (!value.ncryptsec.startsWith("ncryptsec1")) return undefined;
    if (!Array.isArray(value.relays)) return undefined;
    const relays = value.relays.filter(
      (relay): relay is string => typeof relay === "string" && relay !== "",
    );
    if (relays.length === 0) return undefined;
    return {
      walletPubkey: value.walletPubkey,
      relays,
      ncryptsec: value.ncryptsec,
    };
  } catch {
    return undefined;
  }
}

/**
 * Decrypt the connection secret with a passphrase.
 *
 * Returns the raw key bytes, which the caller must hold in memory and not persist. The
 * failure case is `undefined` and it means "wrong passphrase or corrupt ciphertext" —
 * those are indistinguishable by design in NIP-49, and telling them apart is not worth
 * an oracle.
 */
export function unlockWalletSecret(
  stored: StoredWalletConnection,
  passphrase: string,
): Uint8Array | undefined {
  return decryptSecretKey(stored.ncryptsec, passphrase);
}

/**
 * Forget an account's wallet connection.
 *
 * Removes the row rather than blanking a field: a `ncryptsec` left behind is still a
 * spending key waiting for a passphrase guess, and "I disconnected my wallet" should
 * mean the ciphertext is gone from this device.
 */
export function forgetWalletConnection(
  accountPubkey: string | undefined,
): void {
  if (!accountPubkey) return;
  try {
    storage()?.removeItem(storageKey(accountPubkey));
  } catch {
    // Unremovable storage cannot be helped here; the caller reports it as data left
    // behind, the same way `accountData.ts` does for a database that would not drop.
  }
}

/** Reader-facing copy for a failed save. Never echoes the connection string. */
export function walletSaveMessage(reason: WalletSaveError): string {
  if (reason === "encryption-failed") {
    return "Setu could not encrypt the connection secret. A passphrase is required to store it.";
  }
  // Every other reason is a URI problem, and `walletUriMessage` already words those
  // without repeating the input back — which is the whole reason parsing returns a
  // code instead of throwing a message containing a live spending key.
  return walletUriMessage(reason);
}
