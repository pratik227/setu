import {
  decryptSecretKey,
  encryptSecretKey,
  getNip07Provider,
  LocalSigner,
  Nip07Signer,
  type NostrSigner,
  ReadonlySigner,
} from "@setu/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  clearSession,
  loadSession,
  type StoredSession,
  saveSession,
} from "./storage";

export interface Session {
  readonly signer: NostrSigner;
  readonly pubkey: string;
  /** False for a read-only session; gates every compose affordance. */
  readonly canSign: boolean;
}

interface SessionContextValue {
  readonly session: Session | undefined;
  /**
   * A session that exists on disk but needs a passphrase before it can sign.
   * Present on reload for an encrypted identity — by design, since the key is
   * not recoverable without the passphrase.
   */
  readonly locked: StoredSession | undefined;
  readonly nip07Available: boolean;
  signInWithExtension(): Promise<void>;
  /** Import an `nsec`/hex key, encrypting it at rest with `passphrase`. */
  signInWithSecretKey(input: string, passphrase: string): Promise<void>;
  /** Create a brand-new identity. Returns the nsec **once**, for backup. */
  createIdentity(passphrase: string): Promise<{ nsec: string }>;
  /** Watch-only: browse as a pubkey without any signing capability. */
  signInReadonly(pubkeyOrNpub: string): Promise<void>;
  /** Unlock a stored encrypted identity for this tab. */
  unlock(passphrase: string): Promise<boolean>;
  signOut(): void;
}

const SessionContext = createContext<SessionContextValue | undefined>(
  undefined,
);

/** Resolve an npub or hex string to a hex pubkey. */
async function readonlyPubkey(input: string): Promise<string | undefined> {
  const { decodeAny } = await import("@setu/protocol");
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  const ref = decodeAny(trimmed);
  if (ref?.type === "npub") return ref.pubkey;
  if (ref?.type === "nprofile") return ref.pubkey;
  return undefined;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | undefined>();
  const [locked, setLocked] = useState<StoredSession | undefined>();
  const [nip07Available, setNip07Available] = useState(false);

  // Extensions inject `window.nostr` asynchronously, so a single check at mount
  // races them. Poll briefly, then stop — an extension that has not appeared in
  // three seconds is not installed.
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const tick = () => {
      if (cancelled) return;
      if (getNip07Provider()) {
        setNip07Available(true);
        return;
      }
      if (++attempts < 12) setTimeout(tick, 250);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore whatever can be restored without a secret.
  useEffect(() => {
    const stored = loadSession();
    if (!stored) return;

    if (stored.kind === "readonly") {
      setSession({
        signer: ReadonlySigner.fromPubkey(stored.pubkey),
        pubkey: stored.pubkey,
        canSign: false,
      });
      return;
    }

    if (stored.kind === "nip07") {
      // The extension holds the key, so this restores silently and safely.
      const provider = getNip07Provider();
      if (provider) {
        setSession({
          signer: Nip07Signer.fromWindow(),
          pubkey: stored.pubkey,
          canSign: true,
        });
      } else {
        setLocked(stored);
      }
      return;
    }

    // Encrypted: browse read-only until unlocked, so the feed still works while
    // the identity is locked.
    setLocked(stored);
    setSession({
      signer: ReadonlySigner.fromPubkey(stored.pubkey),
      pubkey: stored.pubkey,
      canSign: false,
    });
  }, []);

  const signInWithExtension = useCallback(async () => {
    const signer = Nip07Signer.fromWindow();
    const pubkey = await signer.pubkey();
    saveSession({ kind: "nip07", pubkey });
    setLocked(undefined);
    setSession({ signer, pubkey, canSign: true });
  }, []);

  const adoptLocalSigner = useCallback(
    (signer: LocalSigner, secretKey: string, passphrase: string) => {
      const ncryptsec = encryptSecretKey(secretKey, passphrase);
      if (!ncryptsec) {
        throw new Error("could not encrypt the key for storage");
      }
      return signer.pubkey().then((pubkey) => {
        saveSession({ kind: "encrypted", pubkey, ncryptsec });
        setLocked(undefined);
        setSession({ signer, pubkey, canSign: true });
      });
    },
    [],
  );

  const signInWithSecretKey = useCallback(
    async (input: string, passphrase: string) => {
      const signer = LocalSigner.tryFromSecretKey(input);
      if (!signer) throw new Error("that is not a valid nsec or hex key");
      if (passphrase.length < 8) {
        throw new Error("passphrase must be at least 8 characters");
      }
      await adoptLocalSigner(signer, input, passphrase);
    },
    [adoptLocalSigner],
  );

  const createIdentity = useCallback(
    async (passphrase: string) => {
      if (passphrase.length < 8) {
        throw new Error("passphrase must be at least 8 characters");
      }
      const { generateSecretKey, encodeNsec } = await import("@setu/protocol");
      const secretKey = generateSecretKey();
      const nsec = encodeNsec(secretKey);
      if (!nsec) throw new Error("could not encode the new key");
      const signer = LocalSigner.fromSecretKey(secretKey);
      await adoptLocalSigner(signer, nsec, passphrase);
      // Handed back exactly once. There is no way to recover it later without
      // the passphrase, which is the point of encrypting it.
      return { nsec };
    },
    [adoptLocalSigner],
  );

  const signInReadonly = useCallback(async (input: string) => {
    const pubkey = await readonlyPubkey(input);
    if (!pubkey) throw new Error("that is not a valid npub or hex pubkey");
    saveSession({ kind: "readonly", pubkey });
    setLocked(undefined);
    setSession({
      signer: ReadonlySigner.fromPubkey(pubkey),
      pubkey,
      canSign: false,
    });
  }, []);

  const unlock = useCallback(
    async (passphrase: string) => {
      const stored = locked ?? loadSession();
      if (!stored) return false;

      if (stored.kind === "nip07") {
        if (!getNip07Provider()) return false;
        await signInWithExtension();
        return true;
      }
      if (stored.kind !== "encrypted" || !stored.ncryptsec) return false;

      const secretKey = decryptSecretKey(stored.ncryptsec, passphrase);
      if (!secretKey) return false;

      const signer = LocalSigner.fromSecretKey(secretKey);
      const pubkey = await signer.pubkey();
      // A stored pubkey that disagrees with the decrypted key means the record
      // was tampered with; refuse rather than silently switch identity.
      if (pubkey !== stored.pubkey) return false;

      setLocked(undefined);
      setSession({ signer, pubkey, canSign: true });
      return true;
    },
    [locked, signInWithExtension],
  );

  const signOut = useCallback(() => {
    clearSession();
    setLocked(undefined);
    setSession(undefined);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      locked,
      nip07Available,
      signInWithExtension,
      signInWithSecretKey,
      createIdentity,
      signInReadonly,
      unlock,
      signOut,
    }),
    [
      session,
      locked,
      nip07Available,
      signInWithExtension,
      signInWithSecretKey,
      createIdentity,
      signInReadonly,
      unlock,
      signOut,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}
