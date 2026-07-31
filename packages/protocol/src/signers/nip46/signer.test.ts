import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyEventSignature } from "../../event";
import { decryptNip04, encryptNip04 } from "../../nip04";
import type { Hex32, NostrEvent } from "../../types";
import { generateSecretKey, LocalSigner } from "../local";
import { type Nip46Scheme, schemeOf } from "./codec";
import { startNostrConnect } from "./connect";
import type { Nip46Response } from "./rpc";
import { type Nip46Health, Nip46Signer } from "./signer";
import {
  NIP46_KIND,
  type Nip46SubscribeParams,
  type Nip46Transport,
} from "./transport";

const RELAYS = ["wss://relay.example.com"] as const;

/** What a fake bunker does with one request. `"silence"` is the interesting one. */
type Answer = Omit<Nip46Response, "id"> | "silence";

interface SeenRequest {
  readonly id: string;
  readonly method: string;
  readonly params: readonly string[];
}

/** One frame as the fake received it, whether or not it could open it. */
interface SeenFrame {
  readonly scheme: Nip46Scheme;
  readonly readable: boolean;
}

/**
 * A remote signer at the other end of the transport seam.
 *
 * Real encryption in both directions and a real account key doing the signing, because
 * the cases worth testing — an answer for the wrong account, a reply from a key we
 * never asked, a signer that cannot read the envelope at all — are exactly the ones a
 * stubbed-out crypto layer cannot express.
 *
 * `reads` is what makes a legacy signer expressible. A signer that cannot decrypt a
 * frame has no way to say so, so this fake does what a real one does: nothing at all.
 */
class FakeBunker implements Nip46Transport {
  /** Kept as bytes as well, because NIP-04 needs the raw key. */
  readonly signerSecret = generateSecretKey();
  readonly signer = LocalSigner.fromSecretKey(this.signerSecret);
  readonly account = LocalSigner.fromSecretKey(generateSecretKey());
  readonly requests: SeenRequest[] = [];
  /** Every frame handed to this fake, in order, readable or not. */
  readonly frames: SeenFrame[] = [];
  /** Which encryptions this signer understands. */
  reads: readonly Nip46Scheme[] = ["nip44"];
  /** Which encryption it answers in. Defaults to whatever it was asked in. */
  answersIn?: Nip46Scheme;
  publishFails = false;
  /** Override the default behaviour for one method; `undefined` falls through. */
  reply: (request: SeenRequest) => Answer | undefined = () => undefined;

  private readonly listeners = new Set<{
    clientPubkey: Hex32;
    onEvent: (event: NostrEvent) => void;
  }>();

  get signerPubkey(): Hex32 {
    return this.signer.pubkeySync();
  }

  get accountPubkey(): Hex32 {
    return this.account.pubkeySync();
  }

