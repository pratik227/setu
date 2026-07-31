import { describe, expect, it } from "vitest";
import {
  inlineText,
  type MarkdownBlock,
  type MarkdownInline,
  markdownToPlainText,
  parseMarkdown,
} from "./markdown";
import { isExternalHref, sanitizeImageUrl, sanitizeUrl } from "./markdownUrl";
import {
  hasUnbreakableRun,
  UNBREAKABLE_RUN_THRESHOLD,
  wrapClass,
} from "./markdownWrap";

/** Every inline node in the tree, flattened, for structural assertions. */
function allInline(
  blocks: readonly MarkdownBlock[],
): readonly MarkdownInline[] {
  const out: MarkdownInline[] = [];
  const walkInline = (nodes: readonly MarkdownInline[]): void => {
    for (const node of nodes) {
      out.push(node);
      if (node.type === "strong" || node.type === "em")
        walkInline(node.children);
      else if (node.type === "strike" || node.type === "link") {
        walkInline(node.children);
      }
    }
  };
  const walk = (list: readonly MarkdownBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "heading":
        case "paragraph":
          walkInline(block.children);
          break;
        case "quote":
          walk(block.blocks);
          break;
        case "list":
          for (const item of block.list.items) {
            walkInline(item.children);
            if (item.sublist) {
              for (const sub of item.sublist.items) walkInline(sub.children);
            }
          }
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  return out;
}

const text = (blocks: readonly MarkdownBlock[]): string =>
  allInline(blocks)
    .filter((n) => n.type === "text")
    .map((n) => (n.type === "text" ? n.value : ""))
    .join("");

describe("parseMarkdown — block types", () => {
  it("parses ATX headings at every level", () => {
    for (let level = 1; level <= 6; level++) {
      const blocks = parseMarkdown(`${"#".repeat(level)} Title`);
      expect(blocks).toEqual([
        {
          type: "heading",
          level,
          children: [{ type: "text", value: "Title" }],
        },
      ]);
    }
  });

  it("does not treat a bare hashtag line as a heading", () => {
    // `#nostr` on its own line is a topic, not an `<h1>`. Requiring the space is
    // what keeps a hashtag from silently becoming a headline.
    const blocks = parseMarkdown("#nostr");
    expect(blocks[0]?.type).toBe("paragraph");
    expect(text(blocks)).toBe("#nostr");
  });

  it("strips a closing hash sequence from a heading", () => {
    expect(parseMarkdown("## Title ##")[0]).toEqual({
      type: "heading",
      level: 2,
      children: [{ type: "text", value: "Title" }],
    });
  });

  it("joins wrapped lines into one paragraph and splits on a blank line", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "one two" }],
    });
    expect(text([blocks[1] as MarkdownBlock])).toBe("three");
  });

  it("treats two trailing spaces as an explicit break", () => {
    const blocks = parseMarkdown("one  \ntwo");
    const kinds = allInline(blocks).map((n) => n.type);
    expect(kinds).toContain("break");
  });

  it("parses a horizontal rule in each spelling", () => {
    for (const rule of ["---", "***", "___", "- - -", "* * * *"]) {
      expect(parseMarkdown(rule)).toEqual([{ type: "rule" }]);
    }
  });

  it("parses a blockquote and the blocks inside it", () => {
    const blocks = parseMarkdown("> quoted **words**\n> still quoted");
    expect(blocks).toHaveLength(1);
    const quote = blocks[0];
    if (quote?.type !== "quote") throw new Error("expected a quote");
    expect(quote.blocks[0]?.type).toBe("paragraph");
    expect(text(blocks)).toBe("quoted words still quoted");
  });

  it("parses an unordered list", () => {
    const blocks = parseMarkdown("- one\n- two\n- three");
    const block = blocks[0];
    if (block?.type !== "list") throw new Error("expected a list");
    expect(block.list.ordered).toBe(false);
    expect(block.list.items).toHaveLength(3);
    expect(inlineText(block.list.items[1]?.children ?? [])).toBe("two");
  });

  it("parses an ordered list and keeps its starting number", () => {
    const blocks = parseMarkdown("5. five\n6. six");
    const block = blocks[0];
    if (block?.type !== "list") throw new Error("expected a list");
    expect(block.list.ordered).toBe(true);
    expect(block.list.start).toBe(5);
    expect(block.list.items).toHaveLength(2);
  });

  it("nests one level of list", () => {
    const blocks = parseMarkdown("- outer\n  - inner\n  - inner two\n- second");
    const block = blocks[0];
    if (block?.type !== "list") throw new Error("expected a list");
    expect(block.list.items).toHaveLength(2);
    expect(block.list.items[0]?.sublist?.items).toHaveLength(2);
    expect(block.list.items[1]?.sublist).toBeUndefined();
  });

  it("parses a fenced code block with a language label", () => {
    const blocks = parseMarkdown("```ts\nconst x = 1;\n```");
    expect(blocks).toEqual([
      { type: "codeBlock", language: "ts", value: "const x = 1;" },
    ]);
  });

  it("parses a fence with no language and tilde fences too", () => {
    expect(parseMarkdown("```\nplain\n```")[0]).toEqual({
      type: "codeBlock",
      value: "plain",
    });
    expect(parseMarkdown("~~~\nplain\n~~~")[0]).toEqual({
      type: "codeBlock",
      value: "plain",
    });
  });

  it("keeps markup inside a fence as literal code", () => {
    // The whole point of a fence: its interior is never re-scanned. A `#` in
    // there is a comment or a shell prompt, and `[link](x)` is sample code.
    const source = [
      "```sh",
      "# not a heading",
      "[link](https://example.com) is not a link",
      "**not bold**",
      "```",
      "",
      "after",
    ].join("\n");
    const blocks = parseMarkdown(source);
    const code = blocks[0];
    if (code?.type !== "codeBlock") throw new Error("expected a code block");
    expect(code.value).toContain("# not a heading");
    expect(code.value).toContain("[link](https://example.com)");
    expect(code.value).toContain("**not bold**");
    // Nothing inside the fence became markup anywhere in the document.
    expect(allInline(blocks).some((n) => n.type === "link")).toBe(false);
    expect(allInline(blocks).some((n) => n.type === "strong")).toBe(false);
    expect(blocks.some((b) => b.type === "heading")).toBe(false);
    expect(text(blocks)).toBe("after");
  });

  it("runs an unclosed fence to the end of the document", () => {
    // Discarding it would let one missing backtick delete the rest of an article.
    const blocks = parseMarkdown("```js\nconst a = 1;\nconst b = 2;");
    expect(blocks).toEqual([
      {
        type: "codeBlock",
        language: "js",
        value: "const a = 1;\nconst b = 2;",
      },
    ]);
  });

  it("keeps a code span opaque", () => {
    const blocks = parseMarkdown("use `**not bold**` here");
    const inline = allInline(blocks);
    expect(inline).toContainEqual({ type: "code", value: "**not bold**" });
    expect(inline.some((n) => n.type === "strong")).toBe(false);
  });
});

