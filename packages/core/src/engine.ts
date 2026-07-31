/**
 * The composition root.
 *
 * Everything below this file takes its protocol helpers by injection so it can
 * be tested without crypto and built in parallel with `@setu/protocol`. This is
 * the one place that reaches for the real implementations and wires them
 * together, so an app never has to know which pieces need which helper — and
 * there is exactly one place to audit that verification is actually connected.
 *
 * This is also the only module in `core` that imports `@setu/protocol` at
 * runtime rather than for types.
 */

import type { EventTemplate, Hex32, NostrEvent } from "@setu/protocol";
import {
  isValidEventShape,
  matchesFilter,
  sameRelay,
  verifyEventSignature,
} from "@setu/protocol";
import type {
  EventStore,
  EventVerifier,
  ProfileBatcher,
  RelayPool,
  SubscriptionManager,
} from "./contracts";
import { DefaultProfileBatcher } from "./profiles/profileBatcher";
import { OutboxRouter, type OutboxRouterOptions } from "./relay/outboxRouter";
import { RelayInfoCache } from "./relay/relayInfoCache";
import { WebSocketRelayPool } from "./relay/relayPool";
import type { CreateSocket } from "./relay/socket";
import { DefaultSubscriptionManager } from "./relay/subscriptionManager";
import { MemoryEventStore } from "./store/memoryStore";
import { BatchingEventVerifier } from "./verify/verifier";

export interface EngineOptions {
  /**
   * Relays used when a read names no author-specific route, and for publishing
   * when the caller does not name relays.
   */
  readonly relays: readonly string[];
  /**
   * Signs NIP-42 challenges. Omit for a session with no key.
   *
   * Kept out of the pool's construction args in spirit: the pool asks, the app
   * decides whether identifying to a relay is acceptable.
   */
  readonly signAuth?: (template: EventTemplate) => Promise<NostrEvent>;
  /**
   * Store implementation. Defaults to in-memory — an app that wants persistence
   * passes a `DexieEventStore`, which must be constructed with the same helpers
   * (use `protocolHelpers` below).
   */
  readonly store?: EventStore;
  /**
   * The signed-in pubkey, if any. Used only for the NIP-70 publish check: with it
   * absent, this engine refuses to rebroadcast any protected event, because it
   * cannot tell one of ours from someone else's.
   */
  readonly accountPubkey?: Hex32;
  /** Socket factory. Node callers pass a `ws` adapter; browsers can omit it. */
  readonly createSocket?: CreateSocket;
  readonly outbox?: Omit<OutboxRouterOptions, "store" | "fallbackRelays">;
  readonly onNotice?: (relay: string, message: string) => void;
  readonly onError?: (scope: string, error: unknown) => void;
}

export interface Engine {
  readonly store: EventStore;
  readonly pool: RelayPool;
  readonly verifier: EventVerifier;
  readonly subscriptions: SubscriptionManager;
  readonly outbox: OutboxRouter;
  readonly profiles: ProfileBatcher;
  /**
   * What each relay says it can do (NIP-11).
   *
   * Exposed on the engine so a settings screen can show it and a caller can route
   * by capability — "which of my relays answers COUNT" is a question only this can
   * answer, and asking one that cannot is a query that returns silence.
   */
  readonly relayInfo: RelayInfoCache;
  readonly relays: readonly string[];
  close(): void;
}

/**
 * The real protocol helpers, bundled for passing into any component that takes
 * them. Exported so an app constructing its own store gets the same behavior as
 * the engine's.
 */
export const protocolHelpers = {
  matchesFilter,
  isValidEventShape,
  verifyEventSignature,
} as const;

/** Build a fully wired engine. */
export function createEngine(options: EngineOptions): Engine {
  const onError = options.onError ?? (() => {});

  const store =
    options.store ??
    new MemoryEventStore({
      matchesFilter,
      isValidEventShape,
      onError: (e) => onError("store", e),
    });

  // Verification is wired here and nowhere else. There is no option to disable
  // it: a client that trusts a relay for authenticity is not a Nostr client.
  const verifier = new BatchingEventVerifier({
    verifySignature: verifyEventSignature,
    isValidEventShape,
  });

  const pool = new WebSocketRelayPool({
    ...(options.createSocket ? { createSocket: options.createSocket } : {}),
    /*
     * NIP-42. Without a signer the pool never authenticates, which is correct for
     * a signed-out session: there is no identity to prove.
     *
     * Scoped to `options.relays` — the relays this account configured. A relay the
     * account chose has already been trusted with its traffic; one encountered
     * through outbox routing has not, and answering its challenge would hand it a
     * pubkey it had no other way to learn.
     */
    ...(options.signAuth ? { signAuth: options.signAuth } : {}),
    shouldAuthenticate: (relay) =>
      options.relays.some((configured) => sameRelay(configured, relay)),
    isValidEventShape,
    onNotice: options.onNotice,
    onError: (relay, e) => onError(`relay:${relay}`, e),
  });

  /*
   * Relay capabilities, fetched once per relay and consulted synchronously.
   *
   * Loaded in the background and deliberately not awaited: capability data makes
   * queries better, it is never required to make them. A relay that is slow to
   * serve its NIP-11 document must not delay the first feed.
   */
  const relayInfo = new RelayInfoCache({
    onError: (relay, e) => onError(`relay-info:${relay}`, e),
  });
  /*
   * One fetch per relay, feeding both consumers.
   *
   * The connection needs `max_subscriptions` and `max_filters` to pace itself; the
   * query planner and the UI need the rest. The pool used to fetch the document
   * separately, which meant two requests per relay and two caches that could
   * disagree about the same JSON.
   */
  void relayInfo.loadAll(options.relays).then(() => {
    for (const [url, info] of relayInfo.all()) {
      pool.setRelayLimits(url, info.limitation);
    }
  });

  const outbox = new OutboxRouter({
    ...options.outbox,
    store,
    fallbackRelays: options.relays,
  });

  const subscriptions = new DefaultSubscriptionManager({
    pool,
    store,
    verifier,
    matchesFilter,
    defaultRelays: () => options.relays,
    relayInfo: (relay) => relayInfo.get(relay),
    ownPubkey: () => options.accountPubkey,
    onError: (e) => onError("subscriptions", e),
  });

  // Given the router, profile reads go to each author's own write relays and
  // only fall back to the configured set when an author has no relay list.
  const profiles = new DefaultProfileBatcher({
    store,
    subscriptions,
    relays: options.relays,
    router: outbox,
    onError: (e) => onError("profiles", e),
  });

  return {
    store,
    pool,
    verifier,
    subscriptions,
    outbox,
    profiles,
    relayInfo,
    relays: options.relays,
    close() {
      pool.close();
    },
  };
}
