/**
 * The WebSocket seam.
 *
 * The pool never references a global `WebSocket`. It takes a
 * {@link CreateSocket} factory, which is what makes the transport testable with
 * a fake and portable between browser, Node and Tauri without a branch in the
 * pool itself. {@link WebSocketLike} is declared structurally here rather than
 * imported from the DOM lib so this package stays headless.
 */

/** `readyState` values, mirroring the WebSocket standard. */
export const SOCKET_CONNECTING = 0;
/** @see SOCKET_CONNECTING */
export const SOCKET_OPEN = 1;
/** @see SOCKET_CONNECTING */
export const SOCKET_CLOSING = 2;
/** @see SOCKET_CONNECTING */
export const SOCKET_CLOSED = 3;

/** A message delivered to `onmessage`. */
export interface SocketMessageEvent {
  readonly data: unknown;
}

/** The subset of the WebSocket API the pool uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: SocketMessageEvent) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
}

/** Opens a socket for a relay URL. Must not throw for a well-formed URL. */
export type CreateSocket = (url: string) => WebSocketLike;

type WebSocketConstructor = new (url: string) => WebSocketLike;

/**
 * Uses the ambient `WebSocket` (browsers, Node 22+, Tauri, Deno).
 *
 * Throws if no implementation is present, which is a configuration error the
 * caller should fix by injecting `createSocket` rather than something the pool
 * should paper over.
 */
export const defaultCreateSocket: CreateSocket = (url) => {
  const ctor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (typeof ctor !== "function") {
    throw new Error(
      "No global WebSocket available; pass createSocket to the relay pool",
    );
  }
  return new ctor(url);
};
