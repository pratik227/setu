/**
 * `@setu/core` — the headless Setu client engine.
 *
 * Contains no React, no DOM-framework dependency and no rendering: an event
 * store, a relay transport, one read API above it, feeds, and the batching
 * machinery that keeps all of it off the UI thread's critical path.
 *
 * The architecture in one paragraph: **the event store is the only source of
 * truth and it is the app's event bus.** Relays write into it via
 * {@link DefaultSubscriptionManager}, which verifies every event first. The UI
 * reads it via {@link EventStore.observe}. Nothing else. There is no second
 * in-memory graph, no view-model cache, and no optimistic-UI path — a published
 * event reaches the screen the same way a relay's does.
 *
 * Typical composition:
 *
 * ```ts
 * const store = new DexieEventStore({ accountPubkey });
 * const pool = new WebSocketRelayPool();
 * const verifier = createEventVerifier({ verifySignature });
 * const reads = new DefaultSubscriptionManager({ store, pool, verifier });
 * const router = new OutboxRouter({ store, fallbackRelays });
 * registerResettable("store", () => store.close());
 * registerResettable("pool", () => pool.close());
 * ```
 */

// --- contracts ---------------------------------------------------------------

export type {
  EventProvenance,
  EventStore,
  EventVerifier,
  ProfileBatcher,
  PublishResult,
  ReadMode,
  ReadRequest,
  RelayHealth,
  RelayPool,
  RelayStatus,
  StoredEvent,
  SubscriptionCallbacks,
  SubscriptionHandle,
  SubscriptionManager,
  Unsubscribe,
} from "./contracts";

// --- account scope -----------------------------------------------------------

export type {
  ResetFailure,
  ResetFn,
  ResetReport,
} from "./account/accountScope";
export {
  clearResettables,
  listResettables,
  registerResettable,
  resetAccountScope,
} from "./account/accountScope";

// --- store -------------------------------------------------------------------

export type {
  DexieEventStoreOptions,
  IndexedDbEnvironment,
} from "./store/dexieStore";
export { accountDatabaseName, DexieEventStore } from "./store/dexieStore";
export {
  EXPIRATION_TAG,
  ExpirationIndex,
  expirationOf,
  isExpiredAt,
  MAX_EXPIRATION_SECONDS,
  parseExpirationValue,
} from "./store/expiration";
export type { FallbackEventStoreOptions } from "./store/fallbackStore";
export { FallbackEventStore } from "./store/fallbackStore";
export {
  addressAuthor,
  addressOf,
  dTagOf,
  isAddressableKind,
  isEphemeralKind,
  isReplaceableKind,
  KIND_CONTACTS,
  KIND_DELETION,
  KIND_GENERIC_REPOST,
  KIND_METADATA,
  KIND_RELAY_LIST,
  KIND_REPOST,
  makeAddress,
} from "./store/kinds";
export type {
  StoreMaintenanceOptions,
  TimerHandle,
} from "./store/maintenance";
export {
  MAX_SWEEP_DELAY_MS,
  MIN_SWEEP_DELAY_MS,
  startStoreMaintenance,
  sweepDelayMs,
} from "./store/maintenance";
export type { EventStoreOptions } from "./store/memoryStore";
export { MemoryEventStore } from "./store/memoryStore";
export type { MuteReason, MuteRules } from "./store/muteFilter";
export {
  isMuted,
  isMuteRulesEmpty,
  mutedReason,
  muteRulesFrom,
  muteRulesKey,
  NO_MUTES,
  occursAsWord,
} from "./store/muteFilter";
export type {
  MuteAwareEventStore,
  MuteIngestOptions,
} from "./store/muteIngest";
export {
  MUTE_REFUSABLE_KINDS,
  MuteIngestPolicy,
  mutedAtIngest,
  supportsMuteIngest,
} from "./store/muteIngest";
export type { ObserverRegistryOptions } from "./store/observers";
export { ObserverRegistry } from "./store/observers";
export type { PersistentStoreOptions } from "./store/persistentStore";
export { createPersistentStore } from "./store/persistentStore";
export {
  isProtected,
  isProtectedEventPublishError,
  isUnverifiedPublishError,
  mayPublish,
  PROTECTED_TAG,
  ProtectedEventPublishError,
  UnverifiedPublishError,
} from "./store/protection";
export type { IndexPlan, IndexStats } from "./store/queryPlan";
export {
  chooseIndex,
  sortAndLimit,
  tagIndexKey,
  tagIndexKeysOf,
} from "./store/queryPlan";
export type { PutDecision, RejectReason } from "./store/replaceable";
export {
  compareEventsNewestFirst,
  compareStoredNewestFirst,
  initialProvenance,
  mergeProvenance,
  shouldReplace,
} from "./store/replaceable";
export type {
  EvictingEventStore,
  RetentionPolicy,
} from "./store/retention";
export {
  DEFAULT_RETENTION_SECONDS,
  defaultRetentionPolicy,
  EVICTABLE_KINDS,
  isEvictable,
} from "./store/retention";
export type {
  PressureLevel,
  StorageEstimate,
  StoragePressure,
} from "./store/storagePressure";
export {
  CRITICAL_PRESSURE_RATIO,
  classifyStorage,
  HIGH_PRESSURE_RATIO,
  MINIMUM_RETENTION_SECONDS,
  policyForPressure,
  readStorageEstimate,
  retentionSecondsFor,
  shouldSweep,
} from "./store/storagePressure";
export type { DeletionTargets, TombstoneRecord } from "./store/tombstones";
export {
  addressTombstoneKey,
  deletionTargets,
  idTombstoneKey,
  TombstoneIndex,
} from "./store/tombstones";

