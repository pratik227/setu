import type { NostrEvent } from "@setu/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BunkerTransport } from "./bunkerTransport";

/**
 * The reply channel going quiet without anything looking wrong.
 *
 * This is the failure that costs a bunker user a signature. `publish` opens a socket on
 * demand and succeeds, so posting *looks* like it worked; the signer answers; and the
 * answer lands on a subscription the relay no longer has. What the user sees is a
 * twenty-second spinner and "the remote signer did not answer" about a signer that
 * answered immediately. These tests cover both ways to get there — a socket that died,
 * and a relay that ended the REQ and kept the socket up.
 */

const RELAY = "wss://relay.example.com";
const CLIENT = "a".repeat(64);

class FakeSocket {
  static opened: FakeSocket[] = [];
  onopen?: () => void;
  onmessage?: (message: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: () => void;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  send(frame: string): void {
    if (this.closed) throw new Error("socket is closed");
    this.sent.push(frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  /** Complete the handshake the transport is waiting on. */
  accept(): void {
    this.onopen?.();
  }

  /** Push a relay frame in. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  framesOfType(type: string): string[] {
    return this.sent.filter((frame) => frame.startsWith(`["${type}"`));
  }
}

const EVENT: NostrEvent = {
  id: "b".repeat(64),
  pubkey: CLIENT,
  created_at: 1,
  kind: 24133,
  tags: [["p", "c".repeat(64)]],
  content: "ciphertext",
  sig: "d".repeat(128),
};

const original = globalThis.WebSocket;

beforeEach(() => {
  FakeSocket.opened = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = original;
});

function subscribed(): {
  transport: BunkerTransport;
  socket: FakeSocket;
  id: string;
} {
  const transport = new BunkerTransport();
  transport.subscribe(
    { relays: [RELAY], clientPubkey: CLIENT, since: 0 },
    () => {},
  );
  const socket = FakeSocket.opened[0];
  if (!socket) throw new Error("no socket was opened");
  socket.accept();
  const req = socket.framesOfType("REQ")[0];
  if (!req) throw new Error("the subscription was never issued");
  return { transport, socket, id: String((JSON.parse(req) as unknown[])[1]) };
}

describe("BunkerTransport subscriptions", () => {
  it("issues the REQ once the socket is up, not before", () => {
    // There is no send queue in this class on purpose, so a REQ written to a
    // CONNECTING socket would be silently lost and the reply channel would never
    // exist at all.
    const { socket } = subscribed();
    expect(socket.framesOfType("REQ")).toHaveLength(1);
  });

  it("re-issues a subscription the relay closed under it", async () => {
    /*
     * `CLOSED` with the socket still up is invisible to every other recovery path
     * here: nothing errors, nothing disconnects, and `publish` keeps working. Without
     * this the reply channel is dead for the life of the tab while the app believes
     * it is fine.
     */
    const { transport, socket, id } = subscribed();
    socket.deliver(["CLOSED", id, "auth-required: come back with an AUTH"]);
    expect(socket.closed).toBe(true);

    const publishing = transport.publish(EVENT, [RELAY]);
    const replacement = FakeSocket.opened[1];
    expect(replacement).toBeDefined();
    replacement?.accept();
    await publishing;
    // The REQ comes back *before* the EVENT, which is the ordering that matters: a
    // reply to this request must not arrive while the subscription is missing.
    expect(replacement?.framesOfType("REQ")).toHaveLength(1);
    expect(replacement?.framesOfType("EVENT")).toHaveLength(1);
    transport.close();
  });

  it("leaves the socket alone for a CLOSED we asked for", () => {
    // A `CLOSED` crossing our own `CLOSE` on the wire is routine. Treating it as a
    // fault would tear down a working socket every time a subscription ends.
    const transport = new BunkerTransport();
    const stop = transport.subscribe(
      { relays: [RELAY], clientPubkey: CLIENT, since: 0 },
      () => {},
    );
    const socket = FakeSocket.opened[0];
    socket?.accept();
    const req = socket?.framesOfType("REQ")[0] ?? "[]";
    const id = String((JSON.parse(req) as unknown[])[1]);
    stop();
    socket?.deliver(["CLOSED", id, "closed by us"]);
    expect(socket?.closed).toBe(false);
    transport.close();
  });

  it("replays every live subscription when a dropped socket comes back", async () => {
    // The original shape of this bug: a relay closes an idle socket, `publish` opens
    // a new one for the write, and the answer lands nowhere.
    const { transport, socket } = subscribed();
    socket.close();
    const publishing = transport.publish(EVENT, [RELAY]);
    const replacement = FakeSocket.opened[1];
    replacement?.accept();
    await publishing;
    expect(replacement?.framesOfType("REQ")).toHaveLength(1);
    transport.close();
  });
});
