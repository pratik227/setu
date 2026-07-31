import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type QuoteReference, useRenderedBody } from "./noteBody";

/**
 * Render-level proof that the tags actually reach the renderer.
 *
 * Both regressions this locks were invisible in unit tests of the tokenizer, which
 * has always handled `#[n]` correctly: the bug was that the feed and thread rows
 * never passed `tags`, so the renderer had nothing to resolve against. Asserting on
 * the markup is the only place that gap shows up.
 */
const NOTE_A = "1".repeat(64);
const NOTE_B = "2".repeat(64);
const ALICE = "a".repeat(64);

/** Stand-in for `QuoteCard`, so this test needs no engine or relay. */
function stubQuote(reference: QuoteReference): React.ReactNode {
  return <span data-quote={reference.id} />;
}

function Body({
  content,
  tags,
  quotes = true,
}: {
  content: string;
  tags?: readonly (readonly string[])[];
  quotes?: boolean;
}) {
  const { body } = useRenderedBody({
    content,
    ...(tags ? { tags } : {}),
    ...(quotes ? { renderQuote: stubQuote } : {}),
  });
  return <>{body}</>;
}

const render = (props: React.ComponentProps<typeof Body>): string =>
  renderToStaticMarkup(<Body {...props} />);

describe("deprecated NIP-08 positional mentions", () => {
  it("resolves #[n] against the event's tags", () => {
    const html = render({
      content: "hey #[0] look",
      tags: [["p", ALICE]],
    });
    // The literal characters are the bug; a mention button is the fix.
    expect(html).not.toContain("#[0]");
    expect(html).toContain("<button");
  });

  it("still renders the literal text when there are no tags to resolve against", () => {
    // Not a regression — it is the only honest option. An index with no tag behind
    // it names nobody, and inventing a mention would attribute the note to someone.
    expect(render({ content: "hey #[0]" })).toContain("#[0]");
  });

  it("leaves an index past the end of the tag list alone", () => {
    expect(render({ content: "hey #[9]", tags: [["p", ALICE]] })).toContain(
      "#[9]",
    );
  });
});

describe("q-tag quote reposts", () => {
  it("renders a quote whose reference exists only as a q tag", () => {
    // The invisible-quote bug: plenty of clients write the tag and leave the
    // content as plain commentary, so a renderer that only walks inline references
    // shows a remark about a note the reader is never shown.
    const html = render({
      content: "this is worth reading",
      tags: [["q", NOTE_A]],
    });
    expect(html).toContain(`data-quote="${NOTE_A}"`);
  });

  it("does not render the same quote twice when both signals are present", () => {
    // NIP-18 says a quote repost carries the inline reference *and* the tag.
    const html = render({
      content: `look nostr:${"note1"}`,
      tags: [["q", NOTE_A]],
    });
    // The bech32 above is deliberately unparseable, so only the tag path can fire.
    expect(html.match(/data-quote/g)?.length ?? 0).toBe(1);
  });

  it("caps how many tag-only quotes one note may expand", () => {
    // The tag list is author-controlled and unbounded; without a cap one note
    // becomes a page-long wall of cards, each fetching an event.
    const html = render({
      content: "many",
      tags: [
        ["q", NOTE_A],
        ["q", NOTE_B],
        ["q", "3".repeat(64)],
        ["q", "4".repeat(64)],
      ],
    });
    expect(html.match(/data-quote/g)?.length ?? 0).toBe(2);
  });

  it("ignores a q value that is not an event id", () => {
    // It would become an id in a relay filter, and a malformed id is one some
    // relays reject outright.
    expect(render({ content: "x", tags: [["q", "nonsense"]] })).not.toContain(
      "data-quote",
    );
  });

  it("renders no quote at all when the surface supplied no renderer", () => {
    expect(
      render({ content: "x", tags: [["q", NOTE_A]], quotes: false }),
    ).not.toContain("data-quote");
  });
});

describe("custom emoji in a body", () => {
  it("substitutes a shortcode declared by the same event", () => {
    const html = render({
      content: "nice :soapbox:",
      tags: [["emoji", "soapbox", "https://x.test/soapbox.png"]],
    });
    expect(html).toContain('src="https://x.test/soapbox.png"');
  });

  it("leaves a shortcode inside a code fence alone", () => {
    // The tokenizer has already claimed the fence, which is why substitution runs
    // per text token rather than over the whole string.
    const html = render({
      content: "```\n:soapbox:\n```",
      tags: [["emoji", "soapbox", "https://x.test/soapbox.png"]],
    });
    expect(html).not.toContain("<img");
    expect(html).toContain(":soapbox:");
  });
});
