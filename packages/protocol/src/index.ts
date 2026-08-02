/**
 * `@setu/protocol` — Nostr wire types and pure protocol logic.
 *
 * This package has no I/O, no state, and no dependency on any other Setu
 * package: everything here is a function of its inputs. Relay transport lives
 * in `@setu/core`, rendering in `@setu/ui`.
 */

export type {
  ContentToken,
  ContentTokenType,
} from "./content";
export {
  classifyUrl,
  imageUrls,
  mentionedRefs,
  tokenizeContent,
} from "./content";
export {
  computeEventId,
  isValidEventShape,
  isValidUnsignedShape,
  matchesAnyFilter,
  matchesFilter,
  serializeEvent,
  verifyEventSignature,
} from "./event";
export {
  bytesToHex,
  hexToBytes,
  isHex32,
  isHex64,
  isHexOfBytes,
} from "./hex";
export type { KindName, KnownKind } from "./kinds";
export {
  isAddressable,
  isEphemeral,
  isRegular,
  isReplaceable,
  Kind,
} from "./kinds";
export {
  decryptNip04,
  encryptNip04,
  looksLikeNip04,
  Nip04Error,
} from "./nip04";
export type { DerivedAccount, SeedPhraseError } from "./nip06";
export {
  deriveFromSeedPhrase,
  generateSeedPhrase,
  normalizeSeedPhrase,
  SEED_PHRASE_LENGTHS,
  seedPhraseMessage,
  seedPhraseWordCount,
  validateSeedPhrase,
} from "./nip06";
export type { MineOptions, MineResult } from "./nip13";
export {
  committedDifficulty,
  eventDifficulty,
  leadingZeroBits,
  mineEvent,
} from "./nip13";
export type { ChatMessage, ChatMessageInput } from "./nip17";
export {
  buildChatMessage,
  buildDmRelayList,
  chatParticipants,
  conversationId,
  deliveryTargets,
  isChatRumor,
  parseDmRelayList,
  toChatMessage,
} from "./nip17";
export { quotedEventIds } from "./nip18";
export type {
  AddressRef,
  EventRef,
  Nip19Prefix,
  Nip19Ref,
  ProfileRef,
} from "./nip19";
export {
  decodeAny,
  encodeNaddr,
  encodeNevent,
  encodeNote,
  encodeNprofile,
  encodeNpub,
  encodeNsec,
  encodeRef,
  looksLikeNip19,
  stripNostrScheme,
  toEventId,
  toPubkey,
  truncateNpub,
} from "./nip19";
export type { EmojiSegment } from "./nip30";
export { emojiSegments, emojiTagMap, isSoleShortcode } from "./nip30";
export type { UserStatus, UserStatusKind } from "./nip38";
export {
  currentUserStatus,
  isStatusExpired,
  parseUserStatus,
} from "./nip38";
export {
  buildAuthEvent,
  CLIENT_AUTH_KIND,
  isAuthEventFor,
  isAuthRequired,
  isRestricted,
  sameRelay,
} from "./nip42";
export type {
  Msat,
  WalletConnection,
  WalletErrorCode,
  WalletMethod,
  WalletRequest,
  WalletResponse,
  WalletUriError,
  WalletUriResult,
} from "./nip47";
export {
  balanceFromResult,
  buildWalletRequest,
  msat,
  msatFromSat,
  parseWalletInfo,
  parseWalletResponse,
  parseWalletUri,
  satFromMsat,
  supportsNip44,
  WALLET_ERROR_CODES,
  WALLET_INFO_KIND,
  WALLET_NOTIFICATION_NIP04_KIND,
  WALLET_NOTIFICATION_NIP44_KIND,
  WALLET_REQUEST_KIND,
  WALLET_RESPONSE_KIND,
  walletErrorMessage,
  walletRequestPayload,
  walletUriMessage,
} from "./nip47";
export type { KeySecurityByte } from "./nip49";
export {
  DEFAULT_LOG_N,
  decryptSecretKey,
  encryptSecretKey,
  isNcryptsec,
  KeySecurity,
} from "./nip49";
export type { FollowPack } from "./nip51packs";
export {
  newestFollowPacks,
  newMembers,
  parseFollowPack,
} from "./nip51packs";
export type { Rumor, UnwrapResult } from "./nip59";
export {
  GiftWrapError,
  giftWrap,
  jitteredTimestamp,
  MAX_TIMESTAMP_JITTER_SECONDS,
  seal,
  toRumor,
  unwrap,
  wrap,
} from "./nip59";
export type { PicturePost } from "./nip68";
export { parsePicture } from "./nip68";
export type { VideoPost } from "./nip71";
export { isVideoKind, parseVideo } from "./nip71";
export type { ParsedAppData } from "./nip78";
export {
  APP_DATA_KIND,
  APP_DATA_VERSION_KEY,
  AppDataError,
  appDataFilter,
  appDataTemplate,
  decryptAppData,
  encryptAppData,
  isAppData,
  looksLikePlaintextJson,
  parseAppDataJson,
  replacesAppData,
  serializeAppDataJson,
} from "./nip78";
export type {
  Poll,
  PollOption,
  PollOptionTally,
  PollResponse,
  PollSource,
  PollTally,
  PollType,
} from "./nip88";
export {
  buildPollResponse,
  EMPTY_TALLY,
  parsePoll,
  parsePollResponse,
  pollHasEnded,
  tallyPoll,
} from "./nip88";
export type { ImetaEntry, MediaDimensions } from "./nip92";
export { parseDim, parseImeta, parseImetaTag } from "./nip92";
export type {
  BunkerUri,
  Nip07Provider,
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
} from "./signers";
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
  generateSecretKey,
  getNip07Provider,
  getPublicKey,
  isAuthChallenge,
  isBunkerUri,
  isNip07Available,
  isReadonly,
  LocalSigner,
  NIP46_KIND,
  Nip07Signer,
  Nip46Codec,
  Nip46Pending,
  Nip46Signer,
  newRequestId,
  parseBunkerUri,
  parseNostrConnectUri,
  parseResponse,
  parseSecretKey,
  ReadonlySigner,
  redactBunkerUri,
  SCHEME_PROBE_MS,
  schemeOf,
  startNostrConnect,
} from "./signers";
export type { HasTags, ParsedAddress, ThreadRefs } from "./tags";
export {
  addressOf,
  dTag,
  eTags,
  getTagged,
  getTagValue,
  getTagValues,
  hashtags,
  hasTag,
  isReply,
  parseAddress,
  pTags,
  replaceableAddress,
  rootAndReplyIds,
  rTags,
} from "./tags";
export type {
  EventTemplate,
  Filter,
  Hex32,
  Hex64,
  NostrEvent,
  NostrSigner,
  RelayBasedFilter,
  RelayUsage,
  Timestamp,
  UnsignedEvent,
} from "./types";
export { SignerError } from "./types";
