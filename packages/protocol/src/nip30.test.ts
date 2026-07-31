import { describe, expect, it } from "vitest";
import { emojiSegments, emojiTagMap, isSoleShortcode } from "./nip30";

const tags = (rows: readonly (readonly string[])[]) => ({ tags: rows });

describe("emojiTagMap", () => {
  it("maps shortcodes to their image URLs", () => {
    const map = emojiTagMap(
      tags([
        ["emoji", "soapbox", "https://x.test/soapbox.png"],
        ["emoji", "ostrich", "https://x.test/ostrich.gif"],
      ]),
    );
    expect(map.get("soapbox")).toBe("https://x.test/soapbox.png");
    expect(map.get("ostrich")).toBe("https://x.test/ostrich.gif");
  });

  it("keeps the first of two rows declaring one shortcode", () => {
    // Letting the later row win would make which image renders depend on tag
    // order, so the same note could show different emoji on two clients.
    const map = emojiTagMap(
      tags([
        ["emoji", "a", "https://x.test/first.png"],
        ["emoji", "a", "https://x.test/second.png"],
      ]),
    );
    expect(map.get("a")).toBe("https://x.test/first.png");
  });

  it("rejects a shortcode that no scanner could ever match", () => {
    // A code containing `:` or a space cannot appear as `:code:` in content, so an
    // entry for it is dead weight — and a `:` inside one would make the delimiters
    // ambiguous for every other code in the same note.
    const map = emojiTagMap(
      tags([
        ["emoji", "with:colon", "https://x.test/a.png"],
        ["emoji", "with space", "https://x.test/b.png"],
        ["emoji", "", "https://x.test/c.png"],
      ]),
    );
    expect(map.size).toBe(0);
  });

  it("skips a row with no URL", () => {
    expect(emojiTagMap(tags([["emoji", "a"]])).size).toBe(0);
    expect(emojiTagMap(tags([["emoji", "a", ""]])).size).toBe(0);
  });

  it("returns the URL exactly as published, unvalidated", () => {
    // Deliberate: the caller's image allowlist decides renderability. Two
    // allowlists in the codebase would eventually disagree.
    const map = emojiTagMap(tags([["emoji", "x", "javascript:alert(1)"]]));
    expect(map.get("x")).toBe("javascript:alert(1)");
  });
});

describe("emojiSegments", () => {
  const known = new Set(["soapbox", "ostrich"]);

  it("splits a known shortcode out of the surrounding text", () => {
    expect(emojiSegments("hi :soapbox: there", known)).toEqual([
      { type: "text", value: "hi " },
      { type: "emoji", value: ":soapbox:", shortcode: "soapbox" },
      { type: "text", value: " there" },
    ]);
  });

  it("leaves an unresolvable shortcode as literal text", () => {
    // The whole point of taking the known set as input: a `:word:` with no `emoji`
    // tag must render as the characters the author typed, never as a broken image.
    expect(emojiSegments("hi :nope: there", known)).toEqual([
      { type: "text", value: "hi :nope: there" },
    ]);
  });

  it("never loses or duplicates a character of the input", () => {
    const inputs = [
      "",
      "plain",
      ":soapbox:",
      ":soapbox::ostrich:",
      "a:b:c :soapbox: 12:30 :nope:",
      "::soapbox::",
      "trailing:",
      ":",
    ];
    for (const input of inputs) {
      const rebuilt = emojiSegments(input, known)
        .map((segment) => segment.value)
        .join("");
      expect(rebuilt).toBe(input);
    }
  });

  it("handles two shortcodes back to back", () => {
    expect(emojiSegments(":soapbox::ostrich:", known)).toEqual([
      { type: "emoji", value: ":soapbox:", shortcode: "soapbox" },
      { type: "emoji", value: ":ostrich:", shortcode: "ostrich" },
    ]);
  });

  it("does nothing when the event declared no emoji", () => {
    expect(emojiSegments(":soapbox:", new Set())).toEqual([
      { type: "text", value: ":soapbox:" },
    ]);
  });

  it("returns nothing for empty content", () => {
    expect(emojiSegments("", known)).toEqual([]);
  });
});

describe("isSoleShortcode", () => {
  const known = new Set(["soapbox"]);

  it("names the shortcode when the content is only that emoji", () => {
    expect(isSoleShortcode(":soapbox:", known)).toBe("soapbox");
    // A composer's trailing newline does not change what the reaction is.
    expect(isSoleShortcode("  :soapbox:\n", known)).toBe("soapbox");
  });

  it("is undefined for content that is more than the emoji", () => {
    expect(isSoleShortcode(":soapbox: nice", known)).toBeUndefined();
    expect(isSoleShortcode("+", known)).toBeUndefined();
    expect(isSoleShortcode(":unknown:", known)).toBeUndefined();
  });
});
