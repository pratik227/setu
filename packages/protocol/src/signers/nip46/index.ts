/**
 * NIP-46 remote signing.
 *
 * Six pieces, split because they fail for different reasons and are worth testing
 * separately: URI parsing (`uri.ts`), JSON-RPC framing and the deadline-bearing
 * request table (`rpc.ts`), the two content encryptions and how one is told from the
 * other (`codec.ts`), the relay seam the app fills in (`transport.ts`), the
 * `NostrSigner` implementation that ties them together (`signer.ts`), and the
 * `nostrconnect://` invitation flow (`connect.ts`).
 */

export type { Nip46Frame, Nip46Scheme } from "./codec";
export { Nip46Codec, schemeOf } from "./codec";
export type {
  NostrConnectHandshake,
  NostrConnectOptions,
} from "./connect";
export {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  generateConnectSecret,
  startNostrConnect,
} from "./connect";
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
export type { Nip46Health, Nip46SignerOptions } from "./signer";
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_PERMISSIONS,
  Nip46Signer,
  SCHEME_PROBE_MS,
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
