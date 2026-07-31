/**
 * NIP-46 remote ("bunker") signer.
 *
 * The account's key lives in another program. Every operation is a JSON-RPC call
 * encrypted with NIP-44 between a *client key* Setu generates and the signer's key,
 * carried as kind-24133 events over relays the signer named. The client key is not
 * the account: it is a per-connection identity whose only privilege is the one the
 * user granted when they approved the connection.
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
import { bytesToHex, isHex32 } from "../../hex";
import type {
  EventTemplate,
  Hex32,
  NostrEvent,
  NostrSigner,
} from "../../types";
import { SignerError } from "../../types";
import { LocalSigner } from "../local";
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
import { buildNostrConnectUri } from "./uri";

/**
 * How long to wait for the connection handshake, as opposed to a routine call.
 *
 * Longer than a request deadline because a human is in the loop: the signer shows an
 * approval prompt and the phone may be in a pocket. Still bounded — a handshake that
 * waits forever is a login screen that has stopped being a login screen.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 90_000;

/** How long to hold a `nostrconnect://` URI open for a signer to scan it. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 180_000;

/**
 * How far back the reply subscription reaches.
 *
 * `since: now` looks right and drops replies: the `created_at` on the answer is set
 * by the *signer's* clock, and a signer a minute fast produces events a relay will
 * happily withhold from a `since` we computed locally. A few minutes of slack costs
 * nothing — there is nothing else addressed to a freshly generated client key.
 */
const SUBSCRIBE_SKEW_SECONDS = 300;

/** Permissions Setu asks for. Narrow on purpose; a bunker may grant less. */
export const DEFAULT_PERMISSIONS = [
  "get_public_key",
  "sign_event",
  "nip44_encrypt",
  "nip44_decrypt",
] as const;

/** See `rpc.ts`: the DOM `Crypto` type is absent when the CLI typechecks this. */
interface RandomSource {
  getRandomValues(bytes: Uint8Array): Uint8Array;
}

/** A CSPRNG connection secret for `nostrconnect://`. */
export function generateConnectSecret(): string {
  const bytes = new Uint8Array(16);
  const crypto = (globalThis as { crypto?: RandomSource }).crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    throw new SignerError(
      "no CSPRNG available; a guessable connection secret would let a bystander claim the connection",
    );
  }
  return bytesToHex(bytes);
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
}

/** Signs by asking a remote signer over relays. */
export class Nip46Signer implements NostrSigner {
  readonly kind = "nip46" as const;

  private readonly client: LocalSigner;
  private readonly pending: Nip46Pending;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private unsubscribe?: Nip46Unsubscribe;
  private cachedPubkey?: Hex32;
  private closed = false;
  /** Bounded, because a reply arrives once per relay and decryption is not free. */
  private readonly seen = new Set<string>();

  constructor(private readonly options: Nip46SignerOptions) {
    this.client = LocalSigner.fromSecretKey(options.clientSecret);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
   * deadlines exist to remove, only sooner.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
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
  }

