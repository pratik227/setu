/**
 * One relay, one socket, one state machine.
 *
 * Everything about *this relay's* liveness lives here: opening lazily, queueing
 * sends issued before the socket is up, exponential-backoff reconnection, failure
 * counting, and the refusal flag. The pool above stays free to think only about
 * subscriptions and publishes.
 *
 * The one rule worth stating explicitly: **a successful open resets the backoff
 * and the failure count.** Without that, a client that has been up for a week
 * treats its first blip as attempt 40 and waits the cap before retrying.
 */

import type { Timestamp } from "@setu/protocol";
import type { RelayStatus } from "../contracts";
import type { BackoffOptions } from "./backoff";
import { computeBackoffDelay } from "./backoff";
import type { RelayLimitation } from "./relayInfo";
import type { CreateSocket, WebSocketLike } from "./socket";
import { SOCKET_OPEN } from "./socket";

/** NIP-11 fields the pool caches. */
/** Callbacks a {@link RelayConnection} reports upward to the pool. */
export interface RelayConnectionHandlers {
  /** A parsed relay-to-client message (`["EVENT", …]`, `["EOSE", …]`, …). */
  onMessage(url: string, message: readonly unknown[]): void;
  /** Socket is open. `reopened` is true for every open after the first. */
  onOpen(url: string, reopened: boolean): void;
  /** Socket went away; pending publishes on this relay can never be answered. */
  onDisconnect(url: string, reason: string): void;
  /** Non-fatal problems (unparseable frames, socket errors). */
  onError?(url: string, error: unknown): void;
}

/** Construction options for {@link RelayConnection}. */
export interface RelayConnectionOptions {
  readonly url: string;
  readonly createSocket: CreateSocket;
  readonly handlers: RelayConnectionHandlers;
  readonly backoff?: BackoffOptions;
  /** Consecutive REQ refusals before {@link RelayConnection.refusing} is set. */
  readonly refusalThreshold?: number;
  readonly now?: () => Timestamp;
}

/** A single relay socket with reconnection and refusal tracking. */
export class RelayConnection {
  /** Normalised relay URL this connection serves. */
  readonly url: string;

  private socket: WebSocketLike | undefined;
  private state: RelayStatus = "idle";
  /** True while we want a live socket; false after an explicit `close()`. */
  private desired = false;
  private everOpened = false;
  private attempt = 0;
  private failures = 0;
  private consecutiveRefusals = 0;
  private connectedAt: Timestamp | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sendQueue: string[] = [];
  private limits: RelayLimitation | undefined;
  private lastDelay = 0;
  private readonly now: () => Timestamp;

  constructor(private readonly options: RelayConnectionOptions) {
    this.url = options.url;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Current status, as reported by `RelayPool.health()`. */
  get status(): RelayStatus {
    return this.state;
  }

  /** Total socket failures observed since construction. */
  get failureCount(): number {
    return this.failures;
  }

  /** Unix seconds of the most recent successful open. */
  get lastConnectedAt(): Timestamp | undefined {
    return this.connectedAt;
  }

  /** True once the relay has refused enough REQs that we back off from it. */
  get refusing(): boolean {
    return this.consecutiveRefusals >= (this.options.refusalThreshold ?? 3);
  }

  /** Cached NIP-11 limitation values, if fetched. */
  get limitation(): RelayLimitation | undefined {
    return this.limits;
  }

  /** The delay used for the most recent reconnect. Diagnostics and tests. */
  get lastBackoffDelay(): number {
    return this.lastDelay;
  }

  /** Records cached NIP-11 values. */
  setLimitation(limitation: RelayLimitation): void {
    this.limits = limitation;
  }

  /** Counts a refused REQ (a `CLOSED` frame or an error against our REQ). */
  recordRefusal(): void {
    this.consecutiveRefusals += 1;
  }

  /** Clears the refusal streak — called on any successful EOSE. */
  clearRefusal(): void {
    this.consecutiveRefusals = 0;
  }

  /** Marks the connection blocked; no further sockets will be opened. */
  markBlocked(): void {
    this.desired = false;
    this.teardown();
    this.state = "blocked";
  }

  /** Opens the socket if it is not already open or opening. Idempotent. */
  ensureOpen(): void {
    if (this.state === "blocked") return;
    this.desired = true;
    if (this.socket !== undefined) return;
    if (this.reconnectTimer !== undefined) return;
    this.open();
  }

  /**
   * Sends a client-to-relay message, opening the socket if needed.
   *
   * Frames issued before the socket is up are queued and flushed on open. The
   * queue is dropped on disconnect: the pool re-issues its REQs on reopen, and
   * replaying a stale queue would double-subscribe.
   */
  send(message: readonly unknown[]): void {
    if (this.state === "blocked") return;
    const payload = JSON.stringify(message);
    if (this.socket !== undefined && this.socket.readyState === SOCKET_OPEN) {
      try {
        this.socket.send(payload);
      } catch (error) {
        this.options.handlers.onError?.(this.url, error);
      }
      return;
    }
    this.sendQueue.push(payload);
    this.ensureOpen();
  }

  /** Closes the socket and stops reconnecting. */
  close(): void {
    this.desired = false;
    this.teardown();
    if (this.state !== "blocked") this.state = "idle";
  }

  // --- internals --------------------------------------------------------

  private open(): void {
    this.state = this.everOpened ? "reconnecting" : "connecting";
    let socket: WebSocketLike;
    try {
      socket = this.options.createSocket(this.url);
    } catch (error) {
      this.options.handlers.onError?.(this.url, error);
      this.handleClose("createSocket threw");
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (event) => this.handleMessage(event?.data);
    socket.onerror = (error) => {
      this.options.handlers.onError?.(this.url, error);
    };
    socket.onclose = () => this.handleClose("socket closed");
  }

  private handleOpen(): void {
    const reopened = this.everOpened;
    this.everOpened = true;
    this.state = "connected";
    this.connectedAt = this.now();
    // Successful open resets both the schedule and the failure count.
    this.attempt = 0;
    this.failures = 0;
    const queued = this.sendQueue;
    this.sendQueue = [];
    for (const payload of queued) {
      try {
        this.socket?.send(payload);
      } catch (error) {
        this.options.handlers.onError?.(this.url, error);
      }
    }
    this.options.handlers.onOpen(this.url, reopened);
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown;
    if (typeof data === "string") {
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        this.options.handlers.onError?.(this.url, error);
        return;
      }
    } else {
      parsed = data;
    }
    if (!Array.isArray(parsed)) return;
    this.options.handlers.onMessage(this.url, parsed as readonly unknown[]);
  }

  private handleClose(reason: string): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    }
    this.sendQueue = [];
    this.failures += 1;
    if (this.state !== "blocked") {
      this.state = this.desired
        ? this.failures >= 3
          ? "failed"
          : "reconnecting"
        : "idle";
    }
    this.options.handlers.onDisconnect(this.url, reason);
    if (this.desired) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    this.lastDelay = computeBackoffDelay(this.attempt, this.options.backoff);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.desired) return;
      this.open();
    }, this.lastDelay);
  }

  private teardown(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.sendQueue = [];
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch (error) {
      this.options.handlers.onError?.(this.url, error);
    }
  }
}
