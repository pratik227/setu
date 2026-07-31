import { describe, expect, it } from "vitest";
import type { ContentToken, ContentTokenType } from "./content";
import { classifyUrl, imageUrls, tokenizeContent } from "./content";

const NPUB = "npub12w46vgpetgy6mcxsz9t8sg2mr4t976q2mmhh5hpctxy2f9z8av7qktfcnk";
const PUBKEY =
  "53aba620395a09ade0d0115678215b1d565f680adeef7a5c385988a49447eb3c";
const NOTE = "note1zxqg54rzmknju28uxvqa3dmnuh6jwtydt42h0gn8cxfqker059sqdqxghe";
const EVENT_ID =
  "11808a5462dda72e28fc3301d8b773e5f5272c8d5d5577a267c1920b646fa160";
const INVOICE =
  "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4js";
const LNURL =
  "lnurl1dp68gurn8ghj7ampd3kx2ar0veekzar0wd5xjtnrdakj7tnhv4kxctttdehhwm30d3h82unvwqhkxctdv5uq";
const CASHU =
  "cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vODMzMy5zcGFjZTozMzM4IiwicHJvb2ZzIjpbXX1dfQ";

interface Case {
  readonly name: string;
  readonly input: string;
  readonly types: readonly ContentTokenType[];
}

/**
 * Tricky inputs. Every one asserts two things: the round-trip property (the
 * concatenation of token values reproduces the input byte for byte) and the
 * exact token type sequence.
 */
const CASES: readonly Case[] = [
  { name: "empty string", input: "", types: [] },
  { name: "plain text", input: "just some text", types: ["text"] },
  {
    name: "hashtag adjacent to punctuation",
    input: "hello #nostr!",
    types: ["text", "hashtag", "text"],
  },
  {
    name: "hashtag at end of input",
    input: "ends with #tag",
    types: ["text", "hashtag"],
  },
  {
    name: "url containing a #fragment",
    input: "see https://example.com/docs#section for details",
    types: ["text", "url", "text"],
  },
  {
    name: "hashtag-looking fragment is part of the url",
    input: "https://example.com/#tag",
    types: ["url"],
  },
  {
    name: "hash after a slash without a scheme stays text",
    input: "example.com/#tag",
    types: ["text"],
  },
  {
    name: "fenced code block hiding a hashtag and a url",
    input: '```js\nconst u = "https://example.com/#hidden"; // #nope\n```',
    types: ["code"],
  },
  {
    name: "unterminated fence runs to end of input",
    input: "text ```js\nno close",
    types: ["text", "code"],
  },
  {
    name: "image url with a query string",
    input: "pic https://cdn.example.com/photo.jpg?w=600&h=400 nice",
    types: ["text", "image", "text"],
  },
  {
    name: "video url",
    input: "clip https://v.example.com/movie.mp4",
    types: ["text", "video"],
  },
  {
    name: "two images in a row",
    input: "https://a.example/1.jpg https://b.example/2.png",
    types: ["image", "text", "image"],
  },
  {
    name: "url followed by a comma",
    input: "look https://example.com/a.png, nice",
    types: ["text", "image", "text"],
  },
  {
    name: "url wrapped in parentheses",
    input: "check (https://example.com/a_b-c) done",
    types: ["text", "url", "text"],
  },
  {
    name: "url with balanced parentheses is kept whole",
    input: "https://en.wikipedia.org/wiki/Nostr_(protocol) rules",
    types: ["url", "text"],
  },
  {
    name: "nostr:npub mention mid-sentence",
    input: `hey nostr:${NPUB} how are you?`,
    types: ["text", "mention", "text"],
  },
  {
    name: "bare npub with trailing punctuation",
    input: `bare ${NPUB}!`,
    types: ["text", "mention", "text"],
  },
  {
    name: "bare note reference",
    input: `quote ${NOTE} end`,
    types: ["text", "mention", "text"],
  },
  {
    name: "malformed bech32 stays text",
    input: "nostr:npub1bad and npub1alsonotvalid",
    types: ["text"],
  },
  {
    name: "lightning invoice",
    input: `pay me ${INVOICE}`,
    types: ["text", "lnInvoice"],
  },
  { name: "lnurl", input: `tip ${LNURL}`, types: ["text", "lnurl"] },
  {
    name: "cashu token",
    input: `zap ${CASHU} thanks`,
    types: ["text", "cashu", "text"],
  },
  {
    name: "mixed newlines",
    input: "a\nb\r\nc\rd",
    types: ["text", "newline", "text", "newline", "text", "newline", "text"],
  },
  {
    name: "unicode hashtags",
    input: "#日本語 and #tag2",
    types: ["hashtag", "text", "hashtag"],
  },
  {
    name: "hashtag, image and newline together",
    input: "#nostr https://a.example/x.jpg\n#bitcoin",
    types: ["hashtag", "text", "image", "newline", "hashtag"],
  },
  {
    name: "identifier-like words are not entities",
    input: "npub bare, notanpub1xyz, my#tag, a@b.com",
    types: ["text"],
  },
];

