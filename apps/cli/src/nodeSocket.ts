/**
 * Adapts the `ws` package to core's structural `WebSocketLike`.
 *
 * `ws` uses `addEventListener`/`on` rather than the browser's `onopen` property
 * setters, so the pool cannot consume it directly. Keeping the shim here — not
 * in `core` — is what lets the engine run unchanged in a browser, in Node, and
 * in a Tauri webview.
 */

import type { CreateSocket, WebSocketLike } from "@setu/core";
import WebSocket from "ws";

/**
 * Some relays answer 503 to a WebSocket upgrade carrying no User-Agent, which is
 * what `ws` sends by default. Browsers always send one, so this only bites in
 * Node — and it looks exactly like the relay being down.
 */
const USER_AGENT = "setu-cli/0.0.0 (+https://github.com/setu)";

export const createNodeSocket: CreateSocket = (url: string): WebSocketLike => {
  const socket = new WebSocket(url, { headers: { "User-Agent": USER_AGENT } });

  const adapter: WebSocketLike = {
    get readyState() {
      return socket.readyState;
    },
    send(data: string) {
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };

  socket.on("open", () => adapter.onopen?.());
  socket.on("message", (data) => {
    adapter.onmessage?.({ data: data.toString() });
  });
  socket.on("error", (error) => adapter.onerror?.(error));
  socket.on("close", () => adapter.onclose?.());

  return adapter;
};
