import { describe, expect, it } from "vitest";
import { isPayableHost, lnurlPayEndpoint, zapCallbackUrl } from "./lnurl";

/**
 * Adversarial inputs for the lightning-address path.
 *
 * A `lud16`/`lud06` value is arbitrary text from a stranger's profile, and the
 * zap flow turns it into an outbound HTTP request from the reader's browser. If
 * a profile can steer that request, a note's zap button becomes an SSRF
 * primitive aimed at whatever the reader's machine can reach — a cloud metadata
 * endpoint, a router admin page, a service on localhost.
 *
 * These cases are separate from `lnurl.test.ts` on purpose: that file proves the
 * happy path and the spec vectors, this one exists so a future "just relax the
 * host check a little" change fails loudly.
 */

/** Every one of these must be refused, whatever the reason. */
const HOSTILE_ADDRESSES = [
  // Loopback and link-local, in several disguises.
  "bob@localhost",
  "bob@127.0.0.1",
  "bob@127.1",
  "bob@0.0.0.0",
  "bob@[::1]",
  "bob@0x7f000001",
  // Cloud instance metadata — the highest-value SSRF target there is.
  "bob@169.254.169.254",
  "bob@metadata.google.internal",
  // RFC1918 space reachable from a home or office network.
  "bob@10.0.0.1",
  "bob@192.168.1.1",
  "bob@172.16.0.1",
  // Bare hostnames that resolve only on an internal network.
  "bob@internal",
  "bob@router",
  // A port lets an attacker sweep services on an otherwise legitimate host.
  "bob@example.com:8080",
  "bob@example.com:22",
  // Embedded credentials, and ambiguous multi-`@` parsing.
  "user:pass@example.com",
  "bob@@example.com",
  "bob@evil.com@example.com",
  // Path and fragment smuggling into the well-known URL.
  "bob@example.com/../../admin",
  "bob@example.com#x",
  "bob@example.com?a=b",
  "b/ob@example.com",
  // Not an address at all.
  "http://example.com/x",
  "https://example.com/.well-known/lnurlp/bob",
  "bob",
  "@example.com",
  "bob@",
  "",
  "   ",
];

describe("lightning address host validation", () => {
  it.each(HOSTILE_ADDRESSES)("refuses %j", (address) => {
    const result = lnurlPayEndpoint(address);
    // A refusal is anything that does not hand back a URL to fetch.
    expect(result.ok, `${address} must not produce a fetchable URL`).toBe(
      false,
    );
  });

  it("accepts an ordinary address and targets the well-known path", () => {
    const result = lnurlPayEndpoint("bob@example.com");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe("https://example.com/.well-known/lnurlp/bob");
  });

  it("only accepts https", () => {
    // A downgrade would expose the request and the invoice to the network path.
    const result = lnurlPayEndpoint("bob@example.com");
    expect(result.ok && result.url.startsWith("https://")).toBe(true);
  });

  it("rejects hosts directly, not just via address parsing", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "169.254.169.254",
      "10.0.0.1",
      "internal",
      "example.com:8080",
      "0x7f.0.0.1",
    ]) {
      expect(isPayableHost(host), host).toBe(false);
    }
    expect(isPayableHost("example.com")).toBe(true);
    expect(isPayableHost("pay.example.co.uk")).toBe(true);
  });
});

describe("zap callback URL", () => {
  /**
   * The callback comes from the LNURL server's own JSON response, so it is the
   * *second* place a hostile value can enter. Validating the address and then
   * trusting whatever the server names would defeat the first check entirely.
   */
  const hostileCallbacks = [
    "http://example.com/cb",
    "https://127.0.0.1/cb",
    "https://169.254.169.254/cb",
    "https://localhost/cb",
    "https://example.com:8080/cb",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "",
  ];

  it.each(hostileCallbacks)("refuses a server-supplied callback %j", (cb) => {
    const result = zapCallbackUrl({
      callback: cb,
      amountMsat: 21000,
      zapRequest: '{"kind":9734}',
    });
    expect(result.ok, `${cb} must not be fetched`).toBe(false);
  });

  it("builds a callback with the amount and the signed request attached", () => {
    const result = zapCallbackUrl({
      callback: "https://example.com/lnurlp/callback",
      amountMsat: 21000,
      zapRequest: '{"kind":9734,"content":""}',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("amount")).toBe("21000");
    // The request must survive URL encoding intact or the recipient's wallet
    // cannot attribute the zap.
    expect(JSON.parse(url.searchParams.get("nostr") ?? "{}").kind).toBe(9734);
  });

  it("preserves a query string the server already put on its callback", () => {
    // LNURL servers legitimately do this; dropping it breaks the callback.
    const result = zapCallbackUrl({
      callback: "https://example.com/cb?id=abc",
      amountMsat: 1000,
      zapRequest: "{}",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(url.searchParams.get("id")).toBe("abc");
    expect(url.searchParams.get("amount")).toBe("1000");
  });
});