describe("parseMarkdown — emphasis", () => {
  it("parses bold, italic, and strikethrough", () => {
    expect(allInline(parseMarkdown("**b**")).map((n) => n.type)).toEqual([
      "strong",
      "text",
    ]);
    expect(allInline(parseMarkdown("*i*")).map((n) => n.type)).toEqual([
      "em",
      "text",
    ]);
    expect(allInline(parseMarkdown("~~s~~")).map((n) => n.type)).toEqual([
      "strike",
      "text",
    ]);
  });

  it("nests emphasis inside emphasis", () => {
    const blocks = parseMarkdown("**bold with _italic_ inside**");
    const [strong] = allInline(blocks);
    if (strong?.type !== "strong") throw new Error("expected strong");
    expect(strong.children.some((n) => n.type === "em")).toBe(true);
    expect(inlineText(strong.children)).toBe("bold with italic inside");
  });

  it("treats *** as bold wrapping italic", () => {
    const [strong] = allInline(parseMarkdown("***both***"));
    if (strong?.type !== "strong") throw new Error("expected strong");
    expect(strong.children[0]?.type).toBe("em");
  });

  it("leaves underscores inside a word alone", () => {
    // `snake_case_name` is an identifier. Emphasizing its middle is the classic
    // Markdown-in-a-technical-article failure.
    const blocks = parseMarkdown("call snake_case_name now");
    expect(allInline(blocks).some((n) => n.type === "em")).toBe(false);
    expect(text(blocks)).toBe("call snake_case_name now");
  });

  it("leaves an unclosed delimiter as literal text", () => {
    expect(text(parseMarkdown("2 * 3 * 4 is math"))).toBe("2 * 3 * 4 is math");
    expect(text(parseMarkdown("**unclosed"))).toBe("**unclosed");
  });

  it("honours backslash escapes", () => {
    expect(text(parseMarkdown("\\*not italic\\*"))).toBe("*not italic*");
  });
});

