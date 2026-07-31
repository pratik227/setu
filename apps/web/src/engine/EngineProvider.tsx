import {
  createEngine,
  createPersistentStore,
  defaultRetentionPolicy,
  type Engine,
  type EventStore,
  MemoryEventStore,
  normalizeRelayUrl,
  protocolHelpers,
  registerResettable,
  startStoreMaintenance,
} from "@setu/core";
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
import { useSession } from "../features/identity/SessionProvider";

/**
 * Default read relays.
 *
 * A starting point only: once an account is signed in, its NIP-65 list takes
 * over and per-author routing comes from the outbox router. Hardcoding a set as
 * the *permanent* source of truth is how a client quietly becomes centralized.
 *
 * Chosen against each relay's NIP-11 document rather than by reputation, because
 * the properties that matter are ones a relay states and a client can check. What
 * the documents actually say (verified, not assumed):
 *
 *  - `nos.lol` and `offchain.pub` — free, `max_limit` 500, and both implement
 *    **NIP-45 COUNT**. That last one decides whether totals are obtainable at all:
 *    without a COUNT-capable relay the only way to count someone's notes is to
 *    download them.
 *  - `nostr.oxtr.dev` — free, general purpose, 40 concurrent subscriptions.
 *  - `purplepag.es` — the "Purple Pages": a relay that exists specifically to carry
 *    profile metadata and relay lists. Relays are not interchangeable, and the one
 *    query every screen depends on — resolve this pubkey to a name and avatar —
 *    deserves a relay built for it.
 *
 * `nostr.wine` was here and is now removed: its document says
 * `payment_required: true`. A paid relay queried without an account does not error,
 * it answers with silence, so a quarter of every query was going somewhere that
 * could never reply and the shortfall looked like a quiet network.
 *
 * Not included, and the reason has changed: `auth.nostr1.com` sets
 * `auth_required: true`, which used to disqualify it outright because Setu could not
 * answer a NIP-42 challenge. It can now (`relay/relayAuth.ts`), so that argument is
 * gone — and it still does not belong here, for two better reasons.
 *
 * It is an inbox relay, not a general-purpose one: it exists to hold gift wraps
 * addressed to its users, so a feed, a profile lookup or a thread query aimed at it
 * returns nothing on its merits, which is the `nostr.wine` failure again with a
 * different cause. And AUTH is only answerable by a session that can sign — a
 * read-only or still-locked session would get silence from a quarter of this set.
 * Private mail does not need it here either: the DM inbox reads the account's own
 * kind-10050 relays *in addition to* this set (`features/chat/useInboxRelays.ts`)
 * and authenticates to them through {@link useAllowRelayAuth}, so putting an inbox
 * relay in the default read set would buy nothing and cost every other query.
 */
export const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://offchain.pub",
  "wss://nostr.oxtr.dev",
  "wss://purplepag.es",
] as const;

interface EngineContextValue {
  readonly engine: Engine;
  readonly errors: readonly string[];
  readonly allowRelayAuth: (relays: readonly string[]) => void;
}

/**
 * A store whose lifetime this provider owns.
 *
 * `Engine.close()` closes the pool and nothing else, by design — the engine did
 * not create the store. Both implementations expose `close`, and calling it on an
 * account switch is what releases the previous account's IndexedDB connection and
 * its live observers instead of leaking both for the life of the tab.
 */
type OwnedStore = EventStore & { close(): void };

const EngineContext = createContext<EngineContextValue | undefined>(undefined);