describe("tokenizeContent round-trip property", () => {
  for (const { name, input } of CASES) {
    it(`preserves the input exactly: ${name}`, () => {
      const tokens = tokenizeContent(input);
      expect(tokens.map((t) => t.value).join("")).toBe(input);
    });
  }

  it("preserves a concatenation of every tricky case", () => {
    const input = CASES.map((c) => c.input).join("\n---\n");
    const tokens = tokenizeContent(input);
    expect(tokens.map((t) => t.value).join("")).toBe(input);
  });

  it("never emits an empty-valued or adjacent-text token", () => {
    for (const { input } of CASES) {
      const tokens = tokenizeContent(input);
      for (const [index, token] of tokens.entries()) {
        expect(token.value.length).toBeGreaterThan(0);
        if (token.type === "text") {
          expect(tokens[index + 1]?.type).not.toBe("text");
        }
      }
    }
  });
});

describe("tokenizeContent token types", () => {
  for (const { name, input, types } of CASES) {
    it(`classifies: ${name}`, () => {
      expect(tokenizeContent(input).map((t) => t.type)).toEqual(types);
    });
  }
});

describe("tokenizeContent token payloads", () => {
  function only<T extends ContentTokenType>(
    input: string,
    type: T,
  ): Extract<ContentToken, { type: T }> {
    const token = tokenizeContent(input).find((t) => t.type === type);
    expect(token, `expected a ${type} token in ${input}`).toBeDefined();
    return token as Extract<ContentToken, { type: T }>;
  }

  it("strips the # from hashtags", () => {
    const token = only("hello #nostr!", "hashtag");
    expect(token.value).toBe("#nostr");
    expect(token.tag).toBe("nostr");
  });

  it("keeps the query string in an image url", () => {
    const token = only(
      "pic https://cdn.example.com/photo.jpg?w=600&h=400 nice",
      "image",
    );
    expect(token.url).toBe("https://cdn.example.com/photo.jpg?w=600&h=400");
    expect(token.value).toBe(token.url);
  });

  it("decodes a nostr:npub mention to a pubkey", () => {
    const token = only(`hey nostr:${NPUB} how are you?`, "mention");
    expect(token.value).toBe(`nostr:${NPUB}`);
    expect(token.entity).toEqual({ type: "npub", pubkey: PUBKEY });
  });

  it("decodes a bare note reference to an event id", () => {
    const token = only(`quote ${NOTE} end`, "mention");
    expect(token.entity).toEqual({ type: "note", id: EVENT_ID });
  });

  it("never turns an nsec into a mention", () => {
    const nsec =
      "nsec12snwfk7a5qwa2ncdtvw35r5aknyt858952clf37eazntt3xnutcs7rnylr";
    const tokens = tokenizeContent(`oops nostr:${nsec} leaked`);
    expect(tokens.map((t) => t.type)).toEqual(["text"]);
  });

  it("exposes fenced code with its language", () => {
    const token = only(
      '```js\nconst u = "https://example.com/#hidden"; // #nope\n```',
      "code",
    );
    expect(token.lang).toBe("js");
    expect(token.code).toBe(
      'const u = "https://example.com/#hidden"; // #nope\n',
    );
  });

  it("leaves the language undefined for a bare fence", () => {
    const token = only("```\nplain\n```", "code");
    expect(token.lang).toBeUndefined();
    expect(token.code).toBe("plain\n");
  });

  it("treats a first line with spaces as code, not a language", () => {
    const token = only("```\nhello world #tag\n```", "code");
    expect(token.lang).toBeUndefined();
    expect(token.code).toContain("#tag");
  });

  it("carries the raw invoice, lnurl and cashu payloads", () => {
    expect(only(`pay me ${INVOICE}`, "lnInvoice").invoice).toBe(INVOICE);
    expect(only(`tip ${LNURL}`, "lnurl").lnurl).toBe(LNURL);
    expect(only(`zap ${CASHU} thanks`, "cashu").token).toBe(CASHU);
  });

  it("keeps the newline character in newline tokens", () => {
    const tokens = tokenizeContent("a\r\nb");
    expect(tokens[1]).toEqual({ type: "newline", value: "\r\n" });
  });
});