  subscribe(
    params: Nip46SubscribeParams,
    onEvent: (event: NostrEvent) => void,
  ): () => void {
    const entry = { clientPubkey: params.clientPubkey, onEvent };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  async publish(event: NostrEvent): Promise<void> {
    if (this.publishFails) throw new Error("no relay accepted it");
    const scheme = schemeOf(event.content);
    const readable = this.reads.includes(scheme);
    this.frames.push({ scheme, readable });
    if (!readable) return;
    const payload = await this.read(event.pubkey, event.content, scheme);
    const parsed = JSON.parse(payload) as SeenRequest;
    this.requests.push(parsed);
    const answer = this.reply(parsed) ?? (await this.defaultAnswer(parsed));
    if (answer === "silence") return;
    await this.send(
      event.pubkey,
      { ...answer, id: parsed.id },
      this.signer,
      this.answersIn ?? scheme,
    );
  }

  /** Frames of one scheme, for asserting what did and did not go out. */
  framesIn(scheme: Nip46Scheme): readonly SeenFrame[] {
    return this.frames.filter((frame) => frame.scheme === scheme);
  }

  /** The id of the last request for a method, so a test can answer it by hand. */
  lastId(method: string): string {
    const found = [...this.requests].reverse().find((r) => r.method === method);
    if (!found) throw new Error(`no ${method} request was made`);
    return found.id;
  }

  /** Push a response to a client, encrypted from a key of our choosing. */
  async send(
    clientPubkey: Hex32,
    response: Nip46Response,
    from: LocalSigner = this.signer,
    scheme: Nip46Scheme = "nip44",
  ): Promise<void> {
    const json = JSON.stringify(response);
    // NIP-04 needs the raw secret, which only this fake's own signer key exposes,
    // so the impostor cases (`from` set to a stranger) are all NIP-44.
    const content =
      scheme === "nip04"
        ? encryptNip04(this.signerSecret, clientPubkey, json)
        : await from.nip44Encrypt(clientPubkey, json);
    const event = await from.signEvent({
      kind: NIP46_KIND,
      content,
      tags: [["p", clientPubkey]],
    });
    for (const listener of this.listeners) {
      if (listener.clientPubkey === clientPubkey) listener.onEvent(event);
    }
  }

  private read(
    peer: Hex32,
    content: string,
    scheme: Nip46Scheme,
  ): Promise<string> {
    return scheme === "nip04"
      ? Promise.resolve(decryptNip04(this.signerSecret, peer, content))
      : this.signer.nip44Decrypt(peer, content);
  }

  private async defaultAnswer(
    request: SeenRequest,
  ): Promise<Omit<Nip46Response, "id">> {
    const [first = "", second = ""] = request.params;
    switch (request.method) {
      case "connect":
        return { result: "ack" };
      case "ping":
        return { result: "pong" };
      case "get_public_key":
        return { result: this.accountPubkey };
      case "sign_event": {
        const draft = JSON.parse(first) as {
          kind: number;
          content: string;
          tags: string[][];
          created_at: number;
        };
        return { result: JSON.stringify(await this.account.signEvent(draft)) };
      }
      case "nip44_encrypt":
        return { result: await this.account.nip44Encrypt(first, second) };
      case "nip44_decrypt":
        return { result: await this.account.nip44Decrypt(first, second) };
      default:
        return { error: `unknown method ${request.method}` };
    }
  }
}

let bunker: FakeBunker;
let clientSecret: Uint8Array;

beforeEach(() => {
  bunker = new FakeBunker();
  clientSecret = generateSecretKey();
});

function connect(
  overrides: Partial<Parameters<typeof Nip46Signer.connect>[0]> = {},
) {
  return Nip46Signer.connect({
    transport: bunker,
    clientSecret,
    remoteSignerPubkey: bunker.signerPubkey,
    relays: RELAYS,
    secret: "s3cr3t",
    timeoutMs: 300,
    connectTimeoutMs: 300,
    ...overrides,
  });
}

describe("Nip46Signer.connect", () => {
  it("handshakes, then learns the account from get_public_key", async () => {
    const signer = await connect();
    expect(signer.kind).toBe("nip46");
    // The account is *not* the signer's key. A bunker's key is per-connection, so
    // taking it as the identity gives a session that is wrong in every direction.
    expect(await signer.pubkey()).toBe(bunker.accountPubkey);
    expect(await signer.pubkey()).not.toBe(bunker.signerPubkey);
    expect(bunker.requests.map((r) => r.method)).toEqual([
      "connect",
      "get_public_key",
    ]);
    signer.close();
  });

  it("uses request ids that differ per request", async () => {
    const signer = await connect();
    await signer.ping();
    const ids = new Set(bunker.requests.map((r) => r.id));
    expect(ids.size).toBe(bunker.requests.length);
    signer.close();
  });

  it("passes the secret through the handshake and nowhere else", async () => {
    const signer = await connect();
    const handshake = bunker.requests[0];
    expect(handshake?.params[0]).toBe(bunker.signerPubkey);
    expect(handshake?.params[1]).toBe("s3cr3t");
    await signer.ping();
    for (const request of bunker.requests.slice(1)) {
      expect(request.params.join("|")).not.toContain("s3cr3t");
    }
    signer.close();
  });

  it("gives up on a signer that never answers", async () => {
    // The failure this design exists for: a bunker that neither answers nor errors
    // would otherwise leave the sign-in button spinning forever.
    bunker.reply = () => "silence";
    await expect(connect()).rejects.toThrow(/did not answer connect/);
  });

  it("reports a refusal with the signer's own reason", async () => {
    bunker.reply = (request) =>
      request.method === "connect" ? { error: "user declined" } : undefined;
    await expect(connect()).rejects.toThrow(/refused connect: user declined/);
  });

  it("fails fast when the publish itself fails", async () => {
    // Instantly, not after the full deadline: reporting twenty seconds of silence
    // for a socket that failed at once teaches the user to distrust the message.
    bunker.publishFails = true;
    await expect(connect()).rejects.toThrow(/could not be sent/);
  });

  it("refuses a malformed public key", async () => {
    bunker.reply = (request) =>
      request.method === "get_public_key" ? { result: "nope" } : undefined;
    await expect(connect()).rejects.toThrow(/malformed public key/);
  });
});

describe("Nip46Signer approval prompts", () => {
  it("reports an auth_url and keeps waiting for the real answer", async () => {
    const onAuthChallenge = vi.fn();
    const signer = await connect({ onAuthChallenge });
    bunker.reply = (request) =>
      request.method === "sign_event" ? "silence" : undefined;
    const signing = signer.signEvent({ kind: 1, content: "hello" });
    // Let the request reach the bunker before answering it by hand.
    await vi.waitFor(() => bunker.lastId("sign_event"));
    const id = bunker.lastId("sign_event");
    await bunker.send(signer.clientPubkey, {
      id,
      result: "auth_url",
      error: "https://bunker.example/approve",
    });
    // Waited for rather than asserted straight after `send`: an inbound frame is
    // decrypted asynchronously, and how many microtasks that takes is an internal
    // detail of the codec — a test that depends on the exact number fails the next
    // time a scheme check is added to the decrypt path.
    await vi.waitFor(() =>
      expect(onAuthChallenge).toHaveBeenCalledWith(
        "https://bunker.example/approve",
        "sign_event",
      ),
    );
    const signed = await bunker.account.signEvent({
      kind: 1,
      content: "hello",
    });
    await bunker.send(signer.clientPubkey, {
      id,
      result: JSON.stringify(signed),
    });
    // The note is signed, not resolved with the string "auth_url".
    await expect(signing).resolves.toMatchObject({ id: signed.id });
    signer.close();
  });
});

describe("Nip46Signer.signEvent", () => {
  it("returns the signer's event, verifiable and attributed to the account", async () => {
    const signer = await connect();
    const event = await signer.signEvent({ kind: 1, content: "hello" });
    expect(event.pubkey).toBe(bunker.accountPubkey);
    expect(verifyEventSignature(event)).toBe(true);
    signer.close();
  });

  it("refuses an event signed by a different key", async () => {
    // Otherwise a note attributed to a stranger reaches the store, which is the
    // source of truth for the whole app and has no second chance to reject it.
    const signer = await connect();
    const forged = await LocalSigner.generate().signEvent({
      kind: 1,
      content: "not yours",
    });
    bunker.reply = (request) =>
      request.method === "sign_event"
        ? { result: JSON.stringify(forged) }
        : undefined;
    await expect(signer.signEvent({ kind: 1, content: "x" })).rejects.toThrow(
      /signed by a different key/,
    );
    signer.close();
  });

  it("refuses an event of the wrong kind", async () => {
    const signer = await connect();
    const wrongKind = await bunker.account.signEvent({ kind: 7, content: "+" });
    bunker.reply = (request) =>
      request.method === "sign_event"
        ? { result: JSON.stringify(wrongKind) }
        : undefined;
    await expect(signer.signEvent({ kind: 1, content: "x" })).rejects.toThrow(
      /different kind/,
    );
    signer.close();
  });

  it("refuses a malformed or non-JSON answer", async () => {
    const signer = await connect();
    bunker.reply = (request) =>
      request.method === "sign_event" ? { result: "{}" } : undefined;
    await expect(signer.signEvent({ kind: 1, content: "x" })).rejects.toThrow(
      /malformed event/,
    );
    bunker.reply = (request) =>
      request.method === "sign_event" ? { result: "not json" } : undefined;
    await expect(signer.signEvent({ kind: 1, content: "x" })).rejects.toThrow(
      /non-JSON event/,
    );
    signer.close();
  });

  it("times out rather than hanging the compose dialog", async () => {
    const signer = await connect();
    bunker.reply = (request) =>
      request.method === "sign_event" ? "silence" : undefined;
    await expect(signer.signEvent({ kind: 1, content: "x" })).rejects.toThrow(
      /did not answer sign_event/,
    );
    signer.close();
  });
});

describe("Nip46Signer NIP-44 delegation", () => {
  it("declares both methods, so private messages are not silently unavailable", async () => {
    const signer = await connect();
    expect(typeof signer.nip44Encrypt).toBe("function");
    expect(typeof signer.nip44Decrypt).toBe("function");
    signer.close();
  });

  it("round-trips through the account key held by the signer", async () => {
    const signer = await connect();
    const peer = LocalSigner.generate();
    const peerPubkey = peer.pubkeySync();
    const ciphertext = await signer.nip44Encrypt(peerPubkey, "hidden");
    // The peer can read it, which proves the bunker used the *account* key rather
    // than the throwaway client key this connection signs its RPC with.
    expect(await peer.nip44Decrypt(bunker.accountPubkey, ciphertext)).toBe(
      "hidden",
    );
    expect(await signer.nip44Decrypt(peerPubkey, ciphertext)).toBe("hidden");
    signer.close();
  });
});

describe("Nip46Signer.resume", () => {
  it("reattaches without a second handshake", async () => {
    const signer = await Nip46Signer.resume({
      transport: bunker,
      clientSecret,
      remoteSignerPubkey: bunker.signerPubkey,
      relays: RELAYS,
      userPubkey: bunker.accountPubkey,
      timeoutMs: 300,
    });
    // No `connect`: the client key is already authorised, and re-handshaking would
    // prompt the user on every reload.
    expect(bunker.requests.map((r) => r.method)).toEqual(["get_public_key"]);
    signer.close();
  });

  it("refuses when the signer now speaks for a different account", async () => {
    const stranger = LocalSigner.generate();
    await expect(
      Nip46Signer.resume({
        transport: bunker,
        clientSecret,
        remoteSignerPubkey: bunker.signerPubkey,
        relays: RELAYS,
        userPubkey: stranger.pubkeySync(),
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/different account/);
  });
});

describe("Nip46Signer.close", () => {
  it("fails work in flight instead of leaving it pending", async () => {
    const signer = await connect();
    bunker.reply = (request) =>
      request.method === "ping" ? "silence" : undefined;
    const inFlight = signer.ping();
    signer.close();
    await expect(inFlight).rejects.toThrow(/connection was closed/);
    await expect(signer.ping()).rejects.toThrow(/connection is closed/);
  });
});

describe("the reply channel is not a trust boundary", () => {
  it("ignores a correctly-addressed reply from a key we never asked", async () => {
    const signer = await connect();
    bunker.reply = (request) =>
      request.method === "ping" ? "silence" : undefined;
    const inFlight = signer.ping();
    await vi.waitFor(() => bunker.lastId("ping"));
    const impostor = LocalSigner.generate();
    await bunker.send(
      signer.clientPubkey,
      { id: bunker.lastId("ping"), result: "pong" },
      impostor,
    );
    await expect(inFlight).rejects.toThrow(/did not answer ping/);
    signer.close();
  });
});

describe("startNostrConnect", () => {
  it("adopts the signer that echoes our secret", async () => {
    const handshake = startNostrConnect({
      transport: bunker,
      clientSecret,
      relays: RELAYS,
      secret: "abc123",
      timeoutMs: 500,
      handshakeTimeoutMs: 500,
      metadata: { name: "Setu" },
    });
    expect(handshake.uri.startsWith("nostrconnect://")).toBe(true);
    expect(handshake.uri).toContain("secret=abc123");
    await bunker.send(handshake.clientPubkey, { id: "1", result: "abc123" });
    const signer = await handshake.signer;
    expect(await signer.pubkey()).toBe(bunker.accountPubkey);
    expect(signer.remoteSignerPubkey).toBe(bunker.signerPubkey);
    signer.close();
  });

  it("ignores an answer that does not carry the secret", async () => {
    // The echo is the whole authentication step: the URI is published to a relay
    // and to a screen, so the first party to answer must not become the signer.
    const handshake = startNostrConnect({
      transport: bunker,
      clientSecret,
      relays: RELAYS,
      secret: "abc123",
      timeoutMs: 100,
      handshakeTimeoutMs: 100,
    });
    await bunker.send(
      handshake.clientPubkey,
      { id: "1", result: "wrong" },
      LocalSigner.generate(),
    );
    await expect(handshake.signer).rejects.toThrow(/no remote signer answered/);
  });

  it("rejects when cancelled, rather than leaving the caller waiting", async () => {
    const handshake = startNostrConnect({
      transport: bunker,
      clientSecret,
      relays: RELAYS,
      handshakeTimeoutMs: 60_000,
    });
    handshake.cancel();
    await expect(handshake.signer).rejects.toThrow(/cancelled/);
  });
});

/** Waits past a probe deadline. Real timers, because the probe uses one. */
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The client key's public half, needed before `connect` has resolved. */
const clientPubkeyOf = () =>
  LocalSigner.fromSecretKey(clientSecret).pubkeySync();

describe("a signer that speaks only NIP-04", () => {
  it("is reachable at all, rather than looking asleep", async () => {
    /*
     * The gap this closes. A legacy signer cannot decrypt a NIP-44 request and has no
     * way to say so, so before the NIP-04 copy existed the connection failed on its
     * deadline with "the remote signer did not answer" — pointing the user at their
     * phone when the problem was the envelope. The fake reproduces exactly that: an
     * unreadable frame produces no reply and no error.
     */
    bunker.reads = ["nip04"];
    const signer = await connect({
      schemeProbeMs: 20,
      connectTimeoutMs: 2000,
      timeoutMs: 2000,
    });
    expect(await signer.pubkey()).toBe(bunker.accountPubkey);
    // Modern first, always: the copy is a fallback, not the default.
    expect(bunker.frames[0]).toEqual({ scheme: "nip44", readable: false });
    expect(bunker.framesIn("nip04")).toContainEqual({
      scheme: "nip04",
      readable: true,
    });
    signer.close();
  });

  it("is not asked in NIP-44 again once it has answered", async () => {
    // Otherwise every single request pays the probe delay for the whole life of the
    // connection, and posting a note takes seconds longer than it needs to.
    bunker.reads = ["nip04"];
    const signer = await connect({
      schemeProbeMs: 20,
      connectTimeoutMs: 2000,
      timeoutMs: 2000,
    });
    const before = bunker.frames.length;
    await signer.ping();
    expect(bunker.frames.slice(before).map((frame) => frame.scheme)).toEqual([
      "nip04",
    ]);
    signer.close();
  });

  it("still has its answers checked as strictly as a modern one", async () => {
    // A weaker envelope must not buy a weaker check. NIP-04 has no integrity at all,
    // so if anything the signed-by-the-wrong-key case matters *more* here.
    bunker.reads = ["nip04"];
    const signer = await connect({
      schemeProbeMs: 20,
      connectTimeoutMs: 2000,
      timeoutMs: 2000,
    });
    const forged = await LocalSigner.generate().signEvent({
      kind: 1,
      content: "not yours",
    });
    bunker.reply = (request) =>
      request.method === "sign_event"
        ? { result: JSON.stringify(forged) }
        : undefined;
    await expect(signer.signEvent({ kind: 1, content: "x" })).rejects.toThrow(
      /signed by a different key/,
    );
    signer.close();
  });
});

describe("a signer that speaks NIP-44", () => {
  it("is never sent a NIP-04 copy of anything", async () => {
    // A downgrade nobody forced gives up NIP-44's integrity for nothing, and a second
    // copy of a request is a second thing the signer may prompt about.
    const signer = await connect({ schemeProbeMs: 20 });
    await signer.ping();
    await settle(60);
    expect(bunker.framesIn("nip04")).toHaveLength(0);
    signer.close();
  });

  it("is not asked twice while it is waiting on a human", async () => {
    /*
     * `auth_url` is a signer saying "I read this and I am asking the user". Sending
     * the NIP-04 copy after that would put a second approval prompt on their phone
     * for one action — so any frame that decrypts cancels the probe.
     */
    bunker.reads = ["nip44", "nip04"];
    const onAuthChallenge = vi.fn();
    bunker.reply = (request) =>
      request.method === "connect" ? "silence" : undefined;
    // Comfortably longer than the poll below takes to notice the request: the
    // assertion is about the probe being *cancelled*, not about winning a race.
    const connecting = connect({
      schemeProbeMs: 250,
      connectTimeoutMs: 3000,
      timeoutMs: 3000,
      onAuthChallenge,
    });
    const client = clientPubkeyOf();
    await vi.waitFor(() => bunker.lastId("connect"));
    const id = bunker.lastId("connect");
    await bunker.send(client, {
      id,
      result: "auth_url",
      error: "https://bunker.example/approve",
    });
    await vi.waitFor(() => expect(onAuthChallenge).toHaveBeenCalled());
    await settle(300);
    expect(bunker.framesIn("nip04")).toHaveLength(0);
    await bunker.send(client, { id, result: "ack" });
    const signer = await connecting;
    signer.close();
  });

  it("carries the scheme learned during a nostrconnect handshake into the signer", async () => {
    // The echo is the one frame a signer sends before we ask it anything, so it is
    // free evidence. Throwing it away would make the new connection re-probe a peer
    // whose scheme is already settled — and for a legacy signer that means the first
    // real request goes out in an envelope it cannot open.
    bunker.reads = ["nip04"];
    const handshake = startNostrConnect({
      transport: bunker,
      clientSecret,
      relays: RELAYS,
      secret: "abc123",
      timeoutMs: 2000,
      handshakeTimeoutMs: 2000,
    });
    await bunker.send(
      handshake.clientPubkey,
      { id: "1", result: "abc123" },
      bunker.signer,
      "nip04",
    );
    const signer = await handshake.signer;
    // `get_public_key` went straight out in NIP-04: no unreadable frame, no probe.
    expect(bunker.framesIn("nip44")).toHaveLength(0);
    expect(await signer.pubkey()).toBe(bunker.accountPubkey);
    signer.close();
  });
});

describe("keep-alive", () => {
  it("pings only while the connection is idle", async () => {
    // A ping racing a real request costs the user latency on the one call they are
    // watching, and a request that is being answered is better evidence anyway.
    const signer = await connect({ keepAliveMs: 40 });
    await vi.waitFor(() =>
      expect(bunker.requests.some((r) => r.method === "ping")).toBe(true),
    );
    signer.close();
  });

  it("reports a signer that has gone away, and says so on the next request", async () => {
    /*
     * The failure this exists for: an idle bunker connection dies silently, and
     * without a heartbeat the user discovers it by pressing Post and watching a
     * spinner for the full request deadline, after which the error blames the signer
     * for not answering a request it never received. Here the connection is known
     * dead before the user asks for anything, and the request that follows says
     * "reconnect" instead.
     */
    const health: Nip46Health[] = [];
    const signer = await connect({
      keepAliveMs: 20,
      timeoutMs: 40,
      onHealth: (next) => health.push(next),
    });
    bunker.reply = () => "silence";
    await vi.waitFor(() => expect(health).toEqual(["unreachable"]), {
      timeout: 3000,
    });
    expect(signer.health).toBe("unreachable");
    await expect(signer.signEvent({ kind: 1, content: "x" })).rejects.toThrow(
      /needs to be reconnected/,
    );
    signer.close();
  });

  it("goes back to alive when the signer returns", async () => {
    // A relay reconnect drops a ping, and a connection that could never recover from
    // being called dead would send the user to the sign-in screen over a blip.
    const health: Nip46Health[] = [];
    const signer = await connect({
      keepAliveMs: 20,
      timeoutMs: 40,
      onHealth: (next) => health.push(next),
    });
    bunker.reply = () => "silence";
    await vi.waitFor(() => expect(health).toEqual(["unreachable"]), {
      timeout: 3000,
    });
    bunker.reply = () => undefined;
    await vi.waitFor(() => expect(health.at(-1)).toBe("alive"), {
      timeout: 3000,
    });
    signer.close();
  });

  it("counts an error reply as proof of life", async () => {
    // A signer old enough to lack `ping` answers `{"error":"unknown method"}`. That is
    // a live signer, and treating the rejected ping as a miss would declare a working
    // connection dead every couple of minutes.
    const health: Nip46Health[] = [];
    const signer = await connect({
      keepAliveMs: 20,
      timeoutMs: 40,
      onHealth: (next) => health.push(next),
    });
    bunker.reply = (request) =>
      request.method === "ping" ? { error: "unknown method ping" } : undefined;
    await settle(200);
    expect(health).toEqual([]);
    expect(signer.health).toBe("alive");
    signer.close();
  });

  it("is off unless a caller asks for it", async () => {
    // The protocol package must not start a repeating timer nobody asked for: a
    // headless or test caller has no idle socket to protect and no way to stop one.
    const signer = await connect();
    await settle(120);
    expect(bunker.requests.some((r) => r.method === "ping")).toBe(false);
    signer.close();
  });
});
