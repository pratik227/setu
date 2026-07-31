import { useSyncExternalStore } from "react";

/**
 * The unlocked connection secret, for the whole page rather than one component.
 *
 * ## Why this is a module store and not component state
 *
 * The secret used to live in `useWallet`'s `useState`, which meant every caller of
 * that hook had *its own* wallet: the instance in the wallet screen was unlocked and
 * the instance behind a note row was not, so paying from the timeline was impossible
 * by construction. Unlocking is a decision a person makes once per session about a
 * device, not about a component, so the unlocked state belongs where every surface can
 * see it — and once a zap can be paid, the feed is one of those surfaces.
 *
 * The alternative was a React context, which would mean a provider in `App.tsx`. This
 * needs no tree position and no provider ordering, and a module store is also what
 * makes {@link walletSessionSecret} callable from inside a stable `useCallback` without
 * putting the secret in a dependency array.
 *
 * ## What it costs, and the two things that pay it back
 *
 * The trade is that the key now survives unmounting the wallet screen, where before
 * navigating away silently re-locked it. That is the behaviour people expect from
 * "unlock for this session", but it means the window in which the key is in memory is
 * longer, so:
 *
 *  - **it is never persisted.** Nothing here writes to storage. A reload starts locked,
 *    the same as before — `walletStorage` still holds only NIP-49 ciphertext;
 *  - **there is exactly one slot, and it is account-gated.** Every read names the
 *    account it expects and gets `undefined` when the slot belongs to another one, so
 *    one account's spending key is unreachable while a different account is signed in.
 *    A write for a different account replaces the slot outright rather than adding to a
 *    map — a map would keep the previous account's key alive for the page's lifetime.
 *
 * `lockWalletSession` exists so that dropping the key is an action a person can take,
 * not something that only happens as a side effect of navigation.
 *
 * ## The capabilities live here too
 *
 * `nip44` and the advertised method list come from the wallet's kind-13194, which only
 * the wallet screen subscribes to. Keeping them in the same slot means the zap path can
 * ask "does this wallet even do pay_invoice?" without opening a second subscription per
 * surface, and answer *before* offering a control that could only fail.
 */

export interface WalletSessionState {
  /** The account this slot belongs to. `undefined` when nothing is unlocked. */
  readonly account: string | undefined;
  /** Raw connection secret. Present only while unlocked. */
  readonly secret: Uint8Array | undefined;
  /** True when the wallet advertised NIP-44 for request encryption. */
  readonly nip44: boolean;
  /** Methods from the wallet's kind-13194. Empty means "not learnt yet". */
  readonly methods: readonly string[];
}

/** The shape a caller sees when nothing is unlocked for the account it asked about. */
const EMPTY: WalletSessionState = {
  account: undefined,
  secret: undefined,
  nip44: false,
  methods: [],
};

let state: WalletSessionState = EMPTY;
const listeners = new Set<() => void>();

function publish(next: WalletSessionState): void {
  state = next;
  // Copied before iterating: a listener that unsubscribes during the notification
  // would otherwise mutate the set being walked.
  for (const listener of [...listeners]) listener();
}

/**
 * The raw slot, for `useSyncExternalStore`.
 *
 * Identity changes only on a real change, which is what makes the no-op guard in
 * {@link noteWalletCapabilities} effective rather than decorative.
 */
export function walletSessionState(): WalletSessionState {
  return state;
}

/** Exported for the hook below and for tests of the notification behaviour. */
export function subscribeWalletSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Hold an unlocked secret for `account`.
 *
 * Capabilities already learnt for the same account are kept: the info event is read
 * while the connection is still locked, and throwing that away on unlock would mean
 * the first payment attempt is the one that discovers `NOT_IMPLEMENTED`.
 */
export function openWalletSession(account: string, secret: Uint8Array): void {
  const keepCapabilities = state.account === account;
  publish({
    account,
    secret,
    nip44: keepCapabilities ? state.nip44 : false,
    methods: keepCapabilities ? state.methods : [],
  });
}

/**
 * Drop the secret, keeping nothing.
 *
 * Used by an explicit lock, by disconnecting, and when the signed-in account changes.
 * The capabilities go too: they describe a wallet that may not be the next one paired.
 */
export function lockWalletSession(): void {
  if (state === EMPTY) return;
  publish(EMPTY);
}

/** Drop the slot unless it already belongs to `account`. */
export function lockWalletSessionUnless(account: string | undefined): void {
  if (state.account === undefined) return;
  if (account !== undefined && state.account === account) return;
  publish(EMPTY);
}

/**
 * Record what the wallet advertised.
 *
 * A no-op when nothing changed, and that guard is load-bearing: this is called from a
 * store observer that re-fires whenever the info event is re-delivered, and publishing
 * an identical snapshot would re-render every subscriber on every relay tick.
 */
export function noteWalletCapabilities(
  account: string,
  capabilities: {
    readonly nip44: boolean;
    readonly methods: readonly string[];
  },
): void {
  const sameAccount = state.account === account;
  if (
    sameAccount &&
    state.nip44 === capabilities.nip44 &&
    state.methods.length === capabilities.methods.length &&
    state.methods.every(
      (method, index) => method === capabilities.methods[index],
    )
  ) {
    return;
  }
  publish({
    account,
    // A capability write must never resurrect another account's key.
    secret: sameAccount ? state.secret : undefined,
    nip44: capabilities.nip44,
    methods: capabilities.methods,
  });
}

/**
 * The unlocked secret for `account`, or `undefined`.
 *
 * Callable outside React on purpose: the payment paths read it at call time so the
 * secret never enters a `useCallback` dependency array, which is what keeps the zap
 * entry point reference-stable while the feed re-renders.
 */
export function walletSessionSecret(
  account: string | undefined,
): Uint8Array | undefined {
  if (!account || state.account !== account) return undefined;
  return state.secret;
}

/** What the wallet advertised for `account`. Defaults are "unknown", not "no". */
export function walletCapabilities(account: string | undefined): {
  readonly nip44: boolean;
  readonly methods: readonly string[];
} {
  if (!account || state.account !== account) {
    return { nip44: false, methods: [] };
  }
  return { nip44: state.nip44, methods: state.methods };
}

/**
 * Subscribe a component to the slot, scoped to one account.
 *
 * Returns the shared `EMPTY` object for a mismatched account rather than a fresh one,
 * so a component watching an account with no unlocked wallet never re-renders because
 * of a different account's activity.
 */
export function useWalletSession(
  account: string | undefined,
): WalletSessionState {
  const current = useSyncExternalStore(
    subscribeWalletSession,
    walletSessionState,
    walletSessionState,
  );
  if (!account || current.account !== account) return EMPTY;
  return current;
}
