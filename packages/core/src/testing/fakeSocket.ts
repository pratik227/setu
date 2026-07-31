/**
 * A scriptable {@link WebSocketLike} for driving the relay pool in tests.
 *
 * Not part of the public barrel. It exists so relay-layer behaviour — EOSE
 * timeouts, backoff, refusal, publish `OK` handling — can be asserted without a
 * network or a real relay.
 */

import type {
  CreateSocket,
  SocketMessageEvent,
  WebSocketLike,
} from "../relay/socket";
import { SOCKET_CLOSED, SOCKET_CONNECTING, SOCKET_OPEN } from "../relay/socket";

/** A fake socket whose lifecycle the test drives explicitly. */
export class FakeSocket implements WebSocketLike {
  readyState = SOCKET_CONNECTING;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: SocketMessageEvent) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  /** Raw frames the pool sent, in order. */
  readonly sent: string[] = [];
  /** True once `close()` was called by either side. */
  closedByClient = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
    this.simulateClose();
  }

  /** Every frame the pool sent, JSON-parsed. */
  frames(): readonly unknown[][] {
    return this.sent.map((raw) => JSON.parse(raw) as unknown[]);
  }

  /** Frames of a given type, e.g. `"REQ"`. */
  framesOfType(type: string): readonly unknown[][] {
    return this.frames().filter((frame) => frame[0] === type);
  }

  /** Transitions to OPEN and fires `onopen`. */
  simulateOpen(): void {
    this.readyState = SOCKET_OPEN;
    this.onopen?.();
  }

  /** Delivers a relay-to-client message. */
  simulateMessage(message: readonly unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Delivers a raw (possibly malformed) payload. */
  simulateRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Fires `onerror` without closing, as a browser would. */
  simulateError(error: unknown = new Error("socket error")): void {
    this.onerror?.(error);
  }

  /** Transitions to CLOSED and fires `onclose`. */
  simulateClose(): void {
    this.readyState = SOCKET_CLOSED;
    this.onclose?.();
  }
}

/** Options for {@link FakeSocketFactory}. */
export interface FakeSocketFactoryOptions {
  /**
   * Open each socket automatically on the next promise microtask. Promise
   * microtasks are never faked by `vi.useFakeTimers`, so this stays reliable in
   * tests that control the clock.
   */
  readonly autoOpen?: boolean;
  /** URLs for which `createSocket` should throw, simulating an unusable relay. */
  readonly throwFor?: readonly string[];
}

/** Records every socket the pool asks for, keyed by URL. */
export class FakeSocketFactory {
  /** Every socket created, in creation order. */
  readonly sockets: FakeSocket[] = [];

  constructor(private readonly options: FakeSocketFactoryOptions = {}) {}

  /** Pass this as the pool's `createSocket`. */
  readonly create: CreateSocket = (url) => {
    if (this.options.throwFor?.includes(url) === true) {
      throw new Error(`refusing to create socket for ${url}`);
    }
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    if (this.options.autoOpen !== false) {
      void Promise.resolve().then(() => socket.simulateOpen());
    }
    return socket;
  };

  /** Number of sockets ever created for a URL (i.e. reconnect count + 1). */
  countFor(url: string): number {
    return this.sockets.filter((socket) => socket.url === url).length;
  }

  /** The most recent socket for a URL. Throws if there is none. */
  last(url: string): FakeSocket {
    for (let i = this.sockets.length - 1; i >= 0; i -= 1) {
      const socket = this.sockets[i];
      if (socket !== undefined && socket.url === url) return socket;
    }
    throw new Error(`no socket created for ${url}`);
  }

  /** Opens every socket that is still connecting. */
  openAll(): void {
    for (const socket of this.sockets) {
      if (socket.readyState === SOCKET_CONNECTING) socket.simulateOpen();
    }
  }
}

/** Yields to the microtask queue. */
export function tick(times = 1): Promise<void> {
  let promise = Promise.resolve();
  for (let i = 0; i < times; i += 1) promise = promise.then(() => undefined);
  return promise;
}
