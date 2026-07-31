/**
 * Core engine contracts.
 *
 * The single architectural rule Setu is built on: **the event store is the only
 * source of truth, and it is the app's event bus.** Relays are writers into the
 * store; the UI is a reader of the store. Nothing else — exactly one store, and no
 * view-model cache duplicating it.
 *
 * The rule matters because the alternative decays predictably: once a second
 * in-memory graph exists alongside the store, every write has two destinations,
 * they drift, and no single place can answer what the client actually knows.
 */

import type {
  Filter,
  Hex32,
  NostrEvent,
  RelayBasedFilter,
  Timestamp,
} from "@setu/protocol";
import type { RelayCountResult } from "./relay/countRequests";

/** Where an event came from, tracked per event for outbox hints and debugging. */
export interface EventProvenance {
  readonly relays: readonly string[];
  readonly firstSeen: Timestamp;
}

export interface StoredEvent {
  readonly event: NostrEvent;
  readonly provenance: EventProvenance;
  /**
   * NIP-70: the event carries a `-` tag, so only its author may publish it and we
   * must never rebroadcast it to another relay.
   *
   * Present only when true, and derived at insert time from the event's own tags
   * by `store/protection.isProtected` — it is a convenience for callers holding a
   * row, not a second source of truth. The publish path checks the event itself,
   * so this flag can never be the thing that is wrong.
   */
  readonly protected?: true;
}

export type Unsubscribe = () => void;

/**
 * Local event store.
 *
 * Implementations must enforce, at insert time:
 *  - id dedup (merging provenance rather than duplicating the row),
 *  - replaceable (10000–19999, 0, 3) and addressable (30000–39999) last-write-
 *    wins with the NIP-01 lexical-id tiebreaker on equal `created_at`,
 *  - ephemeral kinds (20000–29999) are never stored at all,
 *  - NIP-09 deletions as *insert-blocking* rules, so a deleted event cannot be
 *    resurrected by a later relay handing it back. Enforcing this in storage is
 *    what stops correctness from depending on UI code remembering to check.
 *  - NIP-40 expiration: an event whose `expiration` tag has already passed is
 *    refused outright, and one stored while valid stops matching every read the
 *    moment its deadline arrives (see `sweepExpired` for when the row itself
 *    goes).
 *  - NIP-70 protection: an event carrying a `-` tag is stored normally and
 *    flagged on the row, so the publish path can refuse to relay one that is not
 *    ours.
 *
 * What insert time deliberately does *not* include is authenticity. `put` takes
 * an already-verified event: signatures and the id-equals-hash check belong to
 * `EventVerifier`, which the ingest path runs before it ever reaches a store.
 * The structural validator a store injects is a *shape* check only.
 */
export interface EventStore {
  /**
   * Insert a verified event. Returns false if rejected (dup/stale/deleted/
   * ephemeral/expired).
   */
  put(event: NostrEvent, relay?: string): Promise<boolean>;
  putAll(events: readonly NostrEvent[], relay?: string): Promise<number>;
  get(id: Hex32): Promise<StoredEvent | undefined>;
  /** One-shot query against local data only. */
  query(filter: Filter): Promise<readonly StoredEvent[]>;
  /**
   * Live query: emits the current matching set, then again on every change
   * that affects it. This is the app's event bus — UI subscribes here, never
   * to a relay.
   */
  observe(
    filter: Filter,
    onChange: (events: readonly StoredEvent[]) => void,
  ): Unsubscribe;
  /** Newest `created_at` held locally for a filter — drives incremental `since`. */
  newestTimestamp(filter: Filter): Promise<Timestamp | undefined>;
  count(filter: Filter): Promise<number>;
  /**
   * Deletes every event whose NIP-40 expiration has passed and wakes the
   * observers that were showing them. Returns how many rows went.
   *
   * Reads already hide expired events, so this is never needed for *correctness* —
   * it is what reclaims the space and what turns an expiry into an observer
   * callback, which is the difference between a note disappearing from a feed the
   * user is looking at and disappearing the next time they scroll. Every write
   * sweeps too, so a client receiving relay traffic needs no explicit call.
   *
   * Nothing in this package sets a timer to call it: waking a backgrounded tab is
   * a host decision, and a headless engine has no business making it. An app that
   * wants expiries to land on an idle screen schedules this itself against
   * {@link nextExpirationAt}.
   */
  sweepExpired(): Promise<number>;
  /**
   * The soonest NIP-40 deadline held, or `undefined` when nothing expires.
   *
   * Exists so the decision in `sweepExpired`'s note is actionable: this is the
   * value a host would schedule a wake-up against if it wants one.
   */
  nextExpirationAt(): Promise<Timestamp | undefined>;
  clear(): Promise<void>;
}

