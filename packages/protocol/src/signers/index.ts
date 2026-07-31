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
  Nip46Request,
  Nip46Response,
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
  DEFAULT_PERMISSIONS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  encodeRequest,
  generateConnectSecret,
  isAuthChallenge,
  isBunkerUri,
  NIP46_KIND,
  Nip46Pending,
  Nip46Signer,
  newRequestId,
  parseBunkerUri,
  parseNostrConnectUri,
  parseResponse,
  redactBunkerUri,
  startNostrConnect,
} from "./nip46";
export { isReadonly, ReadonlySigner } from "./readonly";
