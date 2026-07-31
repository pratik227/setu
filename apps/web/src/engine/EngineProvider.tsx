import { createEngine, type Engine } from "@setu/core";
import {
  createContext,
  type ReactNode,
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
 * Not included, deliberately: `auth.nostr1.com` is a good free DM inbox relay but
 * sets `auth_required: true`, and Setu has no NIP-42 implementation yet. Adding it
 * before AUTH exists would reproduce exactly the `nostr.wine` problem.
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
}

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

  // One engine per (relay set, account). Changing either rebuilds it, which is
  // correct: the store and every watermark are scoped to what filled them, and
  // the account decides which protected events we are allowed to rebroadcast.
  const engine = useMemo(
    () =>
      createEngine({
        relays,
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
        onError: (scope, error) => {
          const message = `${scope}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          // Keep a short tail; this feeds a relay-health panel, not a log.
          setErrors((prev) => [message, ...prev].slice(0, 20));
        },
      }),
    [relays, accountPubkey],
  );

  useEffect(() => () => engine.close(), [engine]);

  const value = useMemo(() => ({ engine, errors }), [engine, errors]);

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
