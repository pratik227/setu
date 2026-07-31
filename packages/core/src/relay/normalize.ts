/**
 * Relay URL normalisation.
 *
 * One socket per relay is only achievable if `wss://Relay.example/` and
 * `wss://relay.example` are the same key. Every relay URL entering the pool —
 * from a filter, a NIP-65 list, or user input — goes through here first.
 */

/**
 * Canonical form of a relay URL: lowercase scheme and host, no trailing slash,
 * no query string or fragment, `wss://` assumed when no scheme is given.
 *
 * Path case is preserved (relay paths can be case-sensitive) and so is a
 * non-default port. Input that cannot be parsed is returned lowercased and
 * de-slashed rather than thrown away, so a typo degrades to a dead relay instead
 * of a crash.
 */
export function normalizeRelayUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "";
  const withScheme = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `wss://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.host.toLowerCase();
    const path =
      parsed.pathname === "/" ? "" : stripTrailingSlash(parsed.pathname);
    return `${protocol}//${host}${path}`;
  } catch {
    return stripTrailingSlash(trimmed.toLowerCase());
  }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Normalises and de-duplicates a list of relay URLs, preserving order. */
export function normalizeRelayUrls(urls: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const url of urls) {
    const normalized = normalizeRelayUrl(url);
    if (normalized === "" || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

/**
 * The HTTP URL a relay's NIP-11 document lives at (`wss://` → `https://`).
 */
export function nip11Url(relayUrl: string): string {
  const normalized = normalizeRelayUrl(relayUrl);
  if (normalized.startsWith("wss://")) {
    return `https://${normalized.slice("wss://".length)}`;
  }
  if (normalized.startsWith("ws://")) {
    return `http://${normalized.slice("ws://".length)}`;
  }
  return normalized;
}
