/**
 * URL sanitization for rendered article bodies.
 *
 * An article body is arbitrary text written by a stranger, so a destination in
 * it is an attacker-controlled string that we are about to put in an `href`.
 * This module is the single place that decides whether such a string may become
 * a link at all, and it works by **allowlist**: a scheme that is not named here
 * is rejected, so a scheme nobody thought of (`vbscript:`, `blob:`,
 * `filesystem:`, whatever ships next) is refused by default rather than by
 * having been remembered.
 *
 * Two details are load-bearing:
 *
 * 1. **Control characters and whitespace are stripped before the scheme is
 *    read.** Browsers ignore tabs, newlines and NULs inside a URL, so
 *    `java&#9;script:alert(1)` navigates exactly like `javascript:alert(1)` does.
 *    A scheme test run against the un-stripped string sees `java` and lets it
 *    through.
 * 2. **Rejection returns `undefined`, never a "safe" substitute.** The caller
 *    renders inert text instead of a link. Substituting `about:blank` or `#`
 *    would leave a clickable element that looks like a working link, which is
 *    its own small lie.
 *
 * Images are held to a stricter list than links: only `http:`/`https:`. A
 * `data:` image is the interesting case — `data:image/svg+xml,…` is an image by
 * MIME type and a script host in practice, and there is no reason for an article
 * to inline one.
 */

/** Schemes a link in an article body may use. */
export const ALLOWED_LINK_SCHEMES: readonly string[] = [
  "http:",
  "https:",
  "mailto:",
  "nostr:",
];

/** Schemes an image source may use. Deliberately narrower than links. */
export const ALLOWED_IMAGE_SCHEMES: readonly string[] = ["http:", "https:"];

/**
 * ASCII control characters plus space, and the C1 range. Removed outright rather
 * than percent-encoded: they have no legitimate place in a URL an author typed,
 * and the only thing they are ever used for here is smuggling a scheme past a
 * naive prefix check.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const STRIPPED = /[\u0000-\u0020\u007f-\u009f]/g;

/** `scheme:` per RFC 3986 — a letter followed by letters, digits, `+`, `-`, `.`. */
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Longest URL we will hand to the DOM. A multi-megabyte `href` is not a link
 * anyone typed; it is a way to make a page cost more to render than to send.
 */
const MAX_URL_LENGTH = 4096;

/**
 * Normalize and allowlist a URL.
 *
 * Returns the cleaned URL when it is safe to render as a destination, or
 * `undefined` when it is not. A scheme-relative `//host/path` is accepted and
 * resolved to `https:`, because the alternative is inheriting the page's scheme
 * implicitly and that is one fewer thing the reader can see.
 *
 * Relative URLs (`/foo`, `foo.md`, `#anchor`) are **rejected**. An article has
 * no base document — there is nothing for them to be relative to — so the only
 * thing they could resolve against is the client's own origin, turning a
 * stranger's text into a link into our own UI.
 */
export function sanitizeUrl(
  raw: string,
  allowedSchemes: readonly string[] = ALLOWED_LINK_SCHEMES,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(STRIPPED, "");
  if (cleaned === "" || cleaned.length > MAX_URL_LENGTH) return undefined;

  const match = SCHEME.exec(cleaned);
  if (match) {
    const scheme = `${match[1]?.toLowerCase() ?? ""}:`;
    return allowedSchemes.includes(scheme) ? cleaned : undefined;
  }

  // Scheme-relative. Only meaningful for network schemes, so it follows the
  // image/link distinction: if `https:` is not allowed, neither is this.
  if (cleaned.startsWith("//") && allowedSchemes.includes("https:")) {
    return `https:${cleaned}`;
  }

  return undefined;
}

/** `sanitizeUrl` with the image allowlist. */
export function sanitizeImageUrl(raw: string): string | undefined {
  return sanitizeUrl(raw, ALLOWED_IMAGE_SCHEMES);
}

/**
 * True when a link leaves the app and therefore needs `rel` hardening.
 *
 * `nostr:` and `mailto:` are handed to a protocol handler rather than opened in
 * a tab, so `target="_blank"` on them does nothing useful.
 */
export function isExternalHref(href: string): boolean {
  const match = SCHEME.exec(href);
  const scheme = match ? `${match[1]?.toLowerCase() ?? ""}:` : "";
  return scheme === "http:" || scheme === "https:";
}
