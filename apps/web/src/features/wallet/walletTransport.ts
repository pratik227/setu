import type { RelayPool } from "@setu/core";
import {
  buildWalletRequest,
  decryptNip04,
  encryptNip04,
  type Hex32,
  LocalSigner,
  looksLikeNip04,
  parseWalletResponse,
  WALLET_RESPONSE_KIND,
  type WalletMethod,
  type WalletResponse,
  walletRequestPayload,
} from "@setu/protocol";

/**
 * One NIP-47 request, from signing to reply.
 *
 * ## Signed by the connection key, never the account key
 *
 * The connection secret is its own keypair, and that is the privacy property of the
 * whole feature: the wallet service sees requests from a key that exists only for this
 * pairing, so it never learns which npub is paying. Signing with the account key would
 * hand a third party a link between an identity and its spending, permanently and
 * unrecallably. `LocalSigner` is constructed from the connection secret here for
 * exactly that reason and is never the session signer.
 *
 * ## Why this uses the pool directly, which nothing else does
 *
 * `RelayPool` is documented as never being handed to UI code, and everything else in
 * the app goes through `SubscriptionManager` — which routes events into the store and
 * lets a screen observe it. That path cannot work here: kinds 23194 and 23195 are in
 * the **ephemeral** range (20000–29999), so the store refuses them by design, and a
 * reply would be dropped before any observer saw it. `subscriptions.fetch` is wrong for
 * a second reason — it resolves on EOSE, and the reply arrives *after* EOSE because it
 * is written in response to the request we publish. So the reply has to be taken from
 * the socket callback, and this is the one module that reads it there.
 *
 * ## Subscribe before publishing
 *
 * A wallet can answer in tens of milliseconds. Publishing first and subscribing second
 * is a race that loses the reply on a fast wallet and produces a timeout — reported to
 * the user as "did the payment happen?" for a payment that plainly did.
 *
 * ## A timeout is not a failure
 *
 * `{ kind: "timeout" }` is its own outcome, distinct from a wallet that refused. For
 * `get_balance` the difference is cosmetic; for `pay_invoice` it is the whole thing —
 * the request was published, the wallet may well have paid, and retrying a payment we
 * cannot account for is how someone gets charged twice. Callers must render it as
 * unknown and must not retry automatically.
 */

/** How long to wait for a reply before giving up. */
export const WALLET_TIMEOUT_MS = 30_000;

/** How long a published request stays valid on the relay (NIP-40). */
const REQUEST_TTL_SECONDS = 120;

export type WalletOutcome =
  | { readonly kind: "ok"; readonly response: WalletResponse }
  /** Nothing came back in time. The request may still have been acted on. */
  | { readonly kind: "timeout" }
  /** Local failure: nothing was published, so nothing happened. */
  | { readonly kind: "failed"; readonly message: string };

export interface WalletCallInput {
  readonly pool: RelayPool;
  readonly walletPubkey: Hex32;
  readonly relays: readonly string[];
  /** Raw connection secret. Held in memory only — see `walletStorage`. */
  readonly secret: Uint8Array;
  readonly method: WalletMethod;
  readonly params?: Record<string, unknown>;
  /** True when the wallet advertised NIP-44. Falls back to NIP-04 otherwise. */
  readonly nip44?: boolean;
  readonly timeoutMs?: number;
}

/**
 * Send one request and resolve with what came back.
 *
 * The subscription and the timer are torn down on every path, including the throw
 * paths: a leaked REQ against a wallet relay is a subscription slot that never comes
 * back, and a leaked timer keeps a closure holding the secret alive.
 */
