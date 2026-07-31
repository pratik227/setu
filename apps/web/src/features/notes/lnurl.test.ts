import { describe, expect, it } from "vitest";
import {
  decodeLnurl,
  isPayableHost,
  lnurlPayEndpoint,
  zapCallbackUrl,
} from "./lnurl";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
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

/**
 * An independent encoder, so hostile inputs can be constructed rather than
 * pasted. One vector below is the published LUD-01 one, which cross-checks this
 * encoder and the module's decoder against a third party.
 */
function encodeLnurl(url: string): string {
  const bytes = new TextEncoder().encode(url);
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);

  const checksumInput = [...hrpExpand("lnurl"), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(checksumInput) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    checksum.push((mod >> (5 * (5 - i))) & 31);
  }
  const data = [...words, ...checksum]
    .map((w) => CHARSET[w] as string)
    .join("");
  return `lnurl1${data}`;
}

/** The LUD-01 test vector, verbatim. */
const SPEC_LNURL =
  "LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35X" +
  "VUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9" +
  "XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS";
const SPEC_URL =
  "https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df";

describe("decodeLnurl", () => {
  it("decodes the published LUD-01 vector", () => {
    expect(decodeLnurl(SPEC_LNURL)).toBe(SPEC_URL);
  });

  it("accepts a lightning: scheme prefix", () => {
    expect(decodeLnurl(`lightning:${SPEC_LNURL}`)).toBe(SPEC_URL);
  });

  it("round-trips a URL through the test encoder", () => {
    const url = "https://wallet.example.com/lnurlp/bob?x=1";
    expect(decodeLnurl(encodeLnurl(url))).toBe(url);
  });

  it("rejects a broken checksum", () => {
    const good = encodeLnurl("https://wallet.example.com/lnurlp/bob");
    const broken = `${good.slice(0, -1)}${good.endsWith("q") ? "p" : "q"}`;
    expect(decodeLnurl(broken)).toBeUndefined();
  });

  it("rejects mixed case, which two implementations can read two ways", () => {
    const encoded = encodeLnurl("https://wallet.example.com/lnurlp/bob");
    const mixed = `LNURL1${encoded.slice(6)}`;
    expect(decodeLnurl(mixed)).toBeUndefined();
  });

  it("rejects a different human-readable part", () => {
    expect(decodeLnurl("npub1qqqqqqqqqqqqqqq")).toBeUndefined();
  });

  it("rejects characters outside the bech32 charset", () => {
    expect(decodeLnurl("lnurl1bbbbbbb")).toBeUndefined();
  });
});

describe("lnurlPayEndpoint — lud16", () => {
  it("maps user@host to the well-known lnurlp path", () => {
    const result = lnurlPayEndpoint("bob@example.com");
    expect(result).toEqual({
      ok: true,
      url: "https://example.com/.well-known/lnurlp/bob",
      source: "lud16",
    });
  });

  it("lowercases the host but keeps the local part", () => {
    const result = lnurlPayEndpoint("Bob.Smith@Example.COM");
    expect(result.ok && result.url).toBe(
      "https://example.com/.well-known/lnurlp/Bob.Smith",
    );
  });
});

describe("lnurlPayEndpoint — lud06", () => {
  it("decodes a bech32 LNURL and echoes it back for NIP-57", () => {
    const result = lnurlPayEndpoint(SPEC_LNURL);
    expect(result.ok && result.source).toBe("lud06");
    expect(result.ok && result.url).toBe(SPEC_URL);
    expect(result.ok && result.lnurl).toBe(SPEC_LNURL.toLowerCase());
  });
});