describe("parseMarkdown — links and images", () => {
  it("parses a link and keeps its label markup", () => {
    const [link] = allInline(
      parseMarkdown("[**site**](https://example.com/a)"),
    );
    if (link?.type !== "link") throw new Error("expected a link");
    expect(link.href).toBe("https://example.com/a");
    expect(inlineText(link.children)).toBe("site");
  });

  it("drops a link title without dropping the link", () => {
    const [link] = allInline(
      parseMarkdown('[site](https://example.com "a title")'),
    );
    if (link?.type !== "link") throw new Error("expected a link");
    expect(link.href).toBe("https://example.com");
  });

  it("accepts mailto: and nostr: destinations", () => {
    const mail = allInline(parseMarkdown("[mail](mailto:a@example.com)"))[0];
    expect(mail?.type === "link" && mail.href).toBe("mailto:a@example.com");
    const nostr = allInline(parseMarkdown("[who](nostr:npub1abc)"))[0];
    expect(nostr?.type === "link" && nostr.href).toBe("nostr:npub1abc");
  });

  it("parses an image with an empty alt", () => {
    // `![](url)` is the decorative-image spelling and must not be mistaken for
    // malformed input: it parses, and the empty alt is preserved verbatim so the
    // rendered `alt=""` tells a screen reader to skip it.
    const [image] = allInline(parseMarkdown("![](https://example.com/a.png)"));
    expect(image).toEqual({
      type: "image",
      src: "https://example.com/a.png",
      alt: "",
    });
  });

  it("parses an image with alt text", () => {
    const [image] = allInline(
      parseMarkdown("![a cat](https://example.com/cat.png)"),
    );
    expect(image).toEqual({
      type: "image",
      src: "https://example.com/cat.png",
      alt: "a cat",
    });
  });

  it("does not nest a link inside a link", () => {
    const [outer] = allInline(
      parseMarkdown("[a [b](https://b.example) c](https://a.example)"),
    );
    if (outer?.type !== "link") throw new Error("expected a link");
    expect(outer.children.some((n) => n.type === "link")).toBe(false);
  });
});

