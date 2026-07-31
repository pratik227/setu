/**
 * The relay seam for NIP-46.
 *
 * NIP-46 is JSON-RPC carried on relay events, which means the signer needs a
 * socket — and `@setu/protocol` has none and must not acquire one. The layer graph
 * is `protocol ← core ← app`, enforced by a lint script with a headless CLI as the
 * proof, so an `import` of the relay pool here would not merely be untidy: it would
 * make the protocol package unusable from Node and break the guard that keeps the
 * pool replaceable.
 *
 * So the transport is an *interface*, declared here and injected from the app, the
 * same way `fetch`, `verify` and `sign` are injected everywhere else in this
 * codebase. Two operations, no lifecycle beyond an unsubscribe function.
 *
 * ## What the implementer owes us
 *
 *  - `publish` resolves once the event has been handed to at least one relay, and
 *    rejects if it reached none. It must not wait for the *reply* — that is the
 *    request's own deadline (see `rpc.ts`), and a publish that resolved on a reply
 *    would put two timeouts on one exchange.
 *  - `subscribe` delivers every kind-24133 event `p`-tagged to `clientPubkey`,
 *    duplicates included. Deduplication happens above, because correlation already
 *    has to be idempotent to survive two relays answering the same request.
 *  - Nothing here is trusted. An event arriving on this channel is authenticated by
 *    the fact that its content decrypts with the NIP-44 conversation key between our
 *    client key and the sender's — a forged `pubkey` cannot produce that ciphertext.
 *    A transport that also verifies signatures is welcome to; it is not what makes
 *    the exchange safe.
 */

import type { Hex32, NostrEvent } from "../../types";

/** NIP-46 request/response event kind. */
export const NIP46_KIND = 24133;

/** What to listen for. */
export interface Nip46SubscribeParams {
  readonly relays: readonly string[];
  /** Our client key: replies are addressed to it with a `p` tag. */
  readonly clientPubkey: Hex32;
  /** Unix seconds; a floor on delivery, not an exact resume point. */
  readonly since: number;
}

/** Stops a subscription. Must be safe to call more than once. */
export type Nip46Unsubscribe = () => void;

/** Publish-and-subscribe over relays, injected by the app. */
export interface Nip46Transport {
  /** Send one signed kind-24133 event. Rejects if no relay accepted it. */
  publish(event: NostrEvent, relays: readonly string[]): Promise<void>;
  /** Listen for replies addressed to `clientPubkey`. */
  subscribe(
    params: Nip46SubscribeParams,
    onEvent: (event: NostrEvent) => void,
  ): Nip46Unsubscribe;
}
