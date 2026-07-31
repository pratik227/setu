/**
 * The app's half of the NIP-46 transport seam.
 *
 * `@setu/protocol` declares {@link Nip46Transport} and never opens a socket — the
 * layer graph (`protocol ← core ← app`) forbids it, and a protocol package that
 * needs a WebSocket stops being usable from Node. So the sockets live here.
 *
 * ## Why not the relay pool
 *
 * The obvious move is to reuse `@setu/core`'s `RelayPool`, and it is the wrong one.
 * The pool is built per account by `EngineProvider` and torn down when the account
 * changes — but a bunker connection has to exist *before* there is an account, since
 * the account pubkey is the first thing we ask the signer for. Wiring sign-in through
 * an object that only exists after sign-in is a circle. It also has nothing to gain:
 * a signer connection is one filter on one or two relays the signer chose, with no
 * watermarks, no outbox routing and no store.
 *
 * ## The failure this file is shaped around
 *
 * Relays close idle sockets, and a bunker session is mostly idle — a user reads for
 * twenty minutes and then posts. If the reply subscription is not re-issued after a
 * reconnect, `publish` still succeeds (a new socket opens for the write) and the
 * answer is delivered into a subscription that no longer exists, so signing fails on
 * a deadline that reports "the signer did not answer" about a signer that did. Every
 * live REQ is therefore replayed on each open.
 */

import {
  NIP46_KIND,
  type Nip46SubscribeParams,
  type Nip46Transport,
  type NostrEvent,
  verifyEventSignature,
} from "@setu/protocol";

/** How long to wait for a socket before deciding a relay is unusable. */
const OPEN_TIMEOUT_MS = 8000;

interface Connection {
  readonly socket: WebSocket;
  open: boolean;
  readonly waiters: ((open: boolean) => void)[];
}

interface Subscription {
  readonly relays: readonly string[];
  readonly frame: string;
  readonly onEvent: (event: NostrEvent) => void;
}

let nextSubscriptionId = 0;

/** Publish/subscribe over the relays a remote signer named. */
export class BunkerTransport implements Nip46Transport {
  private readonly connections = new Map<string, Connection>();
  private readonly subscriptions = new Map<string, Subscription>();
  private closed = false;

  constructor(private readonly onError: (message: string) => void = () => {}) {}

  subscribe(
    params: Nip46SubscribeParams,
    onEvent: (event: NostrEvent) => void,
  ): () => void {
    nextSubscriptionId += 1;
    const id = `setu-nip46-${nextSubscriptionId}`;
    const frame = JSON.stringify([
      "REQ",
      id,
      {
        kinds: [NIP46_KIND],
        "#p": [params.clientPubkey],
        since: params.since,
      },
    ]);
    this.subscriptions.set(id, { relays: params.relays, frame, onEvent });
    // Only the already-open sockets are written to here. The rest is the replay in
    // `onopen`, which every live REQ goes through anyway — writing *and* queueing
    // would send the same REQ twice on the first connection.
    for (const relay of params.relays) this.send(relay, frame);
    return () => {
      if (!this.subscriptions.delete(id)) return;
      for (const relay of params.relays) {
        this.send(relay, JSON.stringify(["CLOSE", id]));
      }
    };
  }

  /**
   * Hand one event to every relay, resolving if any accepted the write.
   *
   * Deliberately not waiting for `OK`: relays disagree about whether they send one
   * for an ephemeral kind, and a bunker's own relays often stay silent. The reply
   * that matters is the signer's, and it already carries a deadline — waiting for
   * an `OK` here would put a second, redundant timeout on one exchange.
   */
  async publish(event: NostrEvent, relays: readonly string[]): Promise<void> {
    if (this.closed) throw new Error("the signer transport is closed");
    const frame = JSON.stringify(["EVENT", event]);
    const results = await Promise.all(
      relays.map(async (relay) => {
        const open = await this.waitOpen(relay);
        if (!open) return false;
        return this.send(relay, frame);
      }),
    );
    if (!results.some(Boolean)) {
      // Named rather than generic: "could not reach the signer's relays" is
      // actionable, and "the signer did not answer" — which is what a silent
      // failure here eventually looks like — is not.
      throw new Error(
        `could not reach the remote signer's relays (${relays.join(", ")})`,
      );
    }
  }

