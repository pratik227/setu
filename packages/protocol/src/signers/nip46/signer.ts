/**
 * NIP-46 remote ("bunker") signer.
 *
 * The account's key lives in another program. Every operation is a JSON-RPC call
 * encrypted between a *client key* Setu generates and the signer's key, carried as
 * kind-24133 events over relays the signer named. The client key is not the account:
 * it is a per-connection identity whose only privilege is the one the user granted
 * when they approved the connection.
 *
 * ## What must be checked on the way back in
 *
 * A bunker is a remote party, so its answers are untrusted input like anything else
 * crossing a process boundary:
 *
 *  - **`sign_event` results are checked against the account pubkey.** A signer that
 *    returns an event signed by some other key would otherwise put a note into the
 *    store attributed to a stranger, and the store is the source of truth for the
 *    whole app — nothing downstream would question it.
 *  - **The account pubkey comes from `get_public_key`, never from the URI.** The key
 *    in a `bunker://` URI belongs to the signer, and for hosted bunkers it is a
 *    per-connection key with no relationship to the account. See `uri.ts`.
 *  - **Every call has a deadline.** See `rpc.ts` — that is the failure this design
 *    spends the most effort on, because a signer that never answers is the normal
 *    case, not the exceptional one.
 *
 * ## Two encryptions, chosen by evidence
 *
 * Requests go out in NIP-44 and replies are read in whichever scheme they arrive in
 * (`codec.ts`). A signer that answers in NIP-04 has proved it cannot read NIP-44, so
 * everything after that point is sent in NIP-04 too — and because a signer that cannot
 * read our first request also cannot tell us so, the *first* request is followed by a
 * NIP-04 copy if nothing at all comes back within {@link SCHEME_PROBE_MS}. Without
 * that copy a legacy signer is unreachable and looks exactly like a signer that is
 * asleep. The copy is deliberately late and deliberately conditional: an `auth_url`,
 * or any other frame on the same id, cancels it, so a signer that reads both schemes
 * and is merely waiting on a human is not asked twice.
 *
 * ## An idle connection is proved, not assumed
 *
 * A bunker session is mostly idle — read for twenty minutes, then post — and relays
 * drop idle subscriptions and sockets. With `keepAliveMs` set, a `ping` goes out
 * whenever nothing has been heard for that long, which both keeps the socket in use
 * and turns a signer that has gone away into a *known* state within a couple of
 * intervals instead of a surprise at the moment the user presses Post. Once the
 * connection is known dead, requests stop waiting the full deadline for it and say so
 * — the point is that "reconnect your signer" reaches the user instead of a
 * twenty-second spinner followed by a timeout that blames the signer's silence.
 *
 * ## Private messages
 *
 * `nip44Encrypt`/`nip44Decrypt` are always present, and they delegate. They cannot be
 * done locally — the conversation key needs the account's secret, which is the one
 * thing a bunker never hands out — so each call is a round trip. That is slow, and
 * declaring them absent instead would be worse: `useDirectMessages` gates on
 * `signer.nip44Decrypt`, so a bunker user would find private messages missing with no
 * explanation rather than working and taking a moment.
 */

import { isValidEventShape } from "../../event";
import { isHex32 } from "../../hex";
import type {
  EventTemplate,
  Hex32,
  NostrEvent,
  NostrSigner,
} from "../../types";
import { SignerError } from "../../types";
import { LocalSigner } from "../local";
import { Nip46Codec, type Nip46Scheme } from "./codec";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  encodeRequest,
  Nip46Pending,
  newRequestId,
  parseResponse,
} from "./rpc";
import {
  NIP46_KIND,
  type Nip46Transport,
  type Nip46Unsubscribe,
} from "./transport";

/**
 * How long to wait for the connection handshake, as opposed to a routine call.
 *
 * Longer than a request deadline because a human is in the loop: the signer shows an
 * approval prompt and the phone may be in a pocket. Still bounded — a handshake that
 * waits forever is a login screen that has stopped being a login screen.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 90_000;

/**
 * How far back the reply subscription reaches.
 *
 * `since: now` looks right and drops replies: the `created_at` on the answer is set
 * by the *signer's* clock, and a signer a minute fast produces events a relay will
 * happily withhold from a `since` we computed locally. A few minutes of slack costs
 * nothing — there is nothing else addressed to a freshly generated client key.
 */
export const SUBSCRIBE_SKEW_SECONDS = 300;