describe("lnurlPayEndpoint — refusals", () => {
  it("reports a missing field separately from a broken one", () => {
    expect(lnurlPayEndpoint(undefined)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(lnurlPayEndpoint("   ")).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses garbage", () => {
    for (const value of [
      "not an address",
      "bob@",
      "@example.com",
      "bob@a@b.com",
      "lnurl1notvalid",
    ]) {
      expect(lnurlPayEndpoint(value).ok).toBe(false);
    }
  });

  it("refuses a local part that could steer the path", () => {
    // `..%2f` and friends would otherwise walk out of /.well-known/lnurlp/.
    expect(lnurlPayEndpoint("../../admin@example.com")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(lnurlPayEndpoint("bob/x@example.com")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a host that is not a public registrable domain", () => {
    // A kind-0 field must not be able to aim a request at the reader's own
    // machine or network.
    for (const host of [
      "localhost",
      "127.0.0.1",
      "192.168.1.10",
      "intranet",
      "example.com:8443",
      "exa_mple.com",
      "-example.com",
      "example-.com",
    ]) {
      expect(lnurlPayEndpoint(`bob@${host}`)).toEqual({
        ok: false,
        reason: "unsafe-host",
      });
    }
  });

  it("refuses a lud06 that decodes to a non-https URL", () => {
    expect(
      lnurlPayEndpoint(encodeLnurl("http://example.com/lnurlp/bob")),
    ).toEqual({ ok: false, reason: "unsafe-host" });
    expect(lnurlPayEndpoint(encodeLnurl("javascript:alert(1)")).ok).toBe(false);
  });

  it("refuses a lud06 that decodes to a private host or a port", () => {
    expect(lnurlPayEndpoint(encodeLnurl("https://localhost/lnurlp"))).toEqual({
      ok: false,
      reason: "unsafe-host",
    });
    expect(
      lnurlPayEndpoint(encodeLnurl("https://example.com:9000/lnurlp")),
    ).toEqual({ ok: false, reason: "unsafe-host" });
    expect(
      lnurlPayEndpoint(encodeLnurl("https://user:pw@example.com/lnurlp")),
    ).toEqual({ ok: false, reason: "unsafe-host" });
  });
});

describe("isPayableHost", () => {
  it("requires at least two labels and a non-numeric last label", () => {
    expect(isPayableHost("example.com")).toBe(true);
    expect(isPayableHost("a.b.example.co.uk")).toBe(true);
    expect(isPayableHost("example")).toBe(false);
    expect(isPayableHost("1.2.3.4")).toBe(false);
  });
});

describe("zapCallbackUrl", () => {
  const zapRequest = { kind: 9734, tags: [["p", "a".repeat(64)]] };

  it("adds amount and the zap request, preserving existing parameters", () => {
    const result = zapCallbackUrl({
      callback: "https://wallet.example.com/pay?session=abc",
      amountMsat: 21000,
      zapRequest,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(url.searchParams.get("session")).toBe("abc");
    expect(url.searchParams.get("amount")).toBe("21000");
    expect(JSON.parse(url.searchParams.get("nostr") ?? "")).toEqual(zapRequest);
    expect(url.searchParams.get("lnurl")).toBeNull();
  });

  it("echoes the lnurl back when the profile carried a lud06", () => {
    const result = zapCallbackUrl({
      callback: "https://wallet.example.com/pay",
      amountMsat: 1000,
      zapRequest,
      lnurl: "lnurl1abc",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new URL(result.url).searchParams.get("lnurl")).toBe("lnurl1abc");
  });

  it("refuses a callback the server pointed somewhere unsafe", () => {
    // The LNURL server is not a trusted source of the next URL to fetch.
    expect(
      zapCallbackUrl({
        callback: "http://127.0.0.1:8080/pay",
        amountMsat: 1000,
        zapRequest,
      }),
    ).toEqual({ ok: false, reason: "unsafe-host" });
  });

  it("refuses a non-integer or non-positive amount", () => {
    for (const amountMsat of [0, -1, 1.5, Number.NaN]) {
      expect(
        zapCallbackUrl({
          callback: "https://wallet.example.com/pay",
          amountMsat,
          zapRequest,
        }),
      ).toEqual({ ok: false, reason: "bad-amount" });
    }
  });
});