// --- relay -------------------------------------------------------------------

export type { Conversation } from "./dm/conversations";
export {
  conversationTitle,
  groupConversations,
  unreadConversations,
} from "./dm/conversations";
export type { BackoffOptions } from "./relay/backoff";
export { computeBackoffDelay, DEFAULT_BACKOFF } from "./relay/backoff";
export type { AggregatedCount } from "./relay/countAggregate";
export {
  aggregateCount,
  formatCount,
  NO_COUNT,
} from "./relay/countAggregate";
export type { RelayCountResult } from "./relay/countRequests";
export type { FetchNip11, Nip11Document } from "./relay/nip11Fetch";
export {
  nip11Url,
  normalizeRelayUrl,
  normalizeRelayUrls,
} from "./relay/normalize";
export type { OutboxRouterOptions } from "./relay/outboxRouter";
export { OutboxRouter, parseRelayList } from "./relay/outboxRouter";
export type {
  RelayConnectionHandlers,
  RelayConnectionOptions,
} from "./relay/relayConnection";
export { RelayConnection } from "./relay/relayConnection";
export {
  clampLimit,
  NIP,
  parseRelayInfo,
  type RelayGate,
  type RelayInfo,
  type RelayLimitation,
  type RelaySuitability,
  relayGate,
  relaysFor,
  subscriptionBudget,
  suitability,
  supports,
} from "./relay/relayInfo";
export { RelayInfoCache } from "./relay/relayInfoCache";
export type {
  PoolSubscriptionCallbacks,
  RelayPoolOptions,
} from "./relay/relayPool";
export { WebSocketRelayPool } from "./relay/relayPool";
export type {
  SearchFilterOptions,
  SearchReach,
  SearchRelay,
  SearchRouting,
  SearchRoutingInput,
} from "./relay/searchRouting";
export type {
  ContentClass,
  RelayScore,
  RelayScorecard,
} from "./relay/relayScorecard";
export {
  classesForKinds,
  contentClassOf,
  orderByDelivery,
  SCORED_KINDS,
  scoreRows,
  scorecardQueries,
} from "./relay/relayScorecard";
export type {
  RelayScorecardSource,
  RelayScorecardSourceOptions,
} from "./relay/relayScorecardSource";
export { createRelayScorecardSource } from "./relay/relayScorecardSource";
export {
  MIN_SEARCH_QUERY_LENGTH,
  planRelaySearch,
  SEARCH_LIMIT,
  searchFilters,
  searchReach,
} from "./relay/searchRouting";
export {
  DEFAULT_OVERLAP_SECONDS,
  filterFingerprint,
  SinceTracker,
} from "./relay/sinceTracker";
export type {
  CreateSocket,
  SocketMessageEvent,
  WebSocketLike,
} from "./relay/socket";
export {
  defaultCreateSocket,
  SOCKET_CLOSED,
  SOCKET_CLOSING,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
} from "./relay/socket";
export type {
  IngestStats,
  SubscriptionManagerOptions,
} from "./relay/subscriptionManager";
export { DefaultSubscriptionManager } from "./relay/subscriptionManager";

// --- verification ------------------------------------------------------------

export type {
  BatchingEventVerifierOptions,
  VerifierStats,
  VerifySignatureFn,
} from "./verify/verifier";
export {
  BatchingEventVerifier,
  createEventVerifier,
  NoopVerifier,
} from "./verify/verifier";

// --- feeds -------------------------------------------------------------------

export { compareEntriesNewestFirst, FeedBuffer } from "./feed/feedBuffer";
export type { FeedEngineOptions } from "./feed/feedEngine";
export { FeedEngine } from "./feed/feedEngine";
export type {
  FeedDefinition,
  FeedEntry,
  FeedEntryKind,
  FeedSnapshot,
} from "./feed/feedTypes";
export type { RepostCoalescerOptions } from "./feed/repostCoalescer";
export {
  DEFAULT_REPOST_WINDOW_SECONDS,
  isRepostKind,
  RepostCoalescer,
  repostTargetId,
} from "./feed/repostCoalescer";

// --- profiles ----------------------------------------------------------------

export type {
  ProfileBatcherOptions,
  ProfileBatcherStats,
} from "./profiles/profileBatcher";
export { DefaultProfileBatcher } from "./profiles/profileBatcher";

// --- internals worth exposing ------------------------------------------------

export type { Engine, EngineOptions } from "./engine";
export { createEngine, protocolHelpers } from "./engine";
export type { BatchQueueOptions } from "./internal/batchQueue";
export { BatchQueue } from "./internal/batchQueue";
export type {
  IsValidEventShapeFn,
  MatchesFilterFn,
} from "./internal/filterMatch";
/**
 * The fallback protocol helpers. These are the defaults every constructor in this
 * package uses when nothing is injected; swap them for `@setu/protocol`'s
 * implementations at the composition root once available.
 */
export {
  isValidEventShape,
  matchesFilter,
  tagFilterKeys,
} from "./internal/filterMatch";
export type { Scheduler } from "./internal/scheduler";
export {
  defaultScheduler,
  frameScheduler,
  microtaskScheduler,
  timeoutScheduler,
} from "./internal/scheduler";