/** Permissions Setu asks for. Narrow on purpose; a bunker may grant less. */
export const DEFAULT_PERMISSIONS = [
  "get_public_key",
  "sign_event",
  "nip44_encrypt",
  "nip44_decrypt",
] as const;

/**
 * Keep-alive interval the app opts into.
 *
 * Well under the idle timeout of the relays that host bunkers, which cluster around
 * a few minutes, and long enough that a reading session is not a stream of pings.
 * Off unless a caller passes it: the protocol package must not start a repeating
 * timer nobody asked for, and a headless or test caller has no idle socket to protect.
 */
export const DEFAULT_KEEPALIVE_MS = 60_000;

/**
 * How long a keep-alive ping waits before it counts as a miss.
 *
 * Much shorter than a user-facing request: nobody is watching this one, and its whole
 * job is to answer "is the connection there" quickly enough that the answer is still
 * true when the user next needs it.
 */
const KEEPALIVE_PING_TIMEOUT_MS = 10_000;

/**
 * Silent pings before the connection is declared dead.
 *
 * One is not enough. A single dropped ping happens whenever a relay is reconnecting,
 * and reporting that as "your signer is gone" would train the user to ignore the
 * warning that matters.
 */
const KEEPALIVE_MISSES = 2;

/**
 * Deadline for a request made while the connection is known unreachable.
 *
 * The point of detecting death is not to refuse outright — the signer may have come
 * back in the last second, and refusing a post on stale information is worse than a
 * short wait. It is to stop spending twenty seconds re-learning something the
 * heartbeat already established.
 */
const UNREACHABLE_TIMEOUT_MS = 5_000;

/** How long a NIP-44 request waits alone before a NIP-04 copy follows it. */
export const SCHEME_PROBE_MS = 8_000;

/** Whether the connection is answering. See the module note on keep-alive. */
export type Nip46Health = "alive" | "unreachable";

/**
 * A timer for background work, which must never be why a process stays alive.
 *
 * The heartbeat reschedules itself for as long as the connection exists. Under Node —
 * `apps/cli`, and every test run — a pending timer holds the event loop open, so a
 * heartbeat without `unref` turns a finished program into one that hangs for an
 * interval it has no further use for. `unref` does not exist in a browser, where
 * there is no event loop to hold open, hence the optional call rather than a cast.
 */