export type RelayStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "blocked";

export interface RelayHealth {
  readonly url: string;
  readonly status: RelayStatus;
  readonly lastConnectedAt?: Timestamp;
  readonly failureCount: number;
  /** NIP-11 advertised limits, cached once fetched. */
  readonly maxSubscriptions?: number;
  readonly maxFilters?: number;
  /** Set when the relay has repeatedly refused REQs; we back off from it. */
  readonly refusing?: boolean;
}

/** Result of publishing to one relay. */
export interface PublishResult {
  readonly relay: string;
  readonly ok: boolean;
  /** Relay-supplied reason on rejection — surface this, never swallow it. */
  readonly message?: string;
}

export interface SubscriptionHandle {
  readonly id: string;
  close(): void;
}

export interface SubscriptionCallbacks {
  onEvent?(event: NostrEvent, relay: string): void;
  /** Fired per relay as it finishes its stored-event replay. */
  onEose?(relay: string): void;
  /** Fired once every relay in the set has EOSE'd or failed. */
  onComplete?(): void;
  onClosed?(relay: string, reason: string): void;
}

/**
 * Relay transport. Deliberately low-level and never handed to UI code: a pool
 * exposed to views invites per-component subscriptions, which is how a client
 * exhausts a relay's subscription cap. Everything above it goes through
 * SubscriptionManager.
 */
export interface RelayPool {
  connect(urls: readonly string[]): Promise<void>;
  /** Per-relay filters, so outbox routing is expressible by construction. */
  subscribe(
    filters: readonly RelayBasedFilter[],
    callbacks: SubscriptionCallbacks,
  ): SubscriptionHandle;
  publish(
    event: NostrEvent,
    relays: readonly string[],
  ): Promise<readonly PublishResult[]>;
  /**
   * NIP-45 COUNT: how many events match, without downloading them.
   *
   * Only meaningful against relays that advertise NIP-45 — others neither answer
   * nor error, so the caller must filter first (see `relaysFor`).
   */
  count(
    filters: readonly RelayBasedFilter[],
    timeoutMs?: number,
  ): Promise<readonly RelayCountResult[]>;
  health(): readonly RelayHealth[];
  block(url: string): void;
  unblock(url: string): void;
  close(): void;
}

/**
 * How a read should be satisfied.
 *
 * The point is that switching a screen between "local only" and "local +
 * network" is a parameter, not a rewrite.
 */
export type ReadMode =
  | { readonly type: "localOnly" }
  | { readonly type: "localThenNetwork" }
  | { readonly type: "localAndNetworkParallel" };

export interface ReadRequest {
  readonly filters: readonly RelayBasedFilter[];
  readonly mode?: ReadMode;
  /**
   * Rewrite each filter's `since` to just before the newest event already held
   * locally, so a reconnect backfills the gap instead of refetching history.
   * Tracked per relay — a global `since` is wrong the moment relays disagree,
   * because a global watermark silently drops whatever the lagging relay owed.
   */
  readonly incremental?: boolean;
}

/**
 * The single read API for the whole app. UI code touches this and the store,
 * never the pool.
 */
export interface SubscriptionManager {
  /** Live subscription; events land in the store, caller observes the store. */
  subscribe(request: ReadRequest): SubscriptionHandle;
  /** One-shot: resolves when every relay has EOSE'd or timed out. */
  fetch(request: ReadRequest): Promise<readonly NostrEvent[]>;
  /** Publish with local echo first, then fan out to relays. */
  publish(
    event: NostrEvent,
    relays?: readonly string[],
  ): Promise<readonly PublishResult[]>;
}

/**
 * Batched profile (kind 0) and relay-list (kind 10002) loader.
 *
 * Relays cap concurrent subscriptions, so per-view profile fetching does not
 * scale. All demand across the app coalesces into a few rate-limited
 * subscriptions.
 */
export interface ProfileBatcher {
  /** Register interest; returns immediately, resolution arrives via the store. */
  request(pubkeys: readonly Hex32[]): void;
  flush(): Promise<void>;
}

/** Verification is always on; it is batched off the receive path, never skipped. */
export interface EventVerifier {
  verify(event: NostrEvent): Promise<boolean>;
  verifyAll(events: readonly NostrEvent[]): Promise<readonly NostrEvent[]>;
}
