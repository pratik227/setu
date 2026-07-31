import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./MarkdownView";

/**
 * Render-level proof, not just AST-level.
 *
 * The parser tests assert that an unsafe destination never becomes a node. These
 * assert the stronger, end-to-end property: for a body written specifically to
 * inject markup, the HTML the reader's browser receives contains no script, no
 * event handler attribute, and no dangerous scheme. `renderToStaticMarkup` gives
 * exactly the string React would commit to the DOM, so the assertion is about
 * output rather than about intent.
 */
const render = (source: string): string =>
  renderToStaticMarkup(<Markdown source={source} />);

describe("Markdown rendering — injection", () => {
  const HOSTILE = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "<svg/onload=alert(1)>",
    "[x](javascript:alert(1))",
    "[x](JAVASCRIPT:alert(1))",
    "[x](vbscript:msgbox(1))",
    "![x](data:image/svg+xml,<svg onload=alert(1)>)",
    "![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    '<a href="javascript:alert(1)">x</a>',
    "<iframe src=https://evil.example></iframe>",
    "[x](  javascript:alert(1))",
  ];

  /** Any `on*=` sitting in attribute position inside a tag. */
  const EVENT_HANDLER_ATTRIBUTE = /<[a-z][^>]*\son[a-z]+\s*=/i;
  /** A dangerous scheme in an attribute that navigates or loads. */
  const DANGEROUS_ATTRIBUTE =
    /(?:href|src|srcset|action|formaction)\s*=\s*"\s*(?:javascript|data|vbscript|blob|file|about|filesystem):/i;

  it.each(HOSTILE)("renders %j without executable output", (source) => {
    const html = render(source);
    // No tag the author asked for was created. `&lt;script` in the output is
    // prose; `<script` would be markup, and only one of those can happen.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<svg");
    // Asserting on attribute *position* rather than on the substring: a body
    // that discusses `onerror=` in prose is legitimate and must still render,
    // so the property is "never an attribute", not "never these characters".
    expect(html).not.toMatch(EVENT_HANDLER_ATTRIBUTE);
    expect(html).not.toMatch(DANGEROUS_ATTRIBUTE);
  });

  it("escapes literal HTML into text rather than dropping it", () => {
    // Silently deleting it would lose the author's words; interpreting it would
    // lose the reader's safety. Escaping keeps both.
    const html = render("<b>bold?</b>");
    expect(html).toContain("&lt;b&gt;bold?&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("hardens external links and leaves protocol links alone", () => {
    const external = render("[a](https://example.com)");
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noopener noreferrer nofollow"');

    const protocolHandled = render("[a](nostr:npub1abc)");
    expect(protocolHandled).toContain('href="nostr:npub1abc"');
    expect(protocolHandled).not.toContain('target="_blank"');
  });

  it("keeps a rejected link's words while emitting no anchor for it", () => {
    const html = render("before [click me](javascript:alert(1)) after");
    expect(html).toContain("click me");
    expect(html).not.toContain("<a ");
  });

  it("renders an empty alt as an empty alt, not as a missing one", () => {
    const html = render("![](https://example.com/a.png)");
    expect(html).toContain('alt=""');
  });
});

describe("Markdown rendering — layout", () => {
  it("applies the force-break class to a very long unbroken string", () => {
    // Without this a 400-character token widens the article and the whole page
    // gets a horizontal scrollbar.
    const html = render("a".repeat(400));
    expect(html).toContain("break-all");
  });

  it("does not apply the force-break class to ordinary prose", () => {
    const html = render("An ordinary sentence of prose, wrapping normally.");
    expect(html).toContain("break-words");
    expect(html).not.toContain("break-all");
  });

  it("gives a code block its own scroll container", () => {
    const html = render(`\`\`\`\n${"x".repeat(300)}\n\`\`\``);
    expect(html).toContain("overflow-x-auto");
  });

  it("renders every supported block type", () => {
    const html = render(
      [
        "# H1",
        "",
        "Prose with **bold**, *italic*, ~~struck~~ and `code`.",
        "",
        "> quoted",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "",
        "---",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "![alt](https://example.com/a.png)",
        "",
        "[link](https://example.com)",
      ].join("\n"),
    );
    for (const tag of [
      "<h1",
      "<p",
      "<strong",
      "<em",
      "<s ",
      "<code",
      "<blockquote",
      "<ul",
      "<ol",
      "<hr",
      "<pre",
      "<img",
      "<a ",
    ]) {
      expect(html, `expected ${tag} in output`).toContain(tag);
    }
  });

  it("renders nothing for an empty body", () => {
    expect(render("")).toBe(
      '<div class="text-lg leading-relaxed text-foreground"></div>',
    );
  });
});