function background(
  run: () => void,
  ms: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(run, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

export interface Nip46SignerOptions {
  readonly transport: Nip46Transport;
  /**
   * The client key's secret, as bytes.
   *
   * Passed in rather than generated here so the caller keeps the only copy and can
   * decide how to protect it at rest. It authorises signing for the account, so it is
   * a credential in exactly the way an `nsec` is.
   */
  readonly clientSecret: Uint8Array;
  readonly remoteSignerPubkey: Hex32;
  readonly relays: readonly string[];
  readonly timeoutMs?: number;
  readonly onAuthChallenge?: (url: string, method: string) => void;
  readonly now?: () => number;
  /**
   * The encryption this peer has already been *seen* using, if the caller knows.
   *
   * Set by `startNostrConnect`, which has read a frame from the signer before this
   * object exists. Without it that evidence is thrown away and the new connection
   * re-probes a peer whose scheme is already established. Never a guess: a caller
   * that has not seen a frame must leave it undefined.
   */
  readonly peerScheme?: Nip46Scheme;
  /**
   * Ping the signer whenever nothing has been heard for this long. Omit for none.
   *
   * See {@link DEFAULT_KEEPALIVE_MS}.
   */
  readonly keepAliveMs?: number;
  /** Called on each change of {@link Nip46Signer.health}, never on repeats. */
  readonly onHealth?: (health: Nip46Health) => void;
  /** Overridable for tests; see {@link SCHEME_PROBE_MS}. */
  readonly schemeProbeMs?: number;
}

/** Signs by asking a remote signer over relays. */
export class Nip46Signer implements NostrSigner {
  readonly kind = "nip46" as const;

  private readonly client: LocalSigner;
  private readonly codec: Nip46Codec;
  private readonly pending: Nip46Pending;
  private readonly timeoutMs: number;
  private readonly probeMs: number;
  private readonly now: () => number;
  private unsubscribe?: Nip46Unsubscribe;
  private cachedPubkey?: Hex32;
  private closed = false;
  /** What the peer has been observed reading. Undefined until it says something. */
  private peerScheme?: Nip46Scheme;
  private state: Nip46Health = "alive";
  private misses = 0;
  /** Wall-clock ms of the last frame that decrypted from the signer. */
  private lastHeardAt = Date.now();
  private keepAliveTimer?: ReturnType<typeof setTimeout>;
  /** Outstanding NIP-04 probes, so `close` does not leave timers behind. */
  private readonly probeTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Bounded, because a reply arrives once per relay and decryption is not free. */
  private readonly seen = new Set<string>();

  constructor(private readonly options: Nip46SignerOptions) {
    this.client = LocalSigner.fromSecretKey(options.clientSecret);
    this.codec = new Nip46Codec(options.clientSecret);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.probeMs = options.schemeProbeMs ?? SCHEME_PROBE_MS;
    this.peerScheme = options.peerScheme;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.pending = new Nip46Pending({
      ...(options.onAuthChallenge
        ? { onAuthChallenge: options.onAuthChallenge }
        : {}),
    });
  }

  /** The per-connection client key, for persisting the connection. */
  get clientPubkey(): Hex32 {
    return this.client.pubkeySync();
  }

  /** The signer's key — not the account's. */
  get remoteSignerPubkey(): Hex32 {
    return this.options.remoteSignerPubkey;
  }

  /** The relays this connection talks over. */
  get relays(): readonly string[] {
    return this.options.relays;
  }

  /**
   * Whether the connection is currently believed to be answering.
   *
   * Only ever `"unreachable"` when a keep-alive is running and has missed
   * {@link KEEPALIVE_MISSES} pings in a row — without one there is no evidence
   * either way, and claiming a connection is dead because nobody asked it anything
   * would be a worse lie than assuming it is fine.
   */
  get health(): Nip46Health {
    return this.state;
  }

  /**
   * The content encryption this peer has been *observed* to use, if any.
   *
   * `undefined` until a frame has actually been decrypted from it — this is
   * evidence, never the scheme we happen to be sending in. A host persists it so a
   * later session can skip the 8-second silence the NIP-04 probe waits out; see
   * {@link Nip46SignerOptions.peerScheme}, which is where it comes back in.
   */
  get observedScheme(): Nip46Scheme | undefined {
    return this.peerScheme;
  }

  /**
   * Open a *new* connection: `connect`, then learn who we are.
   *
   * `secret` is the one-time token from the `bunker://` URI. It is used here and
   * never stored — a persisted bunker secret is a persisted signing capability.
   */
  static async connect(
    options: Nip46SignerOptions & {
      readonly secret?: string;
      readonly perms?: readonly string[];
      readonly connectTimeoutMs?: number;
    },
  ): Promise<Nip46Signer> {
    const signer = new Nip46Signer(options);
    try {
      await signer.request(
        "connect",
        // First param is the *signer's* pubkey, per NIP-46. Empty strings rather
        // than omitted params: some signers index into the array positionally and
        // a short array reads as a missing permission set.
        [
          options.remoteSignerPubkey,
          options.secret ?? "",
          (options.perms ?? DEFAULT_PERMISSIONS).join(","),
        ],
        options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      );
      await signer.pubkey();
      return signer;
    } catch (error) {
      signer.close();
      throw error;
    }
  }

  /**
   * Reattach to a connection this device already established.
   *
   * No `connect` and no secret: the signer already authorised this client key, and
   * re-sending a handshake would prompt the user again on every reload. The single
   * `get_public_key` doubles as a liveness check, and its answer is compared with the
   * account we expected — a signer that now speaks for a different account must not
   * silently become the session.
   */
  static async resume(
    options: Nip46SignerOptions & { readonly userPubkey: Hex32 },
  ): Promise<Nip46Signer> {
    const signer = new Nip46Signer(options);
    try {
      const pubkey = await signer.pubkey();
      if (pubkey !== options.userPubkey) {
        throw new SignerError(
          "the remote signer answered for a different account than the one stored on this device",
        );
      }
      return signer;
    } catch (error) {
      signer.close();
      throw error;
    }
  }

  /** The account's public key, from the signer. Cached after the first answer. */
  async pubkey(): Promise<Hex32> {
    if (this.cachedPubkey) return this.cachedPubkey;
    const answer = await this.request("get_public_key", []);
    const pubkey = answer.trim().toLowerCase();
    if (!isHex32(pubkey)) {
      throw new SignerError(
        "the remote signer returned a malformed public key",
      );
    }
    this.cachedPubkey = pubkey;
    return pubkey;
  }

  /** Round-trip liveness, without asking the signer to do anything. */
  async ping(): Promise<void> {
    await this.request("ping", []);
  }

  /**
   * Ask the signer to sign a template.
   *
   * The returned event is re-checked rather than trusted: shape first, then that it
   * is the account we believe we are. Neither check is a formality — the store has no
   * second chance to reject it.
   */
  async signEvent(template: EventTemplate): Promise<NostrEvent> {
    const account = await this.pubkey();
    const draft = {
      kind: template.kind,
      content: template.content,
      tags: (template.tags ?? []).map((tag) => [...tag]),
      created_at: template.created_at ?? this.now(),
    };
    const answer = await this.request("sign_event", [JSON.stringify(draft)]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer);
    } catch {
      throw new SignerError("the remote signer returned a non-JSON event");
    }
    if (!isValidEventShape(parsed)) {
      throw new SignerError("the remote signer returned a malformed event");
    }
    const signed = parsed;
    if (signed.pubkey !== account) {
      throw new SignerError(
        "the remote signer returned an event signed by a different key",
      );
    }
    if (signed.kind !== draft.kind) {
      throw new SignerError(
        "the remote signer returned an event of a different kind than requested",
      );
    }
    return signed;
  }

  /** NIP-44 encryption, performed by the signer because the key is there. */
  nip44Encrypt(peer: Hex32, plaintext: string): Promise<string> {
    return this.request("nip44_encrypt", [peer, plaintext]);
  }

  /** NIP-44 decryption, performed by the signer because the key is there. */
  nip44Decrypt(peer: Hex32, ciphertext: string): Promise<string> {
    return this.request("nip44_decrypt", [peer, ciphertext]);
  }

  /**
   * Drop the subscription and fail anything in flight.
   *
   * Failing the in-flight requests is the point: closing the transport under a
   * pending `signEvent` and leaving its promise alone recreates the hang the
   * deadlines exist to remove, only sooner. The timers go too — a heartbeat or a
   * scheme probe that outlives its connection would publish on a channel nobody is
   * listening to, and in a test run would hold the process open.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAliveTimer !== undefined) clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
    for (const timer of this.probeTimers) clearTimeout(timer);
    this.probeTimers.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pending.failAll("the remote signer connection was closed");
  }

  private ensureSubscribed(): void {
    if (this.unsubscribe || this.closed) return;
    this.unsubscribe = this.options.transport.subscribe(
      {
        relays: this.options.relays,
        clientPubkey: this.clientPubkey,
        since: this.now() - SUBSCRIBE_SKEW_SECONDS,
      },
      (event) => this.onEvent(event),
    );
    this.scheduleKeepAlive();
  }

  private onEvent(event: NostrEvent): void {
    if (event.kind !== NIP46_KIND) return;
    if (this.seen.has(event.id)) return;
    if (this.seen.size > 256) this.seen.clear();
    this.seen.add(event.id);
    void this.codec
      .decrypt(event.pubkey, event.content)
      .then((frame) => {
        // A frame that decrypted under the conversation key with this pubkey came
        // from the holder of that key, so for our signer it is proof of two things
        // at once: the connection is alive, and this is the encryption it speaks.
        if (event.pubkey === this.options.remoteSignerPubkey) {
          this.peerScheme = frame.scheme;
          this.lastHeardAt = Date.now();
          this.markAlive();
        }
        const response = parseResponse(frame.payload);
        // Not a response: a signer may also send us *requests* (it is a NIP-46 peer
        // too). Setu does not service those, and dropping one must not disturb the
        // requests that are waiting.
        if (response) this.pending.deliver(event.pubkey, response);
      })
      .catch(() => {
        // Undecryptable under either scheme means it was not for this conversation.
        // Anyone can publish a kind-24133 addressed to our client key; the
        // conversation key is what makes that harmless, so there is nothing here
        // worth reporting.
      });
  }

  private async request(
    method: string,
    params: readonly string[],
    timeoutMs = this.timeoutMs,
  ): Promise<string> {
    if (this.closed) {
      throw new SignerError("this remote signer connection is closed");
    }
    this.ensureSubscribed();
    const id = newRequestId();
    const remote = this.options.remoteSignerPubkey;
    const known = this.peerScheme;
    const deadline =
      this.state === "unreachable"
        ? Math.min(timeoutMs, UNREACHABLE_TIMEOUT_MS)
        : timeoutMs;
    // Registered before the event is published, not after: with two relays and a
    // fast signer the reply can arrive while `publish` is still awaiting, and a
    // reply with nothing waiting for it is dropped.
    const answer = this.pending.open(id, method, remote, deadline);
    const payload = encodeRequest({ id, method, params });
    try {
      await this.publishAs(remote, payload, known ?? "nip44");
      // Only where there is no evidence yet, and only if the probe can still fire
      // inside this request's deadline — a copy sent after the request has already
      // given up is a request nobody is waiting for.
      if (known === undefined && this.probeMs < deadline) {
        this.probeNip04(payload);
      }
    } catch (cause) {
      this.pending.fail(
        id,
        cause instanceof Error ? cause.message : "could not be sent",
      );
    }
    try {
      return await answer;
    } catch (cause) {
      // Re-worded only when the heartbeat has already established that the signer
      // is gone. "did not answer within 5s" is true but reads as a slow signer;
      // what the user needs to be told is that the connection needs re-making.
      if (this.state === "unreachable") {
        throw new SignerError(
          `the remote signer has stopped answering and needs to be reconnected (${method})`,
          cause,
        );
      }
      throw cause;
    }
  }

  private async publishAs(
    remote: Hex32,
    payload: string,
    scheme: Nip46Scheme,
  ): Promise<void> {
    const content = await this.codec.encrypt(remote, payload, scheme);
    const event = await this.client.signEvent({
      kind: NIP46_KIND,
      content,
      tags: [["p", remote]],
      created_at: this.now(),
    });
    await this.options.transport.publish(event, this.options.relays);
  }

  /**
   * Re-send one request in NIP-04 if the NIP-44 copy landed nowhere.
   *
   * The only way to discover that a peer speaks NIP-04 is to be understood by it: a
   * signer that cannot decrypt a request cannot reply to say it could not, so silence
   * is the entire signal. `peerScheme` is the guard, and any decryptable frame from
   * the signer sets it — including an `auth_url`, which is a signer saying "I read
   * this and I am asking the user". So a dual-capable signer that acknowledges the
   * request in any way never receives a second copy.
   *
   * ## The case this deliberately accepts
   *
   * A signer that reads *both* schemes, prompts locally, and sends nothing while it
   * waits will pass {@link SCHEME_PROBE_MS} in silence and get the NIP-04 copy, which
   * it can also read — so the user may see a second approval prompt for one action.
   * That is the accepted cost of making legacy signers work at all, and it is bounded:
   * both copies carry the *same* request id, so a second approval cannot produce a
   * second signature in the app. `rpc.ts` deletes the entry when the first answer
   * lands and drops the duplicate.
   */
  private probeNip04(payload: string): void {
    const timer = background(() => {
      this.probeTimers.delete(timer);
      if (this.closed || this.peerScheme !== undefined) return;
      void this.publishAs(
        this.options.remoteSignerPubkey,
        payload,
        "nip04",
      ).catch(() => {
        // The NIP-44 copy owns the deadline; a failed probe only means the legacy
        // path is unavailable too, which the deadline will report soon enough.
      });
    }, this.probeMs);
    this.probeTimers.add(timer);
  }

  private scheduleKeepAlive(): void {
    const interval = this.options.keepAliveMs;
    if (interval === undefined || interval <= 0) return;
    if (this.closed || this.keepAliveTimer !== undefined) return;
    this.keepAliveTimer = background(() => {
      this.keepAliveTimer = undefined;
      void this.heartbeat().finally(() => this.scheduleKeepAlive());
    }, interval);
  }

  /**
   * One idle check.
   *
   * Skipped entirely while the connection is in use, because a request that is being
   * answered is better evidence than a ping and a ping racing a `sign_event` costs
   * the user latency on the one call where they are watching. Liveness is judged on
   * "did anything at all arrive", not on whether `ping` succeeded: a signer old
   * enough to lack `ping` answers `{"error":"unknown method"}`, and an error from the
   * signer is proof of life just as much as a `pong` is.
   */
  private async heartbeat(): Promise<void> {
    if (this.closed) return;
    const interval = this.options.keepAliveMs ?? 0;
    if (Date.now() - this.lastHeardAt < interval) return;
    const before = this.lastHeardAt;
    await this.request(
      "ping",
      [],
      Math.min(this.timeoutMs, KEEPALIVE_PING_TIMEOUT_MS),
    ).catch(() => {
      // Handled below by whether anything was heard, not by the rejection.
    });
    if (this.lastHeardAt > before) {
      this.markAlive();
      return;
    }
    this.misses += 1;
    if (this.misses >= KEEPALIVE_MISSES) this.markUnreachable();
  }

  private markAlive(): void {
    this.misses = 0;
    if (this.state === "alive") return;
    this.state = "alive";
    this.options.onHealth?.("alive");
  }

  private markUnreachable(): void {
    if (this.state === "unreachable") return;
    this.state = "unreachable";
    this.options.onHealth?.("unreachable");
  }
}
