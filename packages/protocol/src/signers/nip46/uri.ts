/**
 * NIP-46 connection URIs, in both directions.
 *
 * Two shapes, and they point opposite ways:
 *
 *  - `bunker://<remote-signer-pubkey>?relay=…&secret=…` — the **signer** produced
 *    it and the user pastes it into Setu. We learn where to talk and to whom.
 *  - `nostrconnect://<client-pubkey>?relay=…&secret=…` — **Setu** produces it and
 *    the signer scans or pastes it. We announce a key we just generated and a
 *    secret the signer must echo back before we believe anything it says.
 *
 * ## The pubkey in a `bunker://` URI is not the user
 *
 * It is the *signer's* key, which for hosted bunkers is a per-connection key that
 * has nothing to do with the account being signed into. Treating it as the account
 * pubkey gives a session whose identity is wrong in every direction — wrong avatar,
 * wrong feed, notes attributed to a stranger — so the account pubkey only ever comes
 * from a `get_public_key` answer over the wire.
 *
 * ## The `secret` is a credential
 *
 * A bunker secret authorises signing for the account, exactly as an `nsec` does.
 * It is therefore never persisted (see `identity/storage.ts`, which refuses to write
 * anything key-shaped) and never logged. {@link redactBunkerUri} exists so an error
 * message can name the URI a user pasted without carrying the secret into a console,
 * a bug report, or a screenshot.
 *
 * ## Parsed by hand rather than with `URL`
 *
 * `new URL()` applies host normalisation to the authority — case folding, trailing
 * dots, IDNA — which is right for a hostname and wrong for a 32-byte hex key we
 * intend to compare byte-for-byte. Splitting on `?` ourselves and handing only the
 * query to `URLSearchParams` keeps the percent-decoding we want and none of the
 * normalisation we do not.
 */

import { isHex32 } from "../../hex";
import { decodeAny } from "../../nip19";
import type { Hex32 } from "../../types";

const BUNKER_SCHEME = "bunker://";
const NOSTRCONNECT_SCHEME = "nostrconnect://";

/** A parsed `bunker://` URI. */
export interface BunkerUri {
  /** The signer's key — *not* the account's. See the module note. */
  readonly remoteSignerPubkey: Hex32;
  /** Where to reach the signer. At least one, or the URI is unusable. */
  readonly relays: readonly string[];
  /** The one-time connection secret, when the signer issued one. */
  readonly secret?: string;
}

/** A parsed `nostrconnect://` URI — the shape Setu emits. */
export interface NostrConnectUri {
  readonly clientPubkey: Hex32;
  readonly relays: readonly string[];
  readonly secret: string;
  readonly name?: string;
  readonly url?: string;
  readonly image?: string;
  /** Requested permissions, e.g. `sign_event:1`. */
  readonly perms: readonly string[];
}

function split(
  input: string,
  scheme: string,
): { authority: string; params: URLSearchParams } | undefined {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith(scheme)) return undefined;
  const rest = trimmed.slice(scheme.length);
  const mark = rest.indexOf("?");
  const authority = (mark === -1 ? rest : rest.slice(0, mark)).replace(
    /\/+$/,
    "",
  );
  const query = mark === -1 ? "" : rest.slice(mark + 1);
  return { authority, params: new URLSearchParams(query) };
}

/**
 * The authority as a hex pubkey.
 *
 * `npub1…` is accepted because signers do emit it, even though the NIP shows hex:
 * refusing a URI a user can plainly see contains their signer's key would be
 * pedantry, and both encodings name the same 32 bytes.
 */
function toPubkeyHex(authority: string): Hex32 | undefined {
  const lower = authority.toLowerCase();
  if (isHex32(lower)) return lower;
  if (!lower.startsWith("npub1")) return undefined;
  const ref = decodeAny(lower);
  return ref?.type === "npub" ? ref.pubkey : undefined;
}

/**
 * Relay hints, keeping only ones we could actually open.
 *
 * A `relay=` carrying an `https://` URL is dropped rather than passed through: the
 * transport would fail to open it and the connection would look like a signer that
 * never answered, which is the one failure mode hardest to tell apart from a bug.
 * Duplicates are collapsed so a URI naming the same relay twice does not double
 * every request.
 */
function relayHints(params: URLSearchParams): readonly string[] {
  const seen = new Set<string>();
  for (const raw of params.getAll("relay")) {
    const value = raw.trim();
    if (!/^wss?:\/\/\S+$/i.test(value)) continue;
    seen.add(value);
  }
  return [...seen];
}