describe("tokenizeContent legacy #[n] mentions", () => {
  const tags = [
    ["p", PUBKEY],
    ["e", EVENT_ID],
  ] as const;

  it("resolves a positional mention against the event tags", () => {
    const tokens = tokenizeContent("hi #[0] and #[1]", tags);
    expect(tokens.map((t) => t.type)).toEqual([
      "text",
      "mention",
      "text",
      "mention",
    ]);
    expect(tokens.map((t) => t.value).join("")).toBe("hi #[0] and #[1]");
    expect(tokens[1]).toEqual({
      type: "mention",
      value: "#[0]",
      entity: { type: "npub", pubkey: PUBKEY },
    });
    expect(tokens[3]).toEqual({
      type: "mention",
      value: "#[1]",
      entity: { type: "note", id: EVENT_ID },
    });
  });

  it("leaves the marker as text when tags are absent", () => {
    const tokens = tokenizeContent("hi #[0]");
    expect(tokens.map((t) => t.type)).toEqual(["text"]);
    expect(tokens.map((t) => t.value).join("")).toBe("hi #[0]");
  });

  it("leaves the marker as text when the index is out of range", () => {
    const tokens = tokenizeContent("hi #[9]", tags);
    expect(tokens.map((t) => t.type)).toEqual(["text"]);
  });
});

describe("classifyUrl", () => {
  it("classifies by path extension, ignoring query and fragment", () => {
    expect(classifyUrl("https://x.example/a.JPG")).toBe("image");
    expect(classifyUrl("https://x.example/a.jpeg?v=2")).toBe("image");
    expect(classifyUrl("https://x.example/a.svg#frag")).toBe("image");
    expect(classifyUrl("https://x.example/a.webm")).toBe("video");
    expect(classifyUrl("https://x.example/a.mov?t=1")).toBe("video");
    expect(classifyUrl("https://x.example/a.pdf")).toBe("url");
    expect(classifyUrl("https://x.example/")).toBe("url");
    expect(classifyUrl("https://x.example.com")).toBe("url");
    expect(classifyUrl("https://x.example/jpg")).toBe("url");
  });
});

describe("imageUrls", () => {
  it("collects image urls in order", () => {
    const tokens = tokenizeContent(
      "a https://a.example/1.jpg b https://b.example/2.mp4 c https://c.example/3.png",
    );
    expect(imageUrls(tokens)).toEqual([
      "https://a.example/1.jpg",
      "https://c.example/3.png",
    ]);
  });
});
