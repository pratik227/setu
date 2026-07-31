/**
 * Turning a profile's lightning field into a URL we are willing to fetch.
 *
 * Everything here is pure, and all of it is a validator rather than a parser.
 * `lud16`/`lud06` are arbitrary strings a stranger published in a kind-0, and the
 * only thing standing between that string and an outbound request from the
 * reader's browser is this module. So the rules are deliberately narrow:
 *
 *  - **https only.** A `http:` LNURL would leak the payment intent, and a
 *    `javascript:`/`data:` one is a script-injection dressed as a payment.
 *  - **A real registrable domain only.** `bob@localhost`, `bob@127.0.0.1` and
 *    `bob@internal` would aim the request at the reader's own machine or network,
 *    which turns a note's zap button into an SSRF primitive against the reader.
 *  - **No port, no credentials, no path in the host.** All three are ways to
 *    smuggle a different destination past a naive `user@host` split.
 *
 * The LNURL server's own response is treated with the same suspicion: the
 * `callback` it hands back goes through the same host check before we build a URL
 * from it (`zapCallbackUrl`), because "the server we just asked" is not a
 * trusted source of the next URL to fetch.
 */

// --- bech32 ------------------------------------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** BIP-173 checksum generator constants. */
const GENERATOR = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
] as const;

function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >>> i) & 1) checksum ^= GENERATOR[i] as number;
    }
  }
  return checksum;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** 5-bit groups to bytes, rejecting any non-canonical padding. */
function fromWords(words: readonly number[]): Uint8Array | undefined {
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of words) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  // Leftover bits must be zero padding and fewer than a full group; anything
  // else is a malleable encoding of the same payload.
  if (bits >= 5 || ((accumulator << (8 - bits)) & 0xff) !== 0) return undefined;
  return new Uint8Array(bytes);
}

/**
 * Decode a `lnurl1…` string to the URL it carries.
 *
 * Deliberately not the generic bech32 decoder from a library: LNURL payloads run
 * far past bech32's 90-character limit, so a spec-conformant decoder rejects
 * them. The length cap is the only rule relaxed — the charset, the separator
 * position and the checksum are all enforced.
 */
export function decodeLnurl(input: string): string | undefined {
  const trimmed = input.trim().replace(/^lightning:/i, "");
  // Mixed case is unspecified in bech32 and is a classic way to smuggle two
  // different readings of one string past two implementations.
  if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();

  const separator = lower.lastIndexOf("1");
  if (separator < 1) return undefined;
  if (lower.slice(0, separator) !== "lnurl") return undefined;

  const dataPart = lower.slice(separator + 1);
  // 6 checksum characters plus at least one payload character.
  if (dataPart.length < 7) return undefined;

  const words: number[] = [];
  for (const character of dataPart) {
    const index = CHARSET.indexOf(character);
    if (index < 0) return undefined;
    words.push(index);
  }

  if (polymod([...hrpExpand("lnurl"), ...words]) !== 1) return undefined;

  const bytes = fromWords(words.slice(0, -6));
  if (!bytes) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

// --- host validation ---------------------------------------------------------

/**
 * A registrable domain: dot-separated labels of letters, digits and inner
 * hyphens. At least two labels, so a bare hostname on the reader's own network
 * cannot qualify.
 */
const DOMAIN =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/**
 * Top-level names that never belong to a public host.
 *
 * `metadata.google.internal` satisfies every structural rule for a domain — dots,
 * letters, a non-numeric last label — and resolves, inside a cloud VM, to the
 * instance metadata service. Structure alone therefore cannot decide this; the
 * special-use names have to be named. RFC 6761 and RFC 8375 reserve these, plus
 * the `.internal` convention every major cloud uses for private zones.
 */
const RESERVED_TLDS = new Set([
  "internal",
  "local",
  "localhost",
  "localdomain",
  "home",
  "arpa",
  "test",
  "example",
  "invalid",
  "onion",
  "alt",
  "lan",
  "intranet",
  "private",
  "corp",
]);

/** True for a host we are willing to send a payment request to. */
export function isPayableHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (!DOMAIN.test(lower)) return false;
  const labels = lower.split(".");
  const tld = labels[labels.length - 1] as string;
  // An all-numeric last label means this is a dotted IP address wearing a domain
  // shape — `127.0.0.1` passes the label rules and must still be refused.
  if (/^\d+$/.test(tld)) return false;
  if (RESERVED_TLDS.has(tld)) return false;
  // `home.arpa` is the reserved residential zone; the `arpa` check above covers
  // it, but a two-label private suffix like `foo.home` needs the second label
  // checked too for the common router-assigned zones.
  const secondLevel =
    labels.length >= 2 ? (labels[labels.length - 2] as string) : "";
  if (labels.length >= 2 && RESERVED_TLDS.has(secondLevel) && tld === "arpa") {
    return false;
  }
  return true;
}

/**
 * An https URL on a payable host, with no embedded credentials and no port.
 *
 * Returns the normalized URL, or undefined when the input is anything else.
 */
