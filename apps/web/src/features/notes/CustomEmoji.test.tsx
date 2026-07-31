import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CustomEmoji, EmojiText } from "./CustomEmoji";

/**
 * Render-level proof, because the interesting failures are all in the markup.
 *
 * `nip30.test.ts` asserts the segmentation; this asserts what the reader's browser
 * receives — a correct segment list that renders a broken `<img>` is still a broken
 * image in the middle of a sentence.
 */
const render = (
  text: string,
  emoji: readonly (readonly [string, string])[],
): string =>
  renderToStaticMarkup(<EmojiText text={text} emoji={new Map(emoji)} />);

const SOAPBOX = ["soapbox", "https://x.test/soapbox.png"] as const;

describe("EmojiText", () => {
  it("renders a resolved shortcode as its image", () => {
    const html = render("hi :soapbox:", [SOAPBOX]);
    expect(html).toContain('src="https://x.test/soapbox.png"');
    // The literal shortcode is the alt text, so a reader who cannot load the image
    // sees exactly what a client with no custom-emoji support shows them.
    expect(html).toContain('alt=":soapbox:"');
  });

  it("leaves an unresolvable shortcode as literal text", () => {
    const html = render("hi :nope:", [SOAPBOX]);
    expect(html).not.toContain("<img");
    expect(html).toContain(":nope:");
  });

  it("refuses a URL the image allowlist rejects, and keeps the text", () => {
    // The exact position a `javascript:` or `data:image/svg+xml` payload wants to
    // occupy. Falling back to text means the note still reads correctly.
    for (const url of ["javascript:alert(1)", "data:image/svg+xml,<svg/>"]) {
      const html = render(":evil:", [["evil", url]]);
      expect(html).not.toContain("<img");
      expect(html).toContain(":evil:");
    }
  });

  it("allocates nothing when the note declared no emoji", () => {
    expect(render("plain :soapbox: text", [])).toBe("plain :soapbox: text");
  });

  it("sizes the glyph in em, so it tracks the text around it", () => {
    // A fixed pixel height overlaps the line above it at one text size and looks
    // like a typo at another.
    expect(render(":soapbox:", [SOAPBOX])).toContain("h-[1.25em]");
  });
});

describe("CustomEmoji", () => {
  it("falls back to the label rather than rendering a broken image", () => {
    expect(
      renderToStaticMarkup(
        <CustomEmoji url="ftp://x.test/a.png" label=":a:" />,
      ),
    ).toBe(":a:");
  });
});