  private onEvent(event: NostrEvent): void {
    if (event.kind !== NIP46_KIND) return;
    if (this.seen.has(event.id)) return;
    if (this.seen.size > 256) this.seen.clear();
    this.seen.add(event.id);
    void this.client
      .nip44Decrypt(event.pubkey, event.content)
      .then((payload) => {
        const response = parseResponse(payload);
        // Not a response: a signer may also send us *requests* (it is a NIP-46 peer
        // too). Setu does not service those, and dropping one must not disturb the
        // requests that are waiting.
        if (response) this.pending.deliver(event.pubkey, response);
      })
      .catch(() => {
        // Undecryptable means it was not for this conversation. Anyone can publish a
        // kind-24133 addressed to our client key; the conversation key is what makes
        // that harmless, so there is nothing here worth reporting.
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
    // Registered before the event is published, not after: with two relays and a
    // fast signer the reply can arrive while `publish` is still awaiting, and a
    // reply with nothing waiting for it is dropped.
    const answer = this.pending.open(id, method, remote, timeoutMs);
    try {
      const content = await this.client.nip44Encrypt(
        remote,
        encodeRequest({ id, method, params }),
      );
      const event = await this.client.signEvent({
        kind: NIP46_KIND,
        content,
        tags: [["p", remote]],
        created_at: this.now(),
      });
      await this.options.transport.publish(event, this.options.relays);
    } catch (cause) {
      this.pending.fail(
        id,
        cause instanceof Error ? cause.message : "could not be sent",
      );
    }
    return answer;
  }
}

export interface NostrConnectOptions {
  readonly transport: Nip46Transport;
  readonly clientSecret: Uint8Array;
  readonly relays: readonly string[];
  readonly secret?: string;
  readonly perms?: readonly string[];
  readonly metadata?: {
    readonly name?: string;
    readonly url?: string;
    readonly image?: string;
  };
  readonly timeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly onAuthChallenge?: (url: string, method: string) => void;
  readonly now?: () => number;
}

/** A `nostrconnect://` handshake in progress. */
export interface NostrConnectHandshake {
  /** Show this to the user as a QR code or a copyable string. */
  readonly uri: string;
  readonly clientPubkey: Hex32;
  /** Resolves once a signer proves itself by echoing the secret. */
  readonly signer: Promise<Nip46Signer>;
  /** Give up: stops listening and rejects `signer`. */
  cancel(): void;
}

/**
 * Start the direction where *we* issue the invitation.
 *
 * The signer proves itself by echoing our secret. That echo is the whole
 * authentication step: the URI is published to a relay and to a screen, so anyone may
 * see the client key, and without the secret check the first party to answer would
 * become the account's signer. Which is why the secret must come from a CSPRNG and
 * why a mismatched echo is ignored rather than treated as a near miss.
 */
export function startNostrConnect(
  options: NostrConnectOptions,
): NostrConnectHandshake {
  const client = LocalSigner.fromSecretKey(options.clientSecret);
  const clientPubkey = client.pubkeySync();
  const secret = options.secret ?? generateConnectSecret();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const perms = options.perms ?? DEFAULT_PERMISSIONS;
  const uri = buildNostrConnectUri({
    clientPubkey,
    relays: options.relays,
    secret,
    perms,
    ...(options.metadata ?? {}),
  });

  let settled = false;
  let stop: Nip46Unsubscribe | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Assigned inside the executor below. Cancelling has to *reject* the promise, not
  // merely stop listening: a cancel that only unsubscribed would leave the caller
  // awaiting a handshake nothing can complete — the same permanent spinner the
  // deadlines exist to prevent, arrived at by pressing "cancel".
  let cancelHandshake: () => void = () => {};

  const signer = new Promise<Nip46Signer>((resolve, reject) => {
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      stop?.();
      stop = undefined;
      run();
    };

    timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new SignerError(
              "no remote signer answered this connection request in time",
            ),
          ),
        ),
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );

    cancelHandshake = () =>
      finish(() =>
        reject(new SignerError("the connection request was cancelled")),
      );

    stop = options.transport.subscribe(
      {
        relays: options.relays,
        clientPubkey,
        since: now() - SUBSCRIBE_SKEW_SECONDS,
      },
      (event) => {
        if (settled || event.kind !== NIP46_KIND) return;
        void client
          .nip44Decrypt(event.pubkey, event.content)
          .then((payload) => {
            const response = parseResponse(payload);
            if (!response || response.result !== secret) return;
            const remoteSignerPubkey = event.pubkey;
            finish(() => {
              // A fresh signer with its own subscription rather than handing this
              // one over: the handshake listener has no request table behind it, and
              // the signer's first act is to subscribe before it sends anything.
              const built = new Nip46Signer({
                transport: options.transport,
                clientSecret: options.clientSecret,
                remoteSignerPubkey,
                relays: options.relays,
                ...(options.timeoutMs !== undefined
                  ? { timeoutMs: options.timeoutMs }
                  : {}),
                ...(options.onAuthChallenge
                  ? { onAuthChallenge: options.onAuthChallenge }
                  : {}),
                ...(options.now ? { now: options.now } : {}),
              });
              built.pubkey().then(
                () => resolve(built),
                (cause: unknown) => {
                  built.close();
                  reject(
                    cause instanceof Error
                      ? cause
                      : new SignerError(
                          "the remote signer did not identify itself",
                        ),
                  );
                },
              );
            });
          })
          .catch(() => {
            // Not for us. See `Nip46Signer.onEvent`.
          });
      },
    );
  });

  return { uri, clientPubkey, signer, cancel: () => cancelHandshake() };
}