  /** Close every socket. In-flight requests are failed by the signer, not here. */
  close(): void {
    this.closed = true;
    this.subscriptions.clear();
    for (const [, connection] of this.connections) {
      // Woken with `false` first: a `publish` parked in `waitOpen` would otherwise
      // sit out its full deadline against a socket that is already being closed.
      for (const waiter of connection.waiters.splice(0)) waiter(false);
      try {
        connection.socket.close();
      } catch {
        // Already gone; nothing left to release.
      }
    }
    this.connections.clear();
  }

  /**
   * Write one frame, if the socket is open.
   *
   * There is no send queue, deliberately. Every live REQ is replayed on `onopen`
   * (see `ensure`), and the one thing that must not be dropped — an EVENT carrying a
   * request — is sent by `publish`, which waits for the socket first. A queue on top
   * of both would only give a second way for the same frame to arrive twice.
   */
  private send(relay: string, frame: string): boolean {
    if (this.closed) return false;
    const connection = this.ensure(relay);
    if (!connection?.open) return false;
    try {
      connection.socket.send(frame);
      return true;
    } catch (error) {
      this.onError(`nip46 send to ${relay} failed: ${describe(error)}`);
      return false;
    }
  }

  private waitOpen(relay: string): Promise<boolean> {
    const connection = this.ensure(relay);
    if (!connection) return Promise.resolve(false);
    if (connection.open) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (open: boolean) => {
        if (settled) return;
        settled = true;
        resolve(open);
      };
      // A deadline even here: a socket stuck in CONNECTING against a host that
      // blackholes the handshake never fires `onopen` *or* `onerror`.
      const timer = setTimeout(() => settle(false), OPEN_TIMEOUT_MS);
      connection.waiters.push((open) => {
        clearTimeout(timer);
        settle(open);
      });
    });
  }

  private ensure(relay: string): Connection | undefined {
    const existing = this.connections.get(relay);
    if (existing) return existing;
    if (this.closed) return undefined;

    let socket: WebSocket;
    try {
      socket = new WebSocket(relay);
    } catch (error) {
      this.onError(`nip46 could not open ${relay}: ${describe(error)}`);
      return undefined;
    }
    const connection: Connection = { socket, open: false, waiters: [] };
    this.connections.set(relay, connection);

    socket.onopen = () => {
      connection.open = true;
      // Every live REQ, re-issued before anything else goes out. A reconnect that
      // does not do this leaves `publish` working and the *reply* landing in a
      // subscription the relay no longer has — which reports as "the signer did not
      // answer" about a signer that answered.
      for (const [, subscription] of this.subscriptions) {
        if (!subscription.relays.includes(relay)) continue;
        try {
          socket.send(subscription.frame);
        } catch {
          // The socket died between `onopen` and here; `onclose` handles it.
        }
      }
      for (const waiter of connection.waiters.splice(0)) waiter(true);
    };

    socket.onmessage = (message) => this.onFrame(relay, message.data);

    const drop = () => {
      this.connections.delete(relay);
      connection.open = false;
      for (const waiter of connection.waiters.splice(0)) waiter(false);
    };
    socket.onclose = drop;
    socket.onerror = () => {
      // Reported but not fatal: the next request reopens, and every request has
      // its own deadline, so a flapping relay costs latency rather than a hang.
      this.onError(`nip46 relay ${relay} errored`);
      drop();
    };

    return connection;
  }

  private onFrame(relay: string, data: unknown): void {
    if (typeof data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(frame)) return;
    if (frame[0] === "NOTICE") {
      this.onError(`nip46 relay ${relay}: ${String(frame[1])}`);
      return;
    }
    if (frame[0] === "CLOSED") {
      // A relay refusing the subscription — including `auth-required:`, which a
      // bunker relay may well say. Reported, because the alternative is a signer
      // that appears to have gone silent.
      this.onError(
        `nip46 relay ${relay} closed the subscription: ${String(frame[2])}`,
      );
      return;
    }
    if (frame[0] !== "EVENT") return;
    const subscription = this.subscriptions.get(String(frame[1]));
    if (!subscription) return;
    const event = frame[2] as NostrEvent;
    /*
     * Verified here even though it is not what makes the exchange safe.
     *
     * Authentication comes from NIP-44: a reply that decrypts with the conversation
     * key between our client key and the sender could only have been produced by the
     * holder of that sender's secret. The signature check is cheap at this volume and
     * keeps a relay from spending our decryption attempts on junk.
     */
    if (!verifyEventSignature(event)) {
      this.onError(`nip46 relay ${relay} sent an event with a bad signature`);
      return;
    }
    subscription.onEvent(event);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
