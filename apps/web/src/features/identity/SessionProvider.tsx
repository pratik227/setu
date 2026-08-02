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
  useRef,
  useState,
} from "react";
import {
  discardAccountData,
  discardInactiveAccountData,
  type SignOutCleanup,
} from "./accountData";
import {
  findAccount,
  forgetAccount,
  loadAccounts,
  rememberAccount,
  type StoredAccount,
} from "./accounts";
import { rememberScheme } from "./rememberScheme";
import {
  connectToBunker,
  inviteRemoteSigner,
  type RemoteConnection,
  resumeBunker,
} from "./remoteSigner";
import { seedPhraseSignIn } from "./seedPhraseSignIn";
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

// Re-exported so consumers keep importing the session vocabulary from one place.
export type { SignOutCleanup };

/** An outstanding `nostrconnect://` invitation, for the login screen to display. */
export interface RemoteInviteHandle {
  /** Show this as a QR code or a copyable string. It contains a secret. */
  readonly uri: string;
  /** Resolves once a signer has been adopted and the session is live. */
  readonly completed: Promise<void>;
  cancel(): void;
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
  /**
   * Whether a remote signer has stopped answering, when one is in use.
   *
   * `undefined` for every other session kind — a local key cannot be unreachable.
   * The keep-alive already makes a dead connection *fail fast* instead of costing a
   * full request deadline; this is what lets a surface say so before the user
   * discovers it by trying to post.
   */
  readonly signerHealth: "alive" | "unreachable" | undefined;
  /**
   * Every identity this device remembers, oldest first.
   *
   * Saved credentials, not live sessions: exactly one account is signed in at a
   * time, because there is one engine, one relay pool and one store, all keyed to
   * the active pubkey. Nothing is fetched for the others.
   */
  readonly accounts: readonly StoredAccount[];
  signInWithExtension(): Promise<void>;
  /** Import an `nsec`/hex key, encrypting it at rest with `passphrase`. */
  signInWithSecretKey(input: string, passphrase: string): Promise<void>;
  /**
   * Sign in from a BIP-39 recovery phrase (NIP-06).
   *
   * Separate from `signInWithSecretKey` rather than another accepted format,
   * because the failures are different and must be reported differently: a bad
   * `nsec` cannot be decoded at all, while a mistyped phrase word *derives a
   * perfectly valid key for the wrong account* unless the checksum is checked
   * first. Merging them would flatten that into "invalid key".
   */
  signInWithSeedPhrase(phrase: string, passphrase: string): Promise<void>;
  /** Create a brand-new identity. Returns the nsec **once**, for backup. */
  createIdentity(passphrase: string): Promise<{ nsec: string }>;
  /** Watch-only: browse as a pubkey without any signing capability. */
  signInReadonly(pubkeyOrNpub: string): Promise<void>;
  /**
   * Connect to a NIP-46 signer from a `bunker://` URI.
   *
   * `passphrase` encrypts the per-connection client key at rest. The URI's own
   * `secret` is used for the handshake and never stored.
   */
  signInWithBunker(uri: string, passphrase: string): Promise<void>;
  /** The other direction: publish a `nostrconnect://` URI for a signer to adopt. */
  beginRemoteInvite(
    passphrase: string,
    relays?: readonly string[],
  ): RemoteInviteHandle;
  /** Unlock a stored encrypted identity for this tab. */
  unlock(passphrase: string): Promise<boolean>;
  signOut(): void;
  /**
   * Make a remembered account the active one.
   *
   * Emphatically **not** a sign-out followed by a sign-in: it deletes nothing. See
   * the comment on the implementation.
   */
  switchAccount(pubkey: string): Promise<void>;
  /**
   * Step back to the sign-in screen to add another identity, keeping everything.
   *
   * Not a sign-out: no data is deleted and no account is forgotten. It exists
   * because the sign-in screen only renders when nobody is active, so adding a
   * second identity has to pass through "nobody is active" — and doing that with
   * `signOut` would delete the first account on the way.
   */
  addAccount(): void;
  /** Forget an account *and* delete its local data. The destructive one. */
  removeAccount(pubkey: string): Promise<void>;
  /**
   * Outcome of the last local-data cleanup, once it has finished.
   *
   * Undefined before the first one and while one is in flight. Worth surfacing
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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | undefined>();
  const [locked, setLocked] = useState<StoredSession | undefined>();
  const [nip07Available, setNip07Available] = useState(false);
  const [lastSignOut, setLastSignOut] = useState<SignOutCleanup | undefined>();
  const [accounts, setAccounts] = useState<readonly StoredAccount[]>(() =>
    loadAccounts(),
  );

  /*
   * The live remote-signer connection, if the active session is a bunker.
   *
   * Held in a ref and closed on every identity change. A `Nip46Signer` owns relay
   * sockets and a subscription keyed to one client key, so leaving the previous one
   * open after a switch means an account that is no longer signed in still has a
   * signing channel attached to it, and a stale reply arriving on it is one more
   * thing that could correlate to the wrong request.
   */
  const remote = useRef<RemoteConnection | undefined>(undefined);
  const [signerHealth, setSignerHealth] = useState<
    "alive" | "unreachable" | undefined
  >();
  const closeRemote = useCallback(() => {
    // Cleared here rather than left behind: a stale "unreachable" outliving the
    // connection it described would tell a freshly signed-in local account that
    // its signer is dead.
    setSignerHealth(undefined);
    remote.current?.close();
    remote.current = undefined;
  }, []);

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
    // Also back-fills the account list for a session saved before there was one, so
    // an existing user's identity appears in the switcher rather than looking lost.
    setAccounts(rememberAccount(stored));

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

