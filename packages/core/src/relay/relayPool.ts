/**
 * `RelayPool` over WebSockets.
 *
 * The load-bearing design decision here is that **every pending request can
 * fail**. The failure mode to avoid is a relay that opens, accepts a REQ, and then
 * never sends EOSE: a naive pool leaves the handler registered and the caller
 * waiting forever with no error path. So each subscription carries a
 * timeout that resolves it as failed-but-complete, and each publish carries a
 * timeout that resolves its promise as `ok: false`. There is no code path in this
 * file that waits on a relay indefinitely.
 *
 * Secondary invariants:
 *  - one socket per normalised relay URL, opened lazily;
 *  - blocked relays are checked on **every** REQ and publish, not only at connect
 *    time, because block lists change while subscriptions are live;
 *  - a relay that repeatedly `CLOSED`s our REQs is marked `refusing` and skipped;
 *  - a failed NIP-11 fetch is not allowed to affect connecting.
 */

import type {
  EventTemplate,
  Filter,
  NostrEvent,
  RelayBasedFilter,
} from "@setu/protocol";
import { isAuthRequired } from "@setu/protocol";
import type {
  PublishResult,
  RelayHealth,
  RelayPool,
  SubscriptionCallbacks,
  SubscriptionHandle,
} from "../contracts";
import type { IsValidEventShapeFn } from "../internal/filterMatch";
import { isValidEventShape as defaultIsValidEventShape } from "../internal/filterMatch";
import type { BackoffOptions } from "./backoff";
import { CountRequests, type RelayCountResult } from "./countRequests";

import { normalizeRelayUrl } from "./normalize";
import { RelayAuthenticator } from "./relayAuth";
import { RelayConnection } from "./relayConnection";
import type { RelayLimitation } from "./relayInfo";
import type { CreateSocket } from "./socket";
import { defaultCreateSocket } from "./socket";

/** The parts of a NIP-11 relay information document the pool consumes. */
/**
 * Pool-level callbacks, extending the contract's set with the failure paths the
 * base interface does not name. Passing a plain `SubscriptionCallbacks` is still
 * valid; the extra handlers are optional.
 */
export interface PoolSubscriptionCallbacks extends SubscriptionCallbacks {
  /**
   * Fired once if some relays never EOSE'd within the timeout, with those
   * relays. `onComplete` fires immediately after, so callers always finish.
   */
  onTimeout?(relays: readonly string[]): void;
  /** Fired when a specific relay's request failed (refused, blocked, timed out). */
  onFailed?(relay: string, reason: string): void;
}

/** Construction options for {@link WebSocketRelayPool}. */
export interface RelayPoolOptions {
  /** Socket factory. Inject a fake in tests; defaults to the ambient WebSocket. */
  readonly createSocket?: CreateSocket;
  readonly backoff?: BackoffOptions;
  /** How long to wait for EOSE per subscription before failing it. */
  readonly subscriptionTimeoutMs?: number;
  /** How long to wait for `OK` per publish before failing it. */
  readonly publishTimeoutMs?: number;
  /** How long `connect()` waits for a socket to open. */
  readonly connectTimeoutMs?: number;
  /** Consecutive REQ refusals before a relay is marked `refusing`. */
  readonly refusalThreshold?: number;
  /**
   * Whether `refusing` also suppresses publishes. Default false: a relay that
   * rejects our reads may still accept our writes, and silently dropping a
   * publish is worse than a rejection we can report.
   */
  readonly refusingBlocksPublish?: boolean;
  /**
   * Signs a NIP-42 challenge answer. Omit and the pool never authenticates.
   *
   * Optional rather than required because most reads need no identity at all, and
   * a pool that cannot function without a signer would be unusable signed-out.
   */
  readonly signAuth?: (template: EventTemplate) => Promise<NostrEvent>;
  /**
   * Whether to identify this account to a given relay. Default: yes, if asked.
   *
   * Answering a challenge tells the relay who is reading. That is worth it for a
   * relay the account chose — a paid relay, a private inbox — and not obviously
   * worth it for one it merely happens to read from, so the decision is the
   * caller's rather than buried here.
   */
  readonly shouldAuthenticate?: (relay: string) => boolean;
  /** Injected structural validator for inbound EVENT frames. */
  readonly isValidEventShape?: IsValidEventShapeFn;
  /** Relay `NOTICE` frames. */
  readonly onNotice?: (relay: string, message: string) => void;
  readonly onError?: (relay: string, error: unknown) => void;
  /** Prefix for generated subscription ids. */
  readonly idPrefix?: string;
}

