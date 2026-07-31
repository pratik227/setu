import { Kind } from "./kinds";
import type { EventTemplate, NostrEvent } from "./types";

/**
 * NIP-42 relay authentication.
 *
 * A relay sends `["AUTH", <challenge>]`; the client answers with a signed kind-22242
 * naming the relay and echoing the challenge. Relays use it to gate paid accounts,
 * private inboxes and DM delivery — and a relay that wants AUTH and does not get it
 * answers queries with *silence*, which is why an unauthenticated client looks like
 * a broken one rather than a logged-out one.
 *
 * ## The replay problem
 *
 * The signed event is a bearer proof of identity. If relay A can obtain a proof you
 * made for relay B, A can present it to B and act as you. Two tags prevent that, and
 * both must be checked on the way *out* rather than trusted on the way in:
 *
 *  - `relay` must be the relay we are actually talking to. Signing an event that
 *    names a relay we are not connected to hands that relay a proof for another.
 *  - `challenge` must be the string that relay just sent. A reused or attacker-chosen
 *    challenge lets a proof be prepared in advance.
 *
 * {@link buildAuthEvent} constructs it and {@link isAuthEventFor} checks a
 * constructed event before it is signed, so the pool cannot accidentally sign a
 * proof for the wrong party.
 *
 * ## What authenticating costs
 *
 * It tells the relay who you are. Before AUTH a relay sees an anonymous socket; after
 * it, every query is attributable to your pubkey. That is a real trade, not a
 * formality, which is why the pool only authenticates to relays the account has
 * chosen — see `shouldAuthenticate` in the pool.
 */

/** NIP-42 client authentication event kind. */
export const CLIENT_AUTH_KIND = Kind.ClientAuth;

/**
 * Relay URLs compared the way NIP-42 needs.
 *
 * Only scheme, host and path matter. Relays disagree about the trailing slash and
 * about case in the host, so a byte comparison rejects proofs that are correct —
 * and a client that cannot authenticate to a relay it *is* connected to would then
 * loop, re-signing forever.
 */
export function sameRelay(a: string, b: string): boolean {
  const canonical = (raw: string): string | undefined => {
    try {
      const url = new URL(raw);
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.protocol}//${url.host.toLowerCase()}${path}`;
    } catch {
      return undefined;
    }
  };
  const left = canonical(a);
  const right = canonical(b);
  return left !== undefined && left === right;
}

export interface AuthEventInput {
  /** The relay that issued the challenge, as we know it. */
  readonly relay: string;
  /** The challenge string exactly as the relay sent it. */
  readonly challenge: string;
  readonly createdAt?: number;
}

/** The kind-22242 template answering one challenge from one relay. */
export function buildAuthEvent({
  relay,
  challenge,
  createdAt,
}: AuthEventInput): EventTemplate {
  return {
    kind: CLIENT_AUTH_KIND,
    content: "",
    tags: [
      ["relay", relay],
      ["challenge", challenge],
    ],
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
  };
}

/**
 * Is this event a valid proof for exactly this relay and challenge?
 *
 * Checked before signing, not after. Once signed, an event naming the wrong relay
 * is already a proof someone else can use — the only safe place to catch it is
 * before the signature exists.
 */
export function isAuthEventFor(
  event: EventTemplate | NostrEvent,
  relay: string,
  challenge: string,
): boolean {
  if (event.kind !== CLIENT_AUTH_KIND) return false;
  const tags = event.tags ?? [];
  const relayTag = tags.find((tag) => tag[0] === "relay")?.[1];
  const challengeTag = tags.find((tag) => tag[0] === "challenge")?.[1];
  if (relayTag === undefined || challengeTag === undefined) return false;
  // Challenge is compared exactly: it is an opaque token, and normalising it
  // would let a near-miss through.
  return challengeTag === challenge && sameRelay(relayTag, relay);
}

/**
 * Does this relay message mean "authenticate and try again"?
 *
 * NIP-42 prefixes the reason on `CLOSED` and `OK` with `auth-required:`. Reading it
 * is what turns a query that silently returned nothing into one the client can
 * retry after authenticating.
 */
export function isAuthRequired(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith("auth-required:");
}

/** `restricted:` — authenticated, but this account may not do that. */
export function isRestricted(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith("restricted:");
}
