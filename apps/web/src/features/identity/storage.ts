/**
 * What Setu persists about an identity, and what it refuses to.
 *
 * The rule: **a raw signing capability is never written to disk.** A pasted `nsec` is
 * encrypted with the user's passphrase (NIP-49, scrypt) before it touches
 * `localStorage`, and the decrypted bytes live only inside a signer object for
 * the lifetime of the tab. Persisting a plaintext key to `localStorage` puts it
 * within reach of any script that ever runs on the origin, forever.
 *
 * The consequence is deliberate and must not be "fixed" later: an encrypted
 * session cannot be restored silently on reload, because restoring it requires
 * the passphrase. A client that reloads straight into a signing-capable session
 * has, by definition, stored the key in a recoverable form.
 *
 * ## The same rule covers a bunker
 *
 * A NIP-46 connection is a signing capability with a different shape, not a weaker
 * one. Two things could give it away and neither is stored in the clear:
 *
 *  - The **connection secret** from a `bunker://` URI. Used once, during the
 *    handshake, and never written anywhere. {@link saveSession} refuses to persist a
 *    string containing `bunker://` for the same reason it refuses one containing
 *    `nsec1`: a URI on disk carries its `secret=` parameter with it.
 *  - The **client key** the connection is authorised under. Anyone holding it can ask
 *    that bunker to sign for the account, so it is encrypted with a passphrase and
 *    stored in the same `ncryptsec` field an imported `nsec` uses.
 */

const STORAGE_KEY = "setu-session";

/** How the active identity signs. */
export type SessionKind = "nip07" | "encrypted" | "readonly" | "nip46";

/** Where a remote signer lives. Neither field is a secret. */
export interface StoredRemoteSigner {
  /** The signer's key — *not* the account's. See `protocol/signers/nip46/uri.ts`. */
  readonly pubkey: string;
  readonly relays: readonly string[];
}

export interface StoredSession {
  readonly kind: SessionKind;
  /** Always present: the identity's public key, hex. */
  readonly pubkey: string;
  /**
   * NIP-49 `ncryptsec1…`. This is ciphertext; without the passphrase it grants
   * nothing.
   *
   * Present for `kind: "encrypted"` (the account's own key) and for
   * `kind: "nip46"` (the per-connection client key). One field, because in both
   * cases it is "the secret this session signs with, encrypted at rest".
   */
  readonly ncryptsec?: string;
  /** Present only for `kind: "nip46"`. */
  readonly remoteSigner?: StoredRemoteSigner;
}

function isRemoteSigner(value: unknown): value is StoredRemoteSigner {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(v.pubkey)) {
    return false;
  }
  return (
    Array.isArray(v.relays) &&
    v.relays.length > 0 &&
    v.relays.every((relay) => typeof relay === "string" && relay.length > 0)
  );
}

export function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(v.pubkey)) {
    return false;
  }
  if (
    v.kind !== "nip07" &&
    v.kind !== "encrypted" &&
    v.kind !== "readonly" &&
    v.kind !== "nip46"
  ) {
    return false;
  }
  const hasKey =
    typeof v.ncryptsec === "string" && v.ncryptsec.startsWith("ncryptsec1");
  if (v.kind === "encrypted") return hasKey;
  // A nip46 record without both halves cannot be resumed, and a half-record that
  // restores as "signed in" would give a session that can never sign.
  if (v.kind === "nip46") return hasKey && isRemoteSigner(v.remoteSigner);
  return true;
}

export function loadSession(): StoredSession | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isStoredSession(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reject anything that would write a signing capability in the clear.
 *
 * A guard rather than trust in the caller: a bug that puts an `nsec` or a whole
 * `bunker://` URI into one of these objects would silently persist the ability to
 * sign as this account, which is the one outcome this module exists to prevent.
 */
export function assertPersistable(value: unknown): void {
  const json = JSON.stringify(value);
  if (json.includes("nsec1")) {
    throw new Error("refusing to persist a plaintext secret key");
  }
  if (json.includes("bunker://")) {
    throw new Error(
      "refusing to persist a bunker URI, which carries its secret",
    );
  }
}

export function saveSession(session: StoredSession): void {
  try {
    assertPersistable(session);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch (error) {
    // Storage may be unavailable (private mode, quota). The session still works
    // for this tab; it just will not be remembered.
    if (error instanceof Error && error.message.startsWith("refusing"))
      throw error;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — the in-memory session is cleared by the caller regardless.
  }
}
