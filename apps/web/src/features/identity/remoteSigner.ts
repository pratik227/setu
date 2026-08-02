/**
 * Establishing and re-establishing a NIP-46 connection, from the app's side.
 *
 * Everything protocol-shaped lives in `@setu/protocol`; what is left here is the part
 * that needs sockets and a lifetime — pairing a {@link BunkerTransport} with a signer
 * so the two are closed together. A signer closed without its transport leaves sockets
 * open for the life of the tab; a transport closed without its signer leaves requests
 * waiting on a channel that is gone.
 *
 * ## The client key is the credential to protect
 *
 * A NIP-46 connection is authorised under a key Setu generates, not under the
 * account's key. Whoever holds that client key can ask the bunker to sign as the
 * account for as long as the authorisation stands — so it is handed back to the caller
 * here purely so it can be encrypted with a passphrase before storage (see
 * `storage.ts`), and it is never logged, never put in an error message, and never
 * written in the clear.
 *
 * The `bunker://` URI's `secret` is treated as more sensitive still: used once, during
 * the handshake, and not returned from this module at all. Errors quote the URI only
 * through `redactBunkerUri`.
 *
 * ## Every connection made here is kept alive
 *
 * {@link KEEPALIVE_MS} is passed to every signer this module builds, and that decision
 * belongs here rather than in `@setu/protocol`: the protocol package has no idea
 * whether it is running behind a browser tab with idle WebSockets or inside a one-shot
 * script, and starting a repeating timer on a caller that cannot stop it would be the
 * wrong default. A browser session is the case that needs it — a bunker connection is
 * idle for most of its life, and an idle relay socket is closed by the relay.
 */

import {
  generateSecretKey,
  type Hex32,
  Nip46Signer,
  parseBunkerUri,
  redactBunkerUri,
  startNostrConnect,
} from "@setu/protocol";
import { BunkerTransport } from "./bunkerTransport";

/**
 * Relays used to advertise a `nostrconnect://` invitation.
 *
 * Both ends must pick the same relay, and the signer is the end we cannot configure —
 * so this is a starting point the user can edit, not a fixed set. Two rather than one
 * because a single unreachable relay makes an invitation that can never be answered
 * look identical to a signer that ignored it.
 */
export const DEFAULT_INVITE_RELAYS = [
  "wss://nos.lol",
  "wss://offchain.pub",
] as const;

/**
 * How long a bunker connection may go unproven before Setu pings it.
 *
 * Under the idle timeout of the relays bunkers are usually reachable on, which cluster
 * around a few minutes, so the socket is in use again before anyone closes it. The
 * value is a compromise the other way too: every ping is a signed event on a relay, and
 * a client that pinged every ten seconds would be a client relay operators rate-limit.
 */
const KEEPALIVE_MS = 60_000;

/**
 * Whether the signer is answering.
 *
 * Read off the signer rather than re-declared, because `@setu/protocol`'s root barrel
 * does not export the union by name and a second hand-written copy of it would drift.
 */
export type RemoteHealth = Nip46Signer["health"];

/** A live remote-signer connection and everything needed to persist it. */
export interface RemoteConnection {
  readonly signer: Nip46Signer;
  /**
   * The client key's secret bytes. Encrypt before storing; never log.
   */
  readonly clientSecret: Uint8Array;
  readonly remoteSignerPubkey: Hex32;
  readonly relays: readonly string[];
  /** The account, as the signer stated it. Never taken from the URI. */
  readonly userPubkey: Hex32;
  /**
   * Whether the keep-alive currently believes the signer is there.
   *
   * A function rather than a value because it changes underneath the holder: a
   * connection object captured at sign-in would otherwise report the health of the
   * moment it was created for the rest of the session. Worth surfacing in the UI as a
   * "reconnect your signer" affordance — until then, the signer itself is what keeps a
   * dead connection from costing the user a full request deadline per attempt.
   */
  health(): RemoteHealth;
  /**
   * The scheme this signer has been observed to speak, for persisting.
   *
   * A function for the same reason `health` is: it is `undefined` until the first
   * frame comes back, which is after sign-in returns. A caller that read it as a
   * value at connect time would persist "unknown" forever and the probe would be
   * paid on every resume — the exact cost this exists to remove.
   */
  observedScheme(): "nip04" | "nip44" | undefined;
  close(): void;
}

function pair(
  signer: Nip46Signer,
  transport: BunkerTransport,
  clientSecret: Uint8Array,
  userPubkey: Hex32,
): RemoteConnection {
  return {
    signer,
    clientSecret,
    remoteSignerPubkey: signer.remoteSignerPubkey,
    relays: signer.relays,
    userPubkey,
    health: () => signer.health,
    observedScheme: () => signer.observedScheme,
    close: () => {
      signer.close();
      transport.close();
    },
  };
}

