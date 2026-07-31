/** Signer implementations of the `NostrSigner` contract. */

export {
  generateSecretKey,
  getPublicKey,
  LocalSigner,
  parseSecretKey,
} from "./local";
export {
  getNip07Provider,
  isNip07Available,
  type Nip07Provider,
  Nip07Signer,
} from "./nip07";
export type {
  BunkerUri,
  Nip46Frame,
  Nip46Health,
  Nip46Request,
  Nip46Response,
  Nip46Scheme,
  Nip46SignerOptions,
  Nip46SubscribeParams,
  Nip46Transport,
  Nip46Unsubscribe,
  NostrConnectHandshake,
  NostrConnectOptions,
  NostrConnectUri,
  NostrConnectUriInput,
} from "./nip46";
export {
  AUTH_URL_RESULT,
  buildNostrConnectUri,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_PERMISSIONS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  encodeRequest,
  generateConnectSecret,
  isAuthChallenge,
  isBunkerUri,
  NIP46_KIND,
  Nip46Codec,
  Nip46Pending,
  Nip46Signer,
  newRequestId,
  parseBunkerUri,
  parseNostrConnectUri,
  parseResponse,
  redactBunkerUri,
  SCHEME_PROBE_MS,
  schemeOf,
  startNostrConnect,
} from "./nip46";
export { isReadonly, ReadonlySigner } from "./readonly";
