/**
 * NIP-05 address parsing and response checking. Pure — no fetching here.
 *
 * The point of NIP-05 is a *round trip*: the profile claims an identifier, and
 * the domain must independently claim the pubkey back. Only the second half is
 * evidence, so this module never returns "probably fine". Anything it cannot
 * confirm is a failure, including a response that is merely malformed — a
 * checkmark earned by a parse error is worse than no checkmark.
 *
 * Input validation is also a security boundary. The identifier's local part goes
 * into a query string and its domain into a URL's host, both from arbitrary
 * user-published JSON. Accepting `evil.com/x?` or `a/../..` as a "domain" would
 * let a profile point the verifier at a URL of its choosing, so both halves are
 * matched against strict patterns before a URL is ever built.
 */

/** A NIP-05 identifier split into its parts, both lowercased. */
export interface Nip05Address {
  /** Local part. `_` for a domain-root identifier. */
  readonly local: string;
  readonly domain: string;
}

/** NIP-05 restricts the local part to these characters. */
const LOCAL_PATTERN = /^[a-z0-9\-_.]+$/;

/**
 * Hostname with at least one dot and no port, path, credentials or wildcards.
 * Deliberately stricter than the DNS grammar: this is an allowlist for building
 * a URL, not a general validator.
 */
const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const HEX32_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parse a NIP-05 identifier.
 *
 * A string with no `@` is treated as a domain-root identifier (`_@domain`),
 * which is the same convention NIP-05 uses in the other direction when it
 * renders `_@example.com` as plain `example.com`. Anything that is not a
 * plausible hostname is rejected rather than guessed at.
 */
export function parseNip05(identifier: string): Nip05Address | undefined {
  const value = identifier.trim().toLowerCase();
  if (value.length === 0 || value.length > 320) return undefined;

  const at = value.indexOf("@");
  if (at < 0) {
    return DOMAIN_PATTERN.test(value)
      ? { local: "_", domain: value }
      : undefined;
  }
  // Two `@` characters means it is not an identifier, whatever it is.
  if (value.indexOf("@", at + 1) >= 0) return undefined;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!LOCAL_PATTERN.test(local)) return undefined;
  if (!DOMAIN_PATTERN.test(domain)) return undefined;
  return { local, domain };
}

/** The `.well-known/nostr.json` URL for an address. Always https. */
export function nip05WellKnownUrl(address: Nip05Address): string {
  const name = encodeURIComponent(address.local);
  return `https://${address.domain}/.well-known/nostr.json?name=${name}`;
}

/**
 * The pubkey a `nostr.json` body maps a local part to.
 *
 * Returns undefined for malformed JSON, a missing or non-object `names` key, a
 * missing entry, or a value that is not a 32-byte lowercase hex string. A relay
 * or domain returning junk must not be able to produce a match.
 */
export function nip05MappedPubkey(
  body: string,
  local: string,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const names = (parsed as { names?: unknown }).names;
  if (typeof names !== "object" || names === null || Array.isArray(names)) {
    return undefined;
  }
  const mapped = (names as Record<string, unknown>)[local];
  if (typeof mapped !== "string") return undefined;
  const normalized = mapped.trim().toLowerCase();
  return HEX32_PATTERN.test(normalized) ? normalized : undefined;
}

/** True when the body maps `local` to exactly `pubkey`. */
export function nip05MatchesPubkey(
  body: string,
  local: string,
  pubkey: string,
): boolean {
  const mapped = nip05MappedPubkey(body, local);
  if (mapped === undefined) return false;
  return mapped === pubkey.trim().toLowerCase();
}

/**
 * Display form of an identifier: `_@example.com` reads as `example.com`.
 * Cosmetic only — never feed the result back into `parseNip05` expectations.
 */
export function nip05DisplayName(identifier: string): string {
  const address = parseNip05(identifier);
  if (address === undefined) return identifier;
  return address.local === "_"
    ? address.domain
    : `${address.local}@${address.domain}`;
}
