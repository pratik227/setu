import { DexieEventStore, resetAccountScope } from "@setu/core";
import {
  decryptSecretKey,
  encryptSecretKey,
  getNip07Provider,
  type Hex32,
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
import { clearReadMarks } from "../chat/readMarks";
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

/**
 * What sign-out managed to do about the previous account's local data.
 *
 * Reported rather than thrown, and the two outcomes are never merged. "Signed out
 * and the events are gone" and "signed out, but this account's notes, profile cache
 * and private-message wraps are still on this device" are different facts about a
 * shared computer, and only the second one asks anything of the user.
 */
export type SignOutCleanup =
  | { readonly status: "cleared" }
  | { readonly status: "left-behind"; readonly reason: string };

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
  /**
   * Outcome of the last sign-out's local-data cleanup, once it has finished.
   *
   * Undefined before the first sign-out and while one is in flight. Worth surfacing
   * when it says `left-behind`: the user asked for their account to be removed from
   * this device and part of it was not.
   */
  readonly lastSignOut: SignOutCleanup | undefined;
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

/**
 * How long to wait for the browser to drop the database before giving up on it.
 *
 * An IndexedDB deletion is *blocked*, not failed, while any connection to the
 * database is open — including one in another tab of this origin — and a blocked
 * request reports nothing at all: no error, no completion. Without a deadline a
 * sign-out on a second tab would leave this promise pending for the life of the
 * page and the user would never be told either way.
 */
const DATABASE_DELETE_TIMEOUT_MS = 5000;

/**
 * Tears down the account's long-lived objects, then deletes its database.
 *
 * The order is the entire content of this function.
 *
 *  1. `resetAccountScope` runs the resets registered with it — the engine, then the
 *     store (see `EngineProvider`). The store goes *after* the engine because the
 *     engine's subscriptions hold observers on it: dropping the store first leaves a
 *     live query firing against a closed handle. And it goes at all because the
 *     deletion waits on every connection still open to the database. Dexie does
 *     close its own instances when it sees a deletion coming — an ingest batch
 *     flushing a frame late can reopen one, which is the "was blocked" notice in the
 *     console — but that only rescues handles Dexie knows about, and the pool has to
 *     stop feeding it either way.
 *  2. Only then is the database deleted, through a throwaway handle: nothing up here
 *     holds a reference to the store the provider built, and a second connection
 *     opened purely to drop the database is harmless once the first one is closed.
 *
 * The registry snapshot is taken by the `resetAccountScope()` call below, which runs
 * synchronously with this function's first line — deliberately, because by the time
 * React has re-rendered the tree without an account the provider has registered the
 * *signed-out* engine under the same names, and resetting that one would close a
 * pool the login screen is about to use.
 *
 * Nothing here throws. The caller has already signed the user out; a failure to
 * tidy up is something to report, not something to undo a sign-out over.
 */
async function discardAccountData(
  pubkey: string | undefined,
): Promise<SignOutCleanup> {
  const report = await resetAccountScope();
  const failed = report.failures.map((failure) => failure.name);

  // Cleared before the database, and unconditionally: read marks are keyed by
  // account and cost nothing to remove, so there is no reason for them to be
  // contingent on IndexedDB cooperating.
  clearReadMarks(pubkey);

  // No pubkey means no database was ever opened for this session: a signed-out
  // session gets an in-memory store, on purpose, so there is nothing on disk to
  // attribute to anyone (see `EngineProvider`).
  if (pubkey === undefined) {
    return failed.length === 0
      ? { status: "cleared" }
      : {
          status: "left-behind",
          reason: `Setu could not shut down ${failed.join(", ")} while signing out.`,
        };
  }

  try {
    await Promise.race([
      new DexieEventStore({ accountPubkey: pubkey as Hex32 }).destroy(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "the browser did not finish deleting it — another tab may still have it open",
              ),
            ),
          DATABASE_DELETE_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (error) {
    return {
      status: "left-behind",
      reason: `Signed out, but this account's stored events are still on this device: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return failed.length === 0
    ? { status: "cleared" }
    : {
        status: "left-behind",
        // The database is gone, so the events are — but something refused to close,
        // and a half-torn-down scope is worth saying out loud rather than rounding
        // down to success.
        reason: `The stored events were deleted, but ${failed.join(", ")} did not shut down cleanly.`,
      };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | undefined>();
  const [locked, setLocked] = useState<StoredSession | undefined>();
  const [nip07Available, setNip07Available] = useState(false);
  const [lastSignOut, setLastSignOut] = useState<SignOutCleanup | undefined>();

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

  /*
   * Signing out removes the account from this device, not just from this tab.
   *
   * The session record goes first and unconditionally: a sign-out that fails and
   * leaves the user signed in is a worse outcome than one that leaves a database
   * behind, so nothing that can fail runs before the session is gone. The stored
   * data then goes too — notes, profile cache, private-message wraps and the
   * conversation read marks used to stay on the origin until the browser was
   * cleared, which on a shared computer is the previous user's whole timeline, and
   * a list of who they messaged, sitting under the login screen.
   */
  const signOut = useCallback(() => {
    const previous = session?.pubkey;
    clearSession();
    setLocked(undefined);
    setSession(undefined);
    setLastSignOut(undefined);
    void discardAccountData(previous).then(setLastSignOut);
  }, [session?.pubkey]);

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
      lastSignOut,
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
      lastSignOut,
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