export function EngineProvider({
  children,
  relays = DEFAULT_RELAYS,
}: {
  children: ReactNode;
  relays?: readonly string[];
}) {
  const [errors, setErrors] = useState<readonly string[]>([]);
  const { session } = useSession();
  // Keyed on the pubkey rather than the session object: unlocking an encrypted
  // identity changes `canSign` but not who we are, and tearing down every
  // subscription to gain signing ability would be a visible stall for no reason.
  const accountPubkey = session?.pubkey;

  // Deliberately a ref: `canSign` flips when an encrypted key is unlocked, and
  // rebuilding the engine for that would tear down every live subscription.
  const signerRef = useRef(session?.canSign ? session.signer : undefined);
  signerRef.current = session?.canSign ? session.signer : undefined;

  /*
   * Relays this account named somewhere other than `relays` — in practice its
   * NIP-17 inbox list — whose NIP-42 challenges may be answered.
   *
   * A ref for the same reason `signerRef` is one: the inbox list is fetched, so it
   * arrives seconds after the first render, and rebuilding the engine to widen the
   * allowance would tear down every live subscription *and* close and reopen the
   * IndexedDB store built in the same memo below.
   */
  const authAllowed = useRef<Set<string>>(new Set());
  const authAllowedFor = useRef(accountPubkey);
  if (authAllowedFor.current !== accountPubkey) {
    // Emptied during render, before any child of the new account can nominate: a
    // relay the previous account chose is not one this account chose, and proving
    // this pubkey to it would hand it an identity it had no way to learn.
    authAllowedFor.current = accountPubkey;
    authAllowed.current = new Set();
  }

  const allowRelayAuth = useCallback((urls: readonly string[]) => {
    for (const url of urls) {
      const normalized = normalizeRelayUrl(url);
      // Normalised on the way in and on the way out, because the challenge arrives
      // keyed by the pool's canonical url while a kind-10050 carries whatever
      // spelling its author typed — `wss://Inbox.example/` and `wss://inbox.example`
      // are one relay, and a string compare would leave it unauthenticated.
      if (normalized !== "") authAllowed.current.add(normalized);
    }
  }, []);

  const report = useCallback((scope: string, error: unknown) => {
    const message = `${scope}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    // Keep a short tail; this feeds a relay-health panel, not a log.
    setErrors((prev) => [message, ...prev].slice(0, 20));
  }, []);

  // One engine and one store per (relay set, account). Changing either rebuilds
  // both, which is correct: the store and every watermark are scoped to what
  // filled them, and the account decides which protected events we are allowed to
  // rebroadcast.
  const { engine, store } = useMemo(() => {
    /*
     * Persistence, scoped to the account.
     *
     * The database name comes from the pubkey (`accountDatabaseName`), so two
     * accounts on one device cannot read each other's events. A signed-out session
     * deliberately gets no database at all rather than a shared "anonymous" one:
     * the only screen it can reach is the login screen, so there is nothing to
     * persist, and a database no account owns is one no sign-out would ever clean
     * up — it would sit on disk indefinitely with no way to attribute it.
     *
     * The protocol helpers are passed explicitly so the store matches filters with
     * exactly the matcher the ingest path uses. A store that disagrees is one
     * whose live queries reject events it was just handed.
     */
    const store: OwnedStore = accountPubkey
      ? createPersistentStore({
          accountPubkey,
          matchesFilter: protocolHelpers.matchesFilter,
          isValidEventShape: protocolHelpers.isValidEventShape,
          onError: (error) => report("store", error),
          /*
           * IndexedDB is missing in a Firefox private window, can be disabled by
           * policy, and starts rejecting writes at quota. The session continues in
           * memory — the app works, it just refetches after a reload — but it is
           * reported rather than swallowed, because otherwise a user whose data
           * never survives a reload has no way to find out why.
           */
          onFallback: (error) => report("store:persistence-unavailable", error),
        })
      : new MemoryEventStore({
          matchesFilter: protocolHelpers.matchesFilter,
          isValidEventShape: protocolHelpers.isValidEventShape,
          onError: (error) => report("store", error),
        });

    const engine = createEngine({
      relays,
      store,
      ...(accountPubkey ? { accountPubkey } : {}),
      /*
       * NIP-42, wired only when the session can sign.
       *
       * `signer` is read through a ref rather than captured, so unlocking an
       * encrypted key starts answering challenges without rebuilding the engine
       * and dropping every subscription.
       */
      signAuth: (template) => {
        const current = signerRef.current;
        if (!current) {
          return Promise.reject(
            new Error("no signer available for relay authentication"),
          );
        }
        return current.signEvent(template);
      },
      /*
       * Relays outside `relays` that this account nominated for itself, chiefly its
       * kind-10050 inbox. Without this an `auth_required` inbox relay answers a
       * gift-wrap REQ with `auth-required:` and nothing else — the account is
       * reachable by private message and cannot read one — and with it the privacy
       * rule is unchanged, because only relays the account published are in the set.
       */
      alsoAuthenticate: (relay) =>
        authAllowed.current.has(normalizeRelayUrl(relay)),
      onError: report,
    });
    return { engine, store };
  }, [relays, accountPubkey, report]);

  /*
   * Teardown, on unmount and on sign-out.
   *
   * The registry entries are what make sign-out's database deletion prompt
   * (`SessionProvider`'s `signOut`): IndexedDB waits on every open connection before
   * dropping a database, and reports the wait as neither an error nor a completion,
   * so the pool and the store are closed *first* rather than left to be prised loose.
   * Order is registration order — engine before store, because the engine's
   * subscriptions hold observers on the store, and dropping the store from under them
   * is how a live query fires against a closed handle.
   *
   * Registering under fixed names means each rebuild replaces the previous entry
   * (see `accountScope.ts`), so the registry always names the live pair rather than
   * a closed one. Closing twice is harmless — both `close()` implementations are
   * idempotent — which matters because a sign-out resets these and React then
   * unmounts the same objects a tick later.
   */
  useEffect(() => {
    const unregisterEngine = registerResettable("engine", () => engine.close());
    const unregisterStore = registerResettable("store", () => store.close());
    return () => {
      unregisterEngine();
      unregisterStore();
      engine.close();
      store.close();
    };
  }, [engine, store]);

  /*
   * Expiry sweeps and retention eviction, which core deliberately does not
   * schedule for itself (see `store/maintenance.ts`).
   *
   * Two failures this prevents: a NIP-40 note staying on an idle screen past its
   * deadline because no write happened to sweep it, and a store that only grows
   * until the origin's quota is reached — at which point *writes* start failing
   * and the client quietly stops keeping up with the network. Eviction is
   * conservative and never touches our own events; `store/retention.ts` states
   * exactly what it will and will not delete.
   */
  useEffect(
    () =>
      startStoreMaintenance({
        store,
        retention: defaultRetentionPolicy(
          accountPubkey ? { accountPubkey } : {},
        ),
        // Quota-driven retention: how full storage is decides how far back a sweep
        // reaches. Optional chaining because `navigator.storage` is absent in some
        // browsers and blocked in some private modes — both mean "unmeasurable",
        // which keeps the age-only behaviour rather than guessing.
        ...(typeof navigator !== "undefined" && navigator.storage
          ? { storageManager: navigator.storage }
          : {}),
        onError: (error) => report("store:maintenance", error),
      }),
    [store, accountPubkey, report],
  );

  const value = useMemo(
    () => ({ engine, errors, allowRelayAuth }),
    [engine, errors, allowRelayAuth],
  );

  return (
    <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
  );
}

export function useEngine(): Engine {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error("useEngine must be used inside <EngineProvider>");
  return ctx.engine;
}

export function useEngineErrors(): readonly string[] {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error("useEngineErrors requires <EngineProvider>");
  return ctx.errors;
}

/**
 * Declare that the account itself named these relays, so NIP-42 challenges from
 * them may be answered.
 *
 * For lists the account published and this client fetched — its kind-10050 inbox —
 * which cannot be in {@link DEFAULT_RELAYS} or in the user's typed relay list and
 * are exactly the relays most likely to set `auth_required`. Call it with a list the
 * *account* chose and nothing else: a signed AUTH event tells a relay who is
 * reading, and passing relays discovered by routing would leak the reader's pubkey
 * to every relay that thought to ask.
 *
 * Additive and cheap to call repeatedly; the allowance is emptied when the account
 * changes, so nothing carries over between identities.
 */
export function useAllowRelayAuth(): (relays: readonly string[]) => void {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error("useAllowRelayAuth requires <EngineProvider>");
  return ctx.allowRelayAuth;
}