    // Encrypted, or a bunker whose client key is encrypted: browse read-only until
    // unlocked, so the feed still works while the identity is locked.
    setLocked(stored);
    setSession({
      signer: ReadonlySigner.fromPubkey(stored.pubkey),
      pubkey: stored.pubkey,
      canSign: false,
    });
  }, []);

  /** Make one identity the active session, and remember it for the switcher. */
  const adopt = useCallback(
    (stored: StoredSession, signer: NostrSigner, canSign: boolean) => {
      saveSession(stored);
      setAccounts(rememberAccount(stored));
      setLocked(undefined);
      setSession({ signer, pubkey: stored.pubkey, canSign });
      setLastSignOut(undefined);
    },
    [],
  );

  const signInWithExtension = useCallback(async () => {
    const signer = Nip07Signer.fromWindow();
    const pubkey = await signer.pubkey();
    closeRemote();
    adopt({ kind: "nip07", pubkey }, signer, true);
  }, [adopt, closeRemote]);

  const adoptLocalSigner = useCallback(
    (signer: LocalSigner, secretKey: string, passphrase: string) => {
      const ncryptsec = encryptSecretKey(secretKey, passphrase);
      if (!ncryptsec) {
        throw new Error("could not encrypt the key for storage");
      }
      return signer.pubkey().then((pubkey) => {
        closeRemote();
        adopt({ kind: "encrypted", pubkey, ncryptsec }, signer, true);
      });
    },
    [adopt, closeRemote],
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

  const signInWithSeedPhrase = useCallback(
    (phrase: string, passphrase: string) =>
      seedPhraseSignIn(phrase, passphrase, adoptLocalSigner),
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

  const signInReadonly = useCallback(
    async (input: string) => {
      const pubkey = await readonlyPubkey(input);
      if (!pubkey) throw new Error("that is not a valid npub or hex pubkey");
      closeRemote();
      adopt(
        { kind: "readonly", pubkey },
        ReadonlySigner.fromPubkey(pubkey),
        false,
      );
    },
    [adopt, closeRemote],
  );

  /**
   * Adopt an established remote connection as the session.
   *
   * The client key is encrypted *before* anything is adopted: if the passphrase
   * cannot protect it there is no session worth having, and a bunker session whose
   * key was never stored would silently fail to resume on the next reload.
   */
  const adoptRemote = useCallback(
    (connection: RemoteConnection, passphrase: string) => {
      const ncryptsec = encryptSecretKey(connection.clientSecret, passphrase);
      if (!ncryptsec) {
        connection.close();
        throw new Error("could not encrypt the connection key for storage");
      }
      closeRemote();
      remote.current = connection;
      adopt(
        {
          kind: "nip46",
          pubkey: connection.userPubkey,
          ncryptsec,
          remoteSigner: {
            pubkey: connection.remoteSignerPubkey,
            relays: [...connection.relays],
            // Usually already known here: the handshake's own reply is a frame,
            // so a `nostrconnect://` invite has observed the scheme before this
            // runs. A `bunker://` connect may not have, which is what
            // `rememberScheme` below is for.
            ...(connection.observedScheme()
              ? { scheme: connection.observedScheme() }
              : {}),
          },
        },
        connection.signer,
        true,
      );
      rememberScheme(connection);
    },
    [adopt, closeRemote],
  );

  const signInWithBunker = useCallback(
    async (uri: string, passphrase: string) => {
      if (passphrase.length < 8) {
        throw new Error("passphrase must be at least 8 characters");
      }
      const connection = await connectToBunker(uri, undefined, setSignerHealth);
      adoptRemote(connection, passphrase);
    },
    [adoptRemote],
  );

  const beginRemoteInvite = useCallback(
    (passphrase: string, relays?: readonly string[]): RemoteInviteHandle => {
      // Checked before the invitation is published, not after a signer answers it:
      // failing at the last step would mean a signer had already authorised a client
      // key we then threw away, leaving a dangling authorisation on their device.
      if (passphrase.length < 8) {
        throw new Error("passphrase must be at least 8 characters");
      }
      const invite = inviteRemoteSigner(relays, undefined, setSignerHealth);
      return {
        uri: invite.uri,
        completed: invite.connection.then((connection) => {
          adoptRemote(connection, passphrase);
        }),
        cancel: invite.cancel,
      };
    },
    [adoptRemote],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      const stored = locked ?? loadSession();
      if (!stored) return false;

      if (stored.kind === "nip07") {
        if (!getNip07Provider()) return false;
        const signer = Nip07Signer.fromWindow();
        /*
         * The extension has exactly one active account, and it may not be this one.
         *
         * This used to adopt whatever the extension answered, which silently changed
         * identity: the user asked to unlock account A and got a session for
         * whichever account the extension happened to be showing — with A's stored
         * pubkey replaced. Refusing and saying so is recoverable; a session whose
         * pubkey and signer disagree publishes notes attributed to the wrong person.
         */
        const active = await signer.pubkey();
        if (active !== stored.pubkey) {
          throw new Error(
            "your extension is set to a different account — switch it to this one, or add that account separately",
          );
        }
        closeRemote();
        adopt({ kind: "nip07", pubkey: stored.pubkey }, signer, true);
        return true;
      }

      if (stored.kind === "nip46") {
        if (!stored.ncryptsec || !stored.remoteSigner) return false;
        const clientSecret = decryptSecretKey(stored.ncryptsec, passphrase);
        // `false` means "wrong passphrase" and nothing else. A signer that is simply
        // offline must not be reported as a bad passphrase, so that failure *throws*
        // with its own message — the two have completely different remedies.
        if (!clientSecret) return false;
        const connection = await resumeBunker(
          {
            clientSecret,
            remoteSignerPubkey: stored.remoteSigner.pubkey,
            relays: stored.remoteSigner.relays,
            userPubkey: stored.pubkey as Hex32,
            // Skips the NIP-04 probe's 8-second silence for a signer this device
            // has already talked to. Absent on a record written before the field
            // existed, which simply means the probe runs as it always did.
            ...(stored.remoteSigner.scheme
              ? { scheme: stored.remoteSigner.scheme }
              : {}),
          },
          undefined,
          setSignerHealth,
        );
        closeRemote();
        remote.current = connection;
        // A record written before this field existed, or one whose scheme was
        // still unknown at sign-in, learns it here — so the probe is paid once
        // ever rather than once per reload.
        rememberScheme(connection);
        setLocked(undefined);
        setSession({
          signer: connection.signer,
          pubkey: stored.pubkey,
          canSign: true,
        });
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

      closeRemote();
      setLocked(undefined);
      setSession({ signer, pubkey, canSign: true });
      return true;
    },
    [locked, adopt, closeRemote],
  );

  /*
   * Signing out removes the account from this device, not just from this tab.
   *
   * The session record goes first and unconditionally: a sign-out that fails and
   * leaves the user signed in is a worse outcome than one that leaves a database
   * behind, so nothing that can fail runs before the session is gone. The stored
   * data then goes too — notes, profile cache, private-message wraps, the
   * conversation read marks and the notification watermark used to stay on the origin
   * until the browser was cleared, which on a shared computer is the previous user's
   * whole timeline, a list of who they messaged, and when they last looked, sitting
   * under the login screen.
   *
   * The credential record goes as well, so the account does not linger in the
   * switcher pointing at data that no longer exists. Use `switchAccount` to leave an
   * account without destroying it — that is the whole difference between the two.
   */
  const signOut = useCallback(() => {
    const previous = session?.pubkey;
    closeRemote();
    clearSession();
    if (previous) setAccounts(forgetAccount(previous));
    setLocked(undefined);
    setSession(undefined);
    setLastSignOut(undefined);
    void discardAccountData(previous).then(setLastSignOut);
  }, [session?.pubkey, closeRemote]);

  /*
   * Switching accounts deletes nothing.
   *
   * This function must never call `discardAccountData`, and the reason is the whole
   * point of a switcher: that path runs `resetAccountScope()`, clears the read marks
   * and the notification watermark, and destroys the account's IndexedDB database.
   * Running it here would mean every switch away silently threw out that account's
   * cached timeline and every read position in it — so coming back would show an
   * empty feed, a re-fetch of everything, and every conversation and notification
   * unread again. Switching is: stop being this account, start being that one.
   * `EngineProvider` rebuilds the engine and reopens the other database on the pubkey
   * change, which is all that is needed.
   */
  const switchAccount = useCallback(
    async (pubkey: string) => {
      if (session?.pubkey === pubkey) return;
      const record = findAccount(pubkey);
      if (!record) {
        throw new Error("that account is not saved on this device");
      }
      const stored: StoredSession = {
        kind: record.kind,
        pubkey: record.pubkey,
        ...(record.ncryptsec ? { ncryptsec: record.ncryptsec } : {}),
        ...(record.remoteSigner ? { remoteSigner: record.remoteSigner } : {}),
      };
      closeRemote();
      saveSession(stored);
      setLastSignOut(undefined);

      if (record.kind === "readonly") {
        setLocked(undefined);
        setSession({
          signer: ReadonlySigner.fromPubkey(pubkey),
          pubkey,
          canSign: false,
        });
        return;
      }

      if (record.kind === "nip07" && getNip07Provider()) {
        // Checked, not assumed: an extension pointed at another account would sign
        // as that account while the session claims this one. Falling through to the
        // locked state below asks the user to point it here first.
        const signer = Nip07Signer.fromWindow();
        const active = await signer.pubkey().catch(() => undefined);
        if (active === pubkey) {
          setLocked(undefined);
          setSession({ signer, pubkey, canSign: true });
          return;
        }
      }

      /*
       * Everything else lands read-only and locked.
       *
       * An encrypted key needs its passphrase and a bunker needs its client key
       * decrypted, and a missing extension needs the user to enable it. In all three
       * the honest state is "this is you, you can read, you cannot sign yet" — which
       * is what `App.tsx` turns into the unlock dialog. Dropping to the login screen
       * instead would read as a switch that failed.
       */
      setLocked(stored);
      setSession({
        signer: ReadonlySigner.fromPubkey(pubkey),
        pubkey,
        canSign: false,
      });
    },
    [session?.pubkey, closeRemote],
  );

  /*
   * "Add another account" — the deliberately boring one.
   *
   * Clears only the *active* pointer. The credential list is untouched, no database
   * is deleted, and no read state is cleared, so the account being stepped away from
   * is still in the switcher with everything it had. The login screen appears because
   * `App.tsx` renders it whenever there is no session, and it offers the remembered
   * accounts as a way back if the user changes their mind.
   */
  const addAccount = useCallback(() => {
    closeRemote();
    clearSession();
    setLocked(undefined);
    setSession(undefined);
    setLastSignOut(undefined);
  }, [closeRemote]);

  /*
   * Removing an account: forget the credential *and* delete the data.
   *
   * The loud counterpart to `switchAccount`. Two paths, because which one runs
   * decides whether a live engine gets closed underneath the user — see
   * `discardInactiveAccountData`.
   */
  const removeAccount = useCallback(
    async (pubkey: string) => {
      const isActive = session?.pubkey === pubkey;
      setAccounts(forgetAccount(pubkey));
      setLastSignOut(undefined);
      if (!isActive) {
        setLastSignOut(await discardInactiveAccountData(pubkey));
        return;
      }
      closeRemote();
      clearSession();
      setLocked(undefined);
      setSession(undefined);
      setLastSignOut(await discardAccountData(pubkey));
    },
    [session?.pubkey, closeRemote],
  );

  // Closed on unmount so a bunker's sockets do not outlive the app tree.
  useEffect(() => () => closeRemote(), [closeRemote]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      locked,
      nip07Available,
      signerHealth,
      accounts,
      signInWithExtension,
      signInWithSecretKey,
      signInWithSeedPhrase,
      createIdentity,
      signInReadonly,
      signInWithBunker,
      beginRemoteInvite,
      unlock,
      signOut,
      switchAccount,
      addAccount,
      removeAccount,
      lastSignOut,
    }),
    [
      session,
      locked,
      nip07Available,
      signerHealth,
      accounts,
      signInWithExtension,
      signInWithSecretKey,
      signInWithSeedPhrase,
      createIdentity,
      signInReadonly,
      signInWithBunker,
      beginRemoteInvite,
      unlock,
      signOut,
      switchAccount,
      addAccount,
      removeAccount,
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