interface SubscriptionState {
  readonly id: string;
  readonly callbacks: PoolSubscriptionCallbacks;
  readonly filtersByRelay: Map<string, Filter[]>;
  /** Relays that have neither EOSE'd nor failed yet. */
  readonly pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
  completed: boolean;
  closed: boolean;
}

interface PendingPublish {
  readonly resolve: (result: PublishResult) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULTS = {
  subscriptionTimeoutMs: 15_000,
  publishTimeoutMs: 10_000,
  connectTimeoutMs: 8_000,
} as const;

/** WebSocket-backed relay pool. See the module doc for its invariants. */
export class WebSocketRelayPool implements RelayPool {
  private readonly connections = new Map<string, RelayConnection>();
  private readonly blocked = new Set<string>();
  private readonly subscriptions = new Map<string, SubscriptionState>();
  /** relay -> eventId -> pending publish. */
  private readonly publishes = new Map<string, Map<string, PendingPublish>>();
  /** In-flight NIP-45 counts, by subscription id. Owned by `CountRequests`. */
  /** NIP-42 state, per connection. See `relayAuth.ts`. Built in the constructor,
   * because a field initialiser runs before `options` is assigned. */
  private readonly auth: RelayAuthenticator;

  private readonly counts = new CountRequests(
    (url, frame) => this.connection(url).send(frame),
    () => `${this.options.idPrefix ?? "setu"}-count-${this.nextSubId++}`,
  );
  private readonly openWaiters = new Map<string, (() => void)[]>();
  private readonly createSocket: CreateSocket;
  private readonly isValidShape: IsValidEventShapeFn;
  private nextSubId = 1;
  private disposed = false;

  constructor(private readonly options: RelayPoolOptions = {}) {
    this.createSocket = options.createSocket ?? defaultCreateSocket;
    this.isValidShape = options.isValidEventShape ?? defaultIsValidEventShape;
    this.auth = new RelayAuthenticator({
      send: (url, frame) => this.connection(url).send(frame),
      ...(options.signAuth ? { sign: options.signAuth } : {}),
      ...(options.shouldAuthenticate
        ? { allowed: options.shouldAuthenticate }
        : {}),
      onAuthenticated: (url, subIds) => this.retryAfterAuth(url, subIds),
      onError: (url, error) => options.onError?.(url, error),
    });
  }