describe("URL rejection", () => {
  const REJECTED = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\u0000script:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "blob:https://example.com/x",
    "file:///etc/passwd",
    "about:blank",
    "filesystem:https://example.com/x",
    "/relative/path",
    "relative.md",
    "#anchor",
    "",
    "   ",
  ];

  it.each(REJECTED)("rejects %j as a link destination", (raw) => {
    expect(sanitizeUrl(raw)).toBeUndefined();
  });

  it.each([
    "http://a.example",
    "https://a.example/p?q=1#f",
    "mailto:a@b.c",
    "nostr:npub1abc",
  ])("accepts %j as a link destination", (raw) => {
    expect(sanitizeUrl(raw)).toBe(raw);
  });

  it("renders a javascript: link as inert text, keeping the label", () => {
    const blocks = parseMarkdown("[click me](javascript:alert(1))");
    const inline = allInline(blocks);
    // No link node exists at all, so there is no `href` for the renderer to emit.
    expect(inline.some((n) => n.type === "link")).toBe(false);
    expect(text(blocks)).toBe("click me");
    expect(JSON.stringify(blocks)).not.toContain("javascript");
  });

  it("renders a data: image as its alt text and never as an image node", () => {
    const blocks = parseMarkdown(
      "![payload](data:image/svg+xml,<svg onload=alert(1)>)",
    );
    expect(allInline(blocks).some((n) => n.type === "image")).toBe(false);
    expect(text(blocks)).toBe("payload");
    expect(JSON.stringify(blocks)).not.toContain("data:");
  });

  it("holds images to a narrower allowlist than links", () => {
    // A `nostr:` or `mailto:` image source is meaningless; a `data:` one is a
    // script host wearing a MIME type.
    expect(sanitizeImageUrl("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(sanitizeImageUrl("nostr:npub1abc")).toBeUndefined();
    expect(sanitizeImageUrl("mailto:a@b.c")).toBeUndefined();
    expect(sanitizeImageUrl("data:image/png;base64,AAAA")).toBeUndefined();
  });

  it("resolves a scheme-relative URL rather than inheriting silently", () => {
    expect(sanitizeUrl("//example.com/a")).toBe("https://example.com/a");
  });

  it("rejects a URL long enough to be a payload rather than an address", () => {
    expect(
      sanitizeUrl(`https://example.com/${"a".repeat(5000)}`),
    ).toBeUndefined();
  });

  it("marks only http(s) as external, so rel hardening lands where it matters", () => {
    expect(isExternalHref("https://a.example")).toBe(true);
    expect(isExternalHref("http://a.example")).toBe(true);
    expect(isExternalHref("mailto:a@b.c")).toBe(false);
    expect(isExternalHref("nostr:npub1abc")).toBe(false);
  });

  it("does not interpret raw HTML in the source", () => {
    const blocks = parseMarkdown('<img src=x onerror="alert(1)"> <b>hi</b>');
    expect(text(blocks)).toContain("<img src=x");
    expect(text(blocks)).toContain("<b>hi</b>");
  });
});

describe("long unbroken runs", () => {
  const LONG = "a".repeat(400);

  it("detects a run long enough to overflow its container", () => {
    expect(hasUnbreakableRun(LONG)).toBe(true);
    expect(hasUnbreakableRun("ordinary prose with normal words")).toBe(false);
    expect(hasUnbreakableRun("x".repeat(UNBREAKABLE_RUN_THRESHOLD))).toBe(
      false,
    );
    expect(hasUnbreakableRun("x".repeat(UNBREAKABLE_RUN_THRESHOLD + 1))).toBe(
      true,
    );
  });

  it("applies the force-break wrapping class to such a run", () => {
    // `break-words` alone will not break a token this long out of a flex child,
    // and the result is a horizontal scrollbar on the whole article.
    expect(wrapClass(LONG)).toContain("break-all");
    expect(wrapClass(LONG)).toContain("break-words");
  });

  it("leaves ordinary prose on break-words only", () => {
    expect(wrapClass("ordinary prose")).toBe("break-words");
  });

  it("parses a paragraph of one very long token without altering it", () => {
    const blocks = parseMarkdown(LONG);
    expect(text(blocks)).toBe(LONG);
  });
});

describe("malformed and empty input", () => {
  const CASES: readonly string[] = [
    "",
    " ",
    "\n\n\n",
    "\r\n\r\n",
    "[",
    "[]",
    "[](",
    "[]()",
    "![",
    "![](",
    "*",
    "**",
    "***",
    "~~",
    "`",
    "```",
    ">",
    ">>>>>>>>>>",
    "-",
    "- ",
    "1.",
    "#",
    "######",
    "#######",
    "[a](",
    "[a](b",
    "](a)",
    "**[*`~_",
  ];

  it.each(CASES)("does not throw on %j", (source) => {
    expect(() => parseMarkdown(source)).not.toThrow();
  });

  it("returns no blocks for empty or whitespace-only input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n \t\n")).toEqual([]);
  });

  it("tolerates a non-string body", () => {
    // Event content is `string` by type, but a hand-built event or a corrupt
    // cache entry is not, and the reader must degrade rather than crash.
    expect(parseMarkdown(undefined as unknown as string)).toEqual([]);
    expect(parseMarkdown(null as unknown as string)).toEqual([]);
  });

  it("truncates rather than parsing an absurdly long body", () => {
    const blocks = parseMarkdown("x".repeat(600_000));
    expect(blocks).toHaveLength(1);
    expect(text(blocks).length).toBeLessThanOrEqual(400_000);
  });

  it("does not recurse without bound on deeply nested quotes", () => {
    expect(() => parseMarkdown(`${">".repeat(500)} deep`)).not.toThrow();
  });
});

describe("markdownToPlainText", () => {
  it("derives an excerpt from the rendered tree, not from regex stripping", () => {
    const source = [
      "# A Heading",
      "",
      "Some **bold** prose with a [link](https://example.com).",
      "",
      "```js",
      "const secret = 1;",
      "```",
    ].join("\n");
    const plain = markdownToPlainText(source);
    expect(plain).toBe("A Heading Some bold prose with a link.");
    // Code is excluded: a code-heavy article's excerpt should be its prose.
    expect(plain).not.toContain("const secret");
  });

  it("returns an empty string for an empty body", () => {
    expect(markdownToPlainText("")).toBe("");
  });

  it("caps the excerpt length", () => {
    expect(markdownToPlainText("word ".repeat(500), 80)).toHaveLength(80);
  });
});
