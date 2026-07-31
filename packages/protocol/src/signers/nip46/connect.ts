/**
 * The `nostrconnect://` direction: Setu issues the invitation.
 *
 * Split from `signer.ts` because it is a different object with a different lifetime —
 * a one-shot listener with a human-scale deadline and no request table — and because
 * the two together were pushing one file past the size a reviewer can hold in their
 * head.
 *
 * ## The secret echo is the authentication
 *
 * The URI is published to a relay and shown on a screen, so anyone may learn the
 * client key in it. What distinguishes the signer the user actually approved from any
 * bystander who saw the URI is that it can echo the `secret` back. That is why the
 * secret must come from a CSPRNG and why a mismatched echo is *ignored* rather than
 * treated as a near miss: the first party to answer must not become the account's
 * signer.
 *
 * ## The scheme learned here is worth carrying forward
 *
 * The echo is the first frame the signer sends, which makes it the one place in NIP-46
 * where the peer's encryption is known before we have asked it anything (see
 * `codec.ts`). It is handed to the {@link Nip46Signer} as `peerScheme` so a legacy
 * signer's very first real request goes out in a scheme it can read, instead of
 * re-discovering the answer with a probe and a delay.
 */

import { bytesToHex } from "../../hex";
import type { Hex32 } from "../../types";
import { SignerError } from "../../types";
import { LocalSigner } from "../local";
import type { Nip46Scheme } from "./codec";
import { Nip46Codec } from "./codec";
import { parseResponse } from "./rpc";
import {
  DEFAULT_PERMISSIONS,
  type Nip46Health,
  Nip46Signer,
  SUBSCRIBE_SKEW_SECONDS,
} from "./signer";
import {
  NIP46_KIND,
  type Nip46Transport,
  type Nip46Unsubscribe,
} from "./transport";
import { buildNostrConnectUri } from "./uri";

/** How long to hold a `nostrconnect://` URI open for a signer to scan it. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 180_000;

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
  /** Passed to the adopted signer; see `Nip46SignerOptions.keepAliveMs`. */
  readonly keepAliveMs?: number;
  readonly onHealth?: (health: Nip46Health) => void;
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
 * The signer proves itself by echoing our secret. See the module note for why that
 * check is the whole of the authentication and why a mismatch is dropped silently.
 */
export function startNostrConnect(
  options: NostrConnectOptions,
): NostrConnectHandshake {
  const client = LocalSigner.fromSecretKey(options.clientSecret);
  const codec = new Nip46Codec(options.clientSecret);
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
        void codec
          .decrypt(event.pubkey, event.content)
          .then((frame) => {
            const response = parseResponse(frame.payload);
            if (!response || response.result !== secret) return;
            const remoteSignerPubkey = event.pubkey;
            finish(() =>
              adopt(options, remoteSignerPubkey, frame.scheme, resolve, reject),
            );
          })
          .catch(() => {
            // Not for us. See `Nip46Signer.onEvent`.
          });
      },
    );
  });

  return { uri, clientPubkey, signer, cancel: () => cancelHandshake() };
}

/**
 * Turn a proven signer key into a live connection.
 *
 * A fresh signer with its own subscription rather than handing the handshake's over:
 * the handshake listener has no request table behind it, and the signer's first act is
 * to subscribe before it sends anything.
 */
function adopt(
  options: NostrConnectOptions,
  remoteSignerPubkey: Hex32,
  peerScheme: Nip46Scheme,
  resolve: (signer: Nip46Signer) => void,
  reject: (error: Error) => void,
): void {
  const built = new Nip46Signer({
    transport: options.transport,
    clientSecret: options.clientSecret,
    remoteSignerPubkey,
    relays: options.relays,
    peerScheme,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.onAuthChallenge
      ? { onAuthChallenge: options.onAuthChallenge }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.keepAliveMs !== undefined
      ? { keepAliveMs: options.keepAliveMs }
      : {}),
    ...(options.onHealth ? { onHealth: options.onHealth } : {}),
  });
  built.pubkey().then(
    () => resolve(built),
    (cause: unknown) => {
      built.close();
      reject(
        cause instanceof Error
          ? cause
          : new SignerError("the remote signer did not identify itself"),
      );
    },
  );
}