/**
 * Connect using a `bunker://` URI the user pasted.
 *
 * A fresh client key per connection, always. Reusing one across bunkers would let two
 * unrelated signers recognise the same client identity, and would mean revoking one
 * connection revokes them all.
 */
export async function connectToBunker(
  uri: string,
  onError: (message: string) => void = () => {},
  onHealth: (health: RemoteHealth) => void = () => {},
): Promise<RemoteConnection> {
  const parsed = parseBunkerUri(uri);
  if (!parsed) {
    throw new Error(
      "that is not a usable bunker:// URI — it needs a signer key and at least one wss:// relay",
    );
  }
  const clientSecret = generateSecretKey();
  const transport = new BunkerTransport(onError);
  try {
    const signer = await Nip46Signer.connect({
      transport,
      clientSecret,
      remoteSignerPubkey: parsed.remoteSignerPubkey,
      relays: parsed.relays,
      keepAliveMs: KEEPALIVE_MS,
      onHealth,
      ...(parsed.secret ? { secret: parsed.secret } : {}),
      onAuthChallenge: (url) =>
        onError(`the remote signer wants approval: ${url}`),
    });
    return pair(signer, transport, clientSecret, await signer.pubkey());
  } catch (cause) {
    transport.close();
    // Redacted, because this string ends up in a UI error and from there in
    // screenshots and bug reports. The secret in a bunker URI grants signing.
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)} (${redactBunkerUri(uri)})`,
    );
  }
}

export interface ResumeBunkerInput {
  readonly clientSecret: Uint8Array;
  readonly remoteSignerPubkey: Hex32;
  readonly relays: readonly string[];
  /** The account we expect; a signer answering for another is refused. */
  readonly userPubkey: Hex32;
  /**
   * Scheme observed in a previous session, when one was stored.
   *
   * Skips the NIP-04 probe's 8-second silence on the first request after a reload.
   * Safe to be wrong: the codec still decrypts replies by shape, so a stale value
   * costs one mis-encrypted request and is corrected by the next frame that arrives.
   */
  readonly scheme?: "nip04" | "nip44";
}

/**
 * Reattach to a connection this device already made.
 *
 * No handshake and no secret — the bunker already authorised this client key, and
 * re-connecting would prompt the user on every reload.
 */
export async function resumeBunker(
  input: ResumeBunkerInput,
  onError: (message: string) => void = () => {},
  onHealth: (health: RemoteHealth) => void = () => {},
): Promise<RemoteConnection> {
  const transport = new BunkerTransport(onError);
  try {
    const signer = await Nip46Signer.resume({
      transport,
      clientSecret: input.clientSecret,
      remoteSignerPubkey: input.remoteSignerPubkey,
      relays: input.relays,
      userPubkey: input.userPubkey,
      keepAliveMs: KEEPALIVE_MS,
      ...(input.scheme ? { peerScheme: input.scheme } : {}),
      onHealth,
      onAuthChallenge: (url) =>
        onError(`the remote signer wants approval: ${url}`),
    });
    return pair(signer, transport, input.clientSecret, input.userPubkey);
  } catch (cause) {
    transport.close();
    throw cause;
  }
}

/** An outstanding `nostrconnect://` invitation. */
export interface RemoteInvite {
  /** Show this to the user. It contains a secret, so it is not for logs. */
  readonly uri: string;
  readonly connection: Promise<RemoteConnection>;
  cancel(): void;
}

/**
 * Publish an invitation for a signer to adopt this client.
 *
 * The other direction from {@link connectToBunker}: the user shows this URI to their
 * signer rather than pasting one from it. Returns synchronously with the URI, because
 * there is nothing to show while waiting otherwise — and the wait is a human one.
 */
export function inviteRemoteSigner(
  relays: readonly string[] = DEFAULT_INVITE_RELAYS,
  onError: (message: string) => void = () => {},
  onHealth: (health: RemoteHealth) => void = () => {},
): RemoteInvite {
  const clientSecret = generateSecretKey();
  const transport = new BunkerTransport(onError);
  const handshake = startNostrConnect({
    transport,
    clientSecret,
    relays,
    metadata: { name: "Setu" },
    keepAliveMs: KEEPALIVE_MS,
    onHealth,
    onAuthChallenge: (url) =>
      onError(`the remote signer wants approval: ${url}`),
  });
  const connection = handshake.signer.then(
    async (signer) =>
      pair(signer, transport, clientSecret, await signer.pubkey()),
    (cause: unknown) => {
      transport.close();
      throw cause;
    },
  );
  return {
    uri: handshake.uri,
    connection,
    cancel: () => {
      handshake.cancel();
      transport.close();
    },
  };
}
