/**
 * NIP-46 remote signing.
 *
 * Four pieces, split because they fail for different reasons and are worth testing
 * separately: URI parsing (`uri.ts`), JSON-RPC framing and the deadline-bearing
 * request table (`rpc.ts`), the relay seam the app fills in (`transport.ts`), and the
 * `NostrSigner` implementation that ties them together (`signer.ts`).
 */

export type { Nip46Request, Nip46Response, PendingOptions } from "./rpc";
export {
  AUTH_URL_RESULT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  encodeRequest,
  isAuthChallenge,
  Nip46Pending,
  newRequestId,
  parseResponse,
} from "./rpc";
export type {
  Nip46SignerOptions,
  NostrConnectHandshake,
  NostrConnectOptions,
} from "./signer";
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_PERMISSIONS,
  generateConnectSecret,
  Nip46Signer,
  startNostrConnect,
} from "./signer";
export type {
  Nip46SubscribeParams,
  Nip46Transport,
  Nip46Unsubscribe,
} from "./transport";
export { NIP46_KIND } from "./transport";
export type {
  BunkerUri,
  NostrConnectUri,
  NostrConnectUriInput,
} from "./uri";
export {
  buildNostrConnectUri,
  isBunkerUri,
  parseBunkerUri,
  parseNostrConnectUri,
  redactBunkerUri,
} from "./uri";