/** True for a string that looks like a `bunker://` URI, without parsing it. */
export function isBunkerUri(input: string): boolean {
  return input.trim().toLowerCase().startsWith(BUNKER_SCHEME);
}

/**
 * Parse a `bunker://` URI.
 *
 * Returns `undefined` rather than throwing: this runs on a login form's keystroke
 * path, where "not a URI yet" is the normal state and an exception per character is
 * not a design.
 */
export function parseBunkerUri(input: string): BunkerUri | undefined {
  const parts = split(input, BUNKER_SCHEME);
  if (!parts) return undefined;
  const remoteSignerPubkey = toPubkeyHex(parts.authority);
  if (!remoteSignerPubkey) return undefined;
  const relays = relayHints(parts.params);
  // No relay means no transport. There is no default to fall back on — a bunker
  // is reachable only where its operator says it is.
  if (relays.length === 0) return undefined;
  const secret = parts.params.get("secret")?.trim();
  return {
    remoteSignerPubkey,
    relays,
    ...(secret ? { secret } : {}),
  };
}

/**
 * The URI with its secret replaced, safe to put in an error message.
 *
 * Returns the input unchanged when it does not parse, because an unparseable
 * string has no secret we can locate and blanking the whole thing would hide the
 * typo the user needs to see.
 */
export function redactBunkerUri(input: string): string {
  const parts = split(input, BUNKER_SCHEME);
  if (!parts?.params.has("secret")) return input.trim();
  // A plain word rather than an ellipsis: `URLSearchParams` percent-encodes anything
  // non-ASCII, and `secret=%E2%80%A6` in an error message reads like a mangled value
  // the user should try to fix.
  parts.params.set("secret", "removed");
  return `${BUNKER_SCHEME}${parts.authority}?${parts.params.toString()}`;
}

/** Everything a `nostrconnect://` URI needs to carry. */
export interface NostrConnectUriInput {
  readonly clientPubkey: Hex32;
  readonly relays: readonly string[];
  /** Must be unguessable — see {@link parseNostrConnectUri}. */
  readonly secret: string;
  readonly name?: string;
  readonly url?: string;
  readonly image?: string;
  readonly perms?: readonly string[];
}

/**
 * Build the URI a remote signer scans to adopt this client.
 *
 * `secret` is the whole of the authentication: the first thing the signer does is
 * echo it back, and that echo is what proves the answering key is the one the user
 * just approved rather than anybody else who saw the URI on a relay. It must come
 * from a CSPRNG — a guessable secret lets a bystander claim the connection.
 */
export function buildNostrConnectUri({
  clientPubkey,
  relays,
  secret,
  name,
  url,
  image,
  perms,
}: NostrConnectUriInput): string {
  const params = new URLSearchParams();
  // Relays first and one param per relay: the NIP repeats the key rather than
  // using a separator, and a comma-joined list is silently one unopenable relay.
  for (const relay of relays) params.append("relay", relay);
  params.set("secret", secret);
  if (perms && perms.length > 0) params.set("perms", perms.join(","));
  if (name) params.set("name", name);
  if (url) params.set("url", url);
  if (image) params.set("image", image);
  return `${NOSTRCONNECT_SCHEME}${clientPubkey}?${params.toString()}`;
}

/**
 * Parse a `nostrconnect://` URI.
 *
 * Setu emits these rather than consuming them; this exists so the round trip is
 * asserted in a test instead of assumed. A URI we build and cannot read back is a
 * URI no signer will read either, and that failure shows up only as a handshake
 * that never completes.
 */
export function parseNostrConnectUri(
  input: string,
): NostrConnectUri | undefined {
  const parts = split(input, NOSTRCONNECT_SCHEME);
  if (!parts) return undefined;
  const clientPubkey = toPubkeyHex(parts.authority);
  if (!clientPubkey) return undefined;
  const relays = relayHints(parts.params);
  if (relays.length === 0) return undefined;
  const secret = parts.params.get("secret")?.trim();
  if (!secret) return undefined;
  const perms = (parts.params.get("perms") ?? "")
    .split(",")
    .map((perm) => perm.trim())
    .filter((perm) => perm.length > 0);
  const name = parts.params.get("name") ?? undefined;
  const url = parts.params.get("url") ?? undefined;
  const image = parts.params.get("image") ?? undefined;
  return {
    clientPubkey,
    relays,
    secret,
    perms,
    ...(name ? { name } : {}),
    ...(url ? { url } : {}),
    ...(image ? { image } : {}),
  };
}