  /**
   * Opens sockets to `urls` and resolves once each has opened, failed or hit the
   * connect timeout. Never rejects — a dead relay is a health datum, not an error
   * for the caller to handle.
   */
  async connect(urls: readonly string[]): Promise<void> {
    const timeoutMs =
      this.options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
    await Promise.all(
      urls.map(async (raw) => {
        const url = normalizeRelayUrl(raw);
        if (url === "" || this.blocked.has(url)) return;
        const connection = this.connection(url);
        if (connection.status === "connected") return;
        connection.ensureOpen();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, timeoutMs);
          const waiters = this.openWaiters.get(url) ?? [];
          waiters.push(finish);
          this.openWaiters.set(url, waiters);
          let done = false;
          function finish(): void {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
          }
        });
      }),
    );
  }

  subscribe(
    filters: readonly RelayBasedFilter[],
    callbacks: PoolSubscriptionCallbacks,
  ): SubscriptionHandle {
    const id = `${this.options.idPrefix ?? "setu"}-${this.nextSubId++}`;
    const state: SubscriptionState = {
      id,
      callbacks,
      filtersByRelay: new Map(),
      pending: new Set(),
      timer: undefined,
      completed: false,
      closed: false,
    };
    this.subscriptions.set(id, state);

    const skipped: string[] = [];
    for (const { relay, filter } of filters) {
      const url = normalizeRelayUrl(relay);
      if (url === "") continue;
      // Blocked/refusing checks happen here, per REQ, so a block applied after
      // connect still takes effect.
      if (this.blocked.has(url)) {
        if (!skipped.includes(url)) skipped.push(url);
        continue;
      }
      if (this.connections.get(url)?.refusing === true) {
        if (!skipped.includes(url)) skipped.push(url);
        continue;
      }
      const existing = state.filtersByRelay.get(url);
      if (existing === undefined) state.filtersByRelay.set(url, [filter]);
      else existing.push(filter);
    }

    for (const url of skipped) {
      const reason = this.blocked.has(url)
        ? "relay is blocked"
        : "relay is refusing";
      queueMicrotask(() => callbacks.onFailed?.(url, reason));
    }

    if (state.filtersByRelay.size === 0) {
      // Nothing to ask: complete on the next tick so the caller has its handle.
      queueMicrotask(() => this.complete(state));
      return this.handleFor(state);
    }

    for (const [url, relayFilters] of state.filtersByRelay) {
      state.pending.add(url);
      const connection = this.connection(url);
      connection.send(["REQ", id, ...relayFilters]);
    }

    const timeoutMs =
      this.options.subscriptionTimeoutMs ?? DEFAULTS.subscriptionTimeoutMs;
    state.timer = setTimeout(() => this.timeOut(state), timeoutMs);
    return this.handleFor(state);
  }

  async publish(
    event: NostrEvent,
    relays: readonly string[],
  ): Promise<readonly PublishResult[]> {
    const timeoutMs =
      this.options.publishTimeoutMs ?? DEFAULTS.publishTimeoutMs;
    const seen = new Set<string>();
    const results: Promise<PublishResult>[] = [];

    for (const raw of relays) {
      const url = normalizeRelayUrl(raw);
      if (url === "" || seen.has(url)) continue;
      seen.add(url);

      if (this.blocked.has(url)) {
        results.push(
          Promise.resolve({
            relay: url,
            ok: false,
            message: "relay is blocked",
          }),
        );
        continue;
      }
      if (
        this.options.refusingBlocksPublish === true &&
        this.connections.get(url)?.refusing === true
      ) {
        results.push(
          Promise.resolve({
            relay: url,
            ok: false,
            message: "relay is refusing requests",
          }),
        );
        continue;
      }

      results.push(this.publishToRelay(event, url, timeoutMs));
    }
    return Promise.all(results);
  }

  health(): readonly RelayHealth[] {
    const out: RelayHealth[] = [];
    for (const [url, connection] of this.connections) {
      // Opportunistic NIP-11 refresh; never awaited, never fatal.
      const limitation = connection.limitation;
      const health: {
        url: string;
        status: RelayHealth["status"];
        failureCount: number;
        lastConnectedAt?: number;
        maxSubscriptions?: number;
        maxFilters?: number;
        refusing?: boolean;
      } = {
        url,
        status: this.blocked.has(url) ? "blocked" : connection.status,
        failureCount: connection.failureCount,
      };
      if (connection.lastConnectedAt !== undefined) {
        health.lastConnectedAt = connection.lastConnectedAt;
      }
      if (limitation?.maxSubscriptions !== undefined) {
        health.maxSubscriptions = limitation.maxSubscriptions;
      }
      if (limitation?.maxFilters !== undefined) {
        health.maxFilters = limitation.maxFilters;
      }
      if (connection.refusing) health.refusing = true;
      out.push(health);
    }
    return out;
  }

  block(url: string): void {
    const normalized = normalizeRelayUrl(url);
    if (normalized === "") return;
    this.blocked.add(normalized);
    const connection = this.connections.get(normalized);
    connection?.markBlocked();
    this.failPublishes(normalized, "relay is blocked");
    for (const state of this.subscriptions.values()) {
      if (!state.pending.has(normalized)) continue;
      state.pending.delete(normalized);
      state.callbacks.onFailed?.(normalized, "relay is blocked");
      this.maybeComplete(state);
    }
  }

  unblock(url: string): void {
    const normalized = normalizeRelayUrl(url);
    this.blocked.delete(normalized);
    // Drop the blocked connection so the next REQ opens a fresh socket.
    this.connections.delete(normalized);
  }

  close(): void {
    this.disposed = true;
    for (const state of this.subscriptions.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.closed = true;
    }
    this.subscriptions.clear();
    for (const url of [...this.publishes.keys()]) {
      this.failPublishes(url, "pool closed");
    }
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.openWaiters.clear();
  }

  // --- connection plumbing ---------------------------------------------

  private connection(url: string): RelayConnection {
    const existing = this.connections.get(url);
    if (existing !== undefined) return existing;
    const created = new RelayConnection({
      url,
      createSocket: this.createSocket,
      ...(this.options.backoff ? { backoff: this.options.backoff } : {}),
      ...(this.options.refusalThreshold !== undefined
        ? { refusalThreshold: this.options.refusalThreshold }
        : {}),
      handlers: {
        onMessage: (relay, message) => this.handleMessage(relay, message),
        onOpen: (relay, reopened) => this.handleOpen(relay, reopened),
        onDisconnect: (relay, reason) => this.handleDisconnect(relay, reason),
        onError: (relay, error) => this.options.onError?.(relay, error),
      },
    });
    this.connections.set(url, created);
    return created;
  }

  private handleOpen(url: string, reopened: boolean): void {
    const waiters = this.openWaiters.get(url);
    if (waiters !== undefined) {
      this.openWaiters.delete(url);
      for (const waiter of waiters) waiter();
    }
    if (!reopened) return;
    // Re-issue every still-pending REQ: the relay lost our subscriptions with
    // the socket, and without this a reconnect silently stops delivering.
    for (const state of this.subscriptions.values()) {
      if (state.closed) continue;
      const filters = state.filtersByRelay.get(url);
      if (filters === undefined || !state.pending.has(url)) continue;
      this.connection(url).send(["REQ", state.id, ...filters]);
    }
  }

  private handleDisconnect(url: string, reason: string): void {
    const waiters = this.openWaiters.get(url);
    if (waiters !== undefined) {
      this.openWaiters.delete(url);
      for (const waiter of waiters) waiter();
    }
    // A publish can never be answered once the socket is gone; fail it now
    // rather than letting the caller wait out the timeout.
    /*
     * AUTH is per *connection*, not per relay. A reconnected socket is a new
     * anonymous session, so keeping the flag would leave us believing we are
     * authenticated while every gated query silently returns nothing.
     */
    this.auth.reset(url);
    this.failPublishes(url, `disconnected before OK: ${reason}`);
    this.counts.failAll(url, `disconnected before COUNT: ${reason}`);
  }

  private handleMessage(url: string, message: readonly unknown[]): void {
    const type = message[0];
    if (typeof type !== "string") return;
    switch (type) {
      case "EVENT":
        this.handleEvent(url, message);
        return;
      case "EOSE":
        this.handleEose(url, message[1]);
        return;
      case "CLOSED": {
        // A relay that refuses a COUNT answers CLOSED, not silence. Settling
        // here turns a six-second wait into an immediate, accurate "cannot".
        this.counts.handleClosed(
          url,
          message[1],
          typeof message[2] === "string" ? message[2] : "closed by relay",
        );
        this.handleClosed(url, message[1], message[2]);
        return;
      }
      case "OK":
        this.handleOk(url, message[1], message[2], message[3]);
        return;
      case "COUNT":
        this.counts.handleCount(url, message[1], message[2]);
        return;
      case "AUTH":
        this.auth.onChallenge(url, message[1]);
        return;
      case "NOTICE": {
        const text = typeof message[1] === "string" ? message[1] : "";
        this.options.onNotice?.(url, text);
        return;
      }
      default:
        return;
    }
  }

  private handleEvent(url: string, message: readonly unknown[]): void {
    const subId = message[1];
    if (typeof subId !== "string") return;
    const state = this.subscriptions.get(subId);
    if (state === undefined || state.closed) return;
    const candidate = message[2];
    // Structural junk is dropped at the transport edge; signature verification
    // happens above us, in the subscription manager.
    if (!this.isValidShape(candidate)) return;
    this.connections.get(url)?.clearRefusal();
    state.callbacks.onEvent?.(candidate, url);
  }

  private handleEose(url: string, subId: unknown): void {
    if (typeof subId !== "string") return;
    const state = this.subscriptions.get(subId);
    if (state === undefined || state.closed) return;
    this.connections.get(url)?.clearRefusal();
    if (!state.pending.delete(url)) return;
    state.callbacks.onEose?.(url);
    this.maybeComplete(state);
  }

  private handleClosed(url: string, subId: unknown, reason: unknown): void {
    if (typeof subId !== "string") return;
    const state = this.subscriptions.get(subId);
    if (state === undefined || state.closed) return;
    const text = typeof reason === "string" ? reason : "closed";

    /*
     * `auth-required:` is not a refusal, it is a precondition.
     *
     * Treating it as one is how a client shows an empty screen against a paid or
     * private relay: the relay is working, it just wants to know who is asking.
     * The subscription is remembered so it can be re-sent the moment AUTH lands,
     * and the connection is *not* penalised for it.
     */
    if (isAuthRequired(text)) {
      this.auth.deferSubscription(url, subId);
      return;
    }

    // A relay refusing our REQs is a signal to stop asking it.
    this.connections.get(url)?.recordRefusal();
    state.callbacks.onClosed?.(url, text);
    if (state.pending.delete(url)) {
      state.callbacks.onFailed?.(url, text);
      this.maybeComplete(state);
    }
  }

  private handleOk(
    url: string,
    eventId: unknown,
    ok: unknown,
    message: unknown,
  ): void {
    if (typeof eventId !== "string") return;
    const byEvent = this.publishes.get(url);
    const pending = byEvent?.get(eventId);
    if (pending === undefined || byEvent === undefined) return;
    byEvent.delete(eventId);
    if (byEvent.size === 0) this.publishes.delete(url);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    const result: { relay: string; ok: boolean; message?: string } = {
      relay: url,
      ok: ok === true,
    };
    // The relay's reason is preserved verbatim — it is the only thing that tells
    // a user why their note did not land.
    if (typeof message === "string" && message !== "") result.message = message;
    pending.resolve(result);
  }

  // --- subscription lifecycle ------------------------------------------

  private handleFor(state: SubscriptionState): SubscriptionHandle {
    return {
      id: state.id,
      close: () => this.closeSubscription(state),
    };
  }

  private closeSubscription(state: SubscriptionState): void {
    if (state.closed) return;
    state.closed = true;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.subscriptions.delete(state.id);
    if (this.disposed) return;
    for (const url of state.filtersByRelay.keys()) {
      if (this.blocked.has(url)) continue;
      this.connections.get(url)?.send(["CLOSE", state.id]);
    }
  }

  private timeOut(state: SubscriptionState): void {
    state.timer = undefined;
    if (state.closed || state.completed) return;
    const stuck = [...state.pending];
    if (stuck.length === 0) {
      this.complete(state);
      return;
    }
    for (const url of stuck) {
      state.pending.delete(url);
      // A relay that accepts a REQ and never EOSEs is refusing in practice.
      this.connections.get(url)?.recordRefusal();
      state.callbacks.onFailed?.(url, "timed out waiting for EOSE");
    }
    state.callbacks.onTimeout?.(stuck);
    this.complete(state);
  }

  private maybeComplete(state: SubscriptionState): void {
    if (state.pending.size > 0) return;
    this.complete(state);
  }

  private complete(state: SubscriptionState): void {
    if (state.completed || state.closed) return;
    state.completed = true;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    state.callbacks.onComplete?.();
  }

  // --- publish lifecycle ------------------------------------------------

  private publishToRelay(
    event: NostrEvent,
    url: string,
    timeoutMs: number,
  ): Promise<PublishResult> {
    return new Promise<PublishResult>((resolve) => {
      let settled = false;
      const settle = (result: PublishResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const byEvent =
        this.publishes.get(url) ?? new Map<string, PendingPublish>();
      const pending: PendingPublish = { resolve: settle, timer: undefined };
      pending.timer = setTimeout(() => {
        const map = this.publishes.get(url);
        map?.delete(event.id);
        if (map !== undefined && map.size === 0) this.publishes.delete(url);
        settle({ relay: url, ok: false, message: "timed out waiting for OK" });
      }, timeoutMs);
      byEvent.set(event.id, pending);
      this.publishes.set(url, byEvent);
      this.connection(url).send(["EVENT", event]);
    });
  }

  /**
   * Ask each relay how many events match, without downloading them.
   *
   * The only honest way to show a total. The alternative — fetch everything and
   * count it — is what makes a client download 400 notes to render the number
   * "400", and it does not scale past a few thousand.
   *
   * Only send this to relays that advertise NIP-45. A relay that does not
   * implement COUNT neither answers nor errors: the subscription simply hangs,
   * so the timeout is what ends it rather than a safety net.
   */
  count(
    filters: readonly RelayBasedFilter[],
    timeoutMs = 6000,
  ): Promise<readonly RelayCountResult[]> {
    const byRelay = new Map<string, Filter[]>();
    for (const { relay, filter } of filters) {
      const url = normalizeRelayUrl(relay);
      if (url === "") continue;
      const list = byRelay.get(url);
      if (list) list.push(filter);
      else byRelay.set(url, [filter]);
    }
    return Promise.all(
      [...byRelay].map(([url, list]) => this.counts.ask(url, list, timeoutMs)),
    );
  }

  /** Re-send subscriptions this relay refused before we authenticated. */
  private retryAfterAuth(url: string, subIds: readonly string[]): void {
    for (const subId of subIds) {
      const state = this.subscriptions.get(subId);
      if (state === undefined || state.closed) continue;
      const filters = state.filtersByRelay.get(url);
      if (filters === undefined || filters.length === 0) continue;
      state.pending.add(url);
      this.connection(url).send(["REQ", subId, ...filters]);
    }
  }

  private failPublishes(url: string, message: string): void {
    const byEvent = this.publishes.get(url);
    if (byEvent === undefined) return;
    this.publishes.delete(url);
    for (const pending of byEvent.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.resolve({ relay: url, ok: false, message });
    }
  }

  /**
   * Apply a relay's stated ceilings to its connection.
   *
   * Pushed in rather than fetched here. The pool used to fetch NIP-11 itself, and
   * once `RelayInfoCache` existed that meant two HTTP requests per relay for the
   * same document — with two independent caches that could disagree. The cache
   * owns the fetch; the pool owns the socket and only needs the two numbers the
   * connection enforces.
   */
  setRelayLimits(url: string, limits: RelayLimitation): void {
    this.connections.get(normalizeRelayUrl(url))?.setLimitation(limits);
  }
}