function asPayableUrl(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  // A port is how a hostile profile reaches a service that is not a public web
  // server; there is no legitimate LNURL endpoint that needs one.
  if (parsed.port !== "") return undefined;
  if (!isPayableHost(parsed.hostname)) return undefined;
  return parsed.toString();
}

// --- lud16 / lud06 -----------------------------------------------------------

/** Why a lightning field could not be turned into an endpoint. */
export type LnurlRefusal =
  /** The author published no `lud16`/`lud06` at all. */
  | "missing"
  /** Present but not a readable lightning address or LNURL. */
  | "malformed"
  /**
   * Readable, but pointing somewhere we refuse to send a request: a bare
   * hostname, an IP literal, a port, or a non-https scheme.
   */
  | "unsafe-host";

export type LnurlEndpoint =
  | {
      readonly ok: true;
      readonly url: string;
      readonly source: "lud16" | "lud06";
      /** The original `lnurl1…` string, when the field was a `lud06`. */
      readonly lnurl?: string;
    }
  | { readonly ok: false; readonly reason: LnurlRefusal };

/** Local part of a lightning address: no slashes, no colons, no escapes. */
const LUD16_NAME = /^[a-z0-9._-]+$/i;

/**
 * Resolve `lud16` (`name@domain`) or `lud06` (`lnurl1…`) to its LNURL-pay URL.
 *
 * The `lud16` form is a *convention*, not a redirect: `name@domain` means
 * `https://domain/.well-known/lnurlp/name` and nothing else. Building it by
 * string concatenation without validating both halves is how a profile field
 * ends up choosing the origin of an outbound request.
 */
export function lnurlPayEndpoint(lightning: string | undefined): LnurlEndpoint {
  const raw = lightning?.trim();
  if (!raw) return { ok: false, reason: "missing" };

  if (/^(lnurl1|lightning:)/i.test(raw)) {
    const decoded = decodeLnurl(raw);
    if (!decoded) return { ok: false, reason: "malformed" };
    const url = asPayableUrl(decoded);
    if (!url) return { ok: false, reason: "unsafe-host" };
    return {
      ok: true,
      url,
      source: "lud06",
      lnurl: raw.replace(/^lightning:/i, "").toLowerCase(),
    };
  }

  const at = raw.indexOf("@");
  // Exactly one `@`: a second one means the "domain" half is itself structured,
  // and whichever side an implementation picks, another will pick the other.
  if (at < 1 || raw.indexOf("@", at + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }
  const name = raw.slice(0, at);
  const host = raw.slice(at + 1).toLowerCase();
  if (!LUD16_NAME.test(name)) return { ok: false, reason: "malformed" };
  if (!isPayableHost(host)) return { ok: false, reason: "unsafe-host" };

  return {
    ok: true,
    url: `https://${host}/.well-known/lnurlp/${encodeURIComponent(name)}`,
    source: "lud16",
  };
}

// --- callback ----------------------------------------------------------------

export interface ZapCallbackInput {
  /** `callback` from the LNURL-pay response. Untrusted, like everything else. */
  readonly callback: string;
  readonly amountMsat: number;
  /** The signed kind-9734, serialized by the caller or handed in as an object. */
  readonly zapRequest: unknown;
  /** The original `lnurl1…`, echoed back per NIP-57 when we have one. */
  readonly lnurl?: string;
}

export type ZapCallbackResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: LnurlRefusal | "bad-amount" };

/**
 * Build the LNURL-pay callback URL that asks for a zap invoice.
 *
 * Existing query parameters on the callback are preserved — LNURL servers
 * routinely carry state there, and rebuilding the URL from origin plus path
 * silently drops it.
 */
export function zapCallbackUrl(input: ZapCallbackInput): ZapCallbackResult {
  if (
    !Number.isFinite(input.amountMsat) ||
    !Number.isInteger(input.amountMsat) ||
    input.amountMsat <= 0
  ) {
    return { ok: false, reason: "bad-amount" };
  }

  const safe = asPayableUrl(input.callback);
  if (!safe) return { ok: false, reason: "unsafe-host" };

  const url = new URL(safe);
  url.searchParams.set("amount", String(input.amountMsat));
  // `zapRequest` may arrive already serialized. Stringifying a string produces a
  // JSON-quoted string, which the LNURL server hands to the recipient's wallet
  // as a quoted blob rather than a zap request — the payment may still go
  // through, but the kind-9735 receipt cannot be attributed to the zap.
  url.searchParams.set(
    "nostr",
    typeof input.zapRequest === "string"
      ? input.zapRequest
      : JSON.stringify(input.zapRequest),
  );
  if (input.lnurl) url.searchParams.set("lnurl", input.lnurl);
  return { ok: true, url: url.toString() };
}

/** One-line explanation of a refusal, for a tooltip or an inline error. */
export function lnurlRefusalMessage(
  reason: LnurlRefusal | "bad-amount",
): string {
  switch (reason) {
    case "missing":
      return "This author has not published a lightning address.";
    case "malformed":
      return "This author's lightning address could not be read.";
    case "unsafe-host":
      return "This author's lightning address does not point at a public https host, so Setu will not send a request to it.";
    case "bad-amount":
      return "That zap amount is not a whole number of millisatoshis.";
  }
}
