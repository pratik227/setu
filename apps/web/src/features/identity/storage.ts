/**
 * What Setu persists about an identity, and what it refuses to.
 *
 * The rule: **a raw secret key is never written to disk.** A pasted `nsec` is
 * encrypted with the user's passphrase (NIP-49, scrypt) before it touches
 * `localStorage`, and the decrypted bytes live only inside a signer object for
 * the lifetime of the tab. Persisting a plaintext key to `localStorage` puts it
 * within reach of any script that ever runs on the origin, forever.
 *
 * The consequence is deliberate and must not be "fixed" later: an encrypted
 * session cannot be restored silently on reload, because restoring it requires
 * the passphrase. A client that reloads straight into a signing-capable session
 * has, by definition, stored the key in a recoverable form.
 */

const STORAGE_KEY = "setu-session";

/** How the active identity signs. */
export type SessionKind = "nip07" | "encrypted" | "readonly";

export interface StoredSession {
  readonly kind: SessionKind;
  /** Always present: the identity's public key, hex. */
  readonly pubkey: string;
  /**
   * NIP-49 `ncryptsec1…`. Present only for `kind: "encrypted"`. This is
   * ciphertext; without the passphrase it grants nothing.
   */
  readonly ncryptsec?: string;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(v.pubkey)) {
    return false;
  }
  if (v.kind !== "nip07" && v.kind !== "encrypted" && v.kind !== "readonly") {
    return false;
  }
  if (v.kind === "encrypted") {
    return (
      typeof v.ncryptsec === "string" && v.ncryptsec.startsWith("ncryptsec1")
    );
  }
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

export function saveSession(session: StoredSession): void {
  try {
    // Guard rather than trust the caller: a bug that puts an nsec in this object
    // would silently write a plaintext key to disk, which is the one outcome
    // this module exists to prevent.
    if (JSON.stringify(session).includes("nsec1")) {
      throw new Error("refusing to persist a plaintext secret key");
    }
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
