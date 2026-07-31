import { describe, expect, it } from "vitest";
import {
  assertSafeUploadUrl,
  buildHttpAuth,
  httpAuthHeader,
  imetaTag,
  parseNip96Config,
  parseUploadResponse,
  UploadError,
} from "./nip96";

const signed = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1_700_000_000,
  kind: 27235,
  tags: [
    ["u", "https://host.example.com/api"],
    ["method", "POST"],
  ],
  content: "",
  sig: "c".repeat(128),
};

describe("assertSafeUploadUrl", () => {
  it("accepts a plain HTTPS host", () => {
    expect(assertSafeUploadUrl("https://media.example.com/api").hostname).toBe(
      "media.example.com",
    );
  });

  it.each([
    ["http://media.example.com", "plain HTTP"],
    ["https://localhost/api", "localhost"],
    ["https://127.0.0.1/api", "loopback literal"],
    ["https://192.168.1.1/api", "private IP literal"],
    ["https://metadata.google.internal/api", "cloud metadata"],
    ["https://box.local/api", ".local"],
    ["https://svc.internal/api", ".internal"],
    ["https://x.onion/api", ".onion"],
    ["https://user:pw@media.example.com/api", "credentials in URL"],
    ["not a url", "unparseable"],
  ])("rejects %s (%s)", (raw) => {
    expect(() => assertSafeUploadUrl(raw)).toThrow(UploadError);
  });
});

describe("buildHttpAuth / httpAuthHeader", () => {
  it("pins the auth event to one URL and method", () => {
    const template = buildHttpAuth("https://host.example.com/api", "post");
    expect(template.kind).toBe(27235);
    expect(template.tags).toEqual(
      expect.arrayContaining([
        ["u", "https://host.example.com/api"],
        // Upper-cased: a host comparing against "POST" must match.
        ["method", "POST"],
      ]),
    );
  });

  it("encodes the event as base64 behind the Nostr scheme", () => {
    const header = httpAuthHeader(signed);
    expect(header.startsWith("Nostr ")).toBe(true);
    const decoded = JSON.parse(atob(header.slice("Nostr ".length)));
    expect(decoded.id).toBe(signed.id);
    expect(decoded.kind).toBe(27235);
  });
});

describe("parseNip96Config", () => {
  it("reads api_url", () => {
    expect(
      parseNip96Config({ api_url: "https://media.example.com/api" }),
    ).toEqual({
      apiUrl: "https://media.example.com/api",
    });
  });

  it.each<[unknown, string]>([
    [null, "null body"],
    [{}, "no api_url"],
    [{ api_url: "" }, "empty api_url"],
  ])("rejects %s (%s)", (body) => {
    expect(() => parseNip96Config(body)).toThrow(UploadError);
  });

  it("refuses an api_url the host pointed at our own network", () => {
    // The specific attack: a hostile (or compromised) media host answers the
    // well-known with an endpoint inside the reader's network, and the browser
    // POSTs there carrying a signature.
    expect(() =>
      parseNip96Config({ api_url: "https://192.168.0.1/upload" }),
    ).toThrow(UploadError);
    expect(() =>
      parseNip96Config({ api_url: "http://localhost:8080/upload" }),
    ).toThrow(UploadError);
  });
});

describe("parseUploadResponse", () => {
  const ok = {
    status: "success",
    nip94_event: {
      tags: [
        ["url", "https://media.example.com/abc.gif"],
        ["m", "image/gif"],
        ["x", "d".repeat(64)],
        ["dim", "480x270"],
      ],
    },
  };

  it("reads the url and metadata", () => {
    expect(parseUploadResponse(ok)).toEqual({
      url: "https://media.example.com/abc.gif",
      mimeType: "image/gif",
      hash: "d".repeat(64),
      dimensions: "480x270",
    });
  });

  it("keeps url mandatory and everything else optional", () => {
    const sparse = parseUploadResponse({
      nip94_event: { tags: [["url", "https://media.example.com/x.png"]] },
    });
    expect(sparse.url).toBe("https://media.example.com/x.png");
    expect(sparse.mimeType).toBeUndefined();
  });

  it("surfaces the host's own error message", () => {
    expect(() =>
      parseUploadResponse({ status: "error", message: "File too large" }),
    ).toThrow("File too large");
  });

  it("rejects a hostile media URL from the host", () => {
    // This string would be published in a note and rendered by other people's
    // clients, so the host does not get to choose the scheme.
    for (const url of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "http://media.example.com/x.png",
      "not-a-url",
    ]) {
      expect(() =>
        parseUploadResponse({ nip94_event: { tags: [["url", url]] } }),
      ).toThrow(UploadError);
    }
  });

  it.each<[unknown, string]>([
    [null, "null"],
    [{}, "no nip94_event"],
    [{ nip94_event: {} }, "no tags"],
    [{ nip94_event: { tags: [] } }, "no url tag"],
  ])("rejects %s (%s)", (body) => {
    expect(() => parseUploadResponse(body)).toThrow(UploadError);
  });

  it("ignores malformed tags rather than throwing on them", () => {
    const result = parseUploadResponse({
      nip94_event: {
        tags: [
          ["m"],
          "not-an-array",
          [],
          ["url", "https://media.example.com/y.jpg"],
        ],
      },
    });
    expect(result.url).toBe("https://media.example.com/y.jpg");
  });
});

describe("imetaTag", () => {
  it("emits the fields the host supplied, in order", () => {
    expect(
      imetaTag({
        url: "https://media.example.com/a.gif",
        mimeType: "image/gif",
        hash: "e".repeat(64),
        dimensions: "100x50",
      }),
    ).toEqual([
      "imeta",
      "url https://media.example.com/a.gif",
      "m image/gif",
      `x ${"e".repeat(64)}`,
      "dim 100x50",
    ]);
  });

  it("omits fields the host did not supply", () => {
    expect(imetaTag({ url: "https://media.example.com/a.gif" })).toEqual([
      "imeta",
      "url https://media.example.com/a.gif",
    ]);
  });
});
