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
): Promise<RemoteConnection> {
  const transport = new BunkerTransport(onError);
  try {
    const signer = await Nip46Signer.resume({
      transport,
      clientSecret: input.clientSecret,
      remoteSignerPubkey: input.remoteSignerPubkey,
      relays: input.relays,
      userPubkey: input.userPubkey,
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
): RemoteInvite {
  const clientSecret = generateSecretKey();
  const transport = new BunkerTransport(onError);
  const handshake = startNostrConnect({
    transport,
    clientSecret,
    relays,
    metadata: { name: "Setu" },
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