export async function callWallet(
  input: WalletCallInput,
): Promise<WalletOutcome> {
  const {
    pool,
    walletPubkey,
    relays,
    secret,
    method,
    params = {},
    nip44 = false,
    timeoutMs = WALLET_TIMEOUT_MS,
  } = input;

  // `tryFromSecretKey`, not the throwing form: the bytes come from decrypting stored
  // ciphertext, so "not a valid key" means a corrupt row rather than a programming
  // error, and it deserves a message instead of an exception.
  const signer = LocalSigner.tryFromSecretKey(secret);
  if (!signer) {
    return {
      kind: "failed",
      message:
        "The stored wallet connection is not usable. Pair the wallet again.",
    };
  }
  const clientPubkey = signer.pubkeySync();

  const plaintext = walletRequestPayload({ method, params });
  let content: string;
  try {
    content =
      nip44 && signer.nip44Encrypt
        ? await signer.nip44Encrypt(walletPubkey, plaintext)
        : encryptNip04(secret, walletPubkey, plaintext);
  } catch {
    return { kind: "failed", message: "Setu could not encrypt the request." };
  }

  const now = Math.floor(Date.now() / 1000);
  let request: Awaited<ReturnType<typeof signer.signEvent>>;
  try {
    request = await signer.signEvent(
      buildWalletRequest({
        walletPubkey,
        content,
        createdAt: now,
        ...(nip44 ? { nip44: true } : {}),
        // So a request the wallet never read does not sit on a relay indefinitely
        // waiting to be replayed against the account later.
        expiration: now + REQUEST_TTL_SECONDS,
      }),
    );
  } catch {
    return { kind: "failed", message: "Setu could not sign the request." };
  }

  return new Promise<WalletOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: WalletOutcome) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      handle.close();
      resolve(outcome);
    };

    // Subscribed before publishing — see the module doc. `#e` scopes the reply to
    // *this* request, so two calls in flight cannot resolve with each other's answer.
    const handle = pool.subscribe(
      relays.map((relay) => ({
        relay,
        filter: {
          kinds: [WALLET_RESPONSE_KIND],
          authors: [walletPubkey],
          "#p": [clientPubkey],
          "#e": [request.id],
          limit: 1,
        },
      })),
      {
        onEvent: (event) => {
          /*
           * Re-check what the filter already asked for.
           *
           * A relay is not trusted to have honoured a REQ — it can return anything,
           * and a buggy one that ignores `#e` would let one call resolve with another
           * call's reply. On a payment path that is the difference between
           * `pay_invoice` and the `get_balance` reply that arrived beside it, reported
           * as a successful payment. Same discipline as `unwrap` re-checking the seal's
           * author instead of trusting the wrap.
           */
          if (event.kind !== WALLET_RESPONSE_KIND) return;
          if (event.pubkey !== walletPubkey) return;
          const answers = event.tags.some(
            (tag) => tag[0] === "e" && tag[1] === request.id,
          );
          if (!answers) return;

          void (async () => {
            let body: string;
            try {
              // The wallet may reply with a different scheme than it advertised, so
              // the *shape* of what arrived decides how to open it. Guessing from the
              // advertised capability alone costs a lost reply and a 30s timeout.
              body = looksLikeNip04(event.content)
                ? decryptNip04(secret, walletPubkey, event.content)
                : ((await signer.nip44Decrypt?.(walletPubkey, event.content)) ??
                  "");
            } catch {
              finish({
                kind: "failed",
                message: "The wallet's reply could not be decrypted.",
              });
              return;
            }
            finish({ kind: "ok", response: parseWalletResponse(body) });
          })();
        },
      },
    );

    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);

    void pool.publish(request, relays).then((results) => {
      // Only a *total* publish failure is conclusive: if no relay took the request,
      // the wallet cannot have seen it, so there is no ambiguity to preserve and the
      // user can be told plainly that nothing happened.
      if (results.length > 0 && results.every((result) => !result.ok)) {
        finish({
          kind: "failed",
          message:
            results.find((result) => result.message)?.message ??
            "No relay accepted the request, so the wallet never received it.",
        });
      }
    });
  });
}

/**
 * Copy for an outcome, for a surface that just needs a sentence.
 *
 * The timeout wording is deliberately non-committal about whether the thing happened,
 * because we do not know — and for a payment, implying either answer is worse than
 * saying so.
 */
export function walletOutcomeMessage(
  outcome: WalletOutcome,
): string | undefined {
  switch (outcome.kind) {
    case "ok":
      return outcome.response.ok ? undefined : outcome.response.message;
    case "timeout":
      return "The wallet did not reply in time. It may still have acted on the request — check the wallet before trying again.";
    case "failed":
      return outcome.message;
  }
}
