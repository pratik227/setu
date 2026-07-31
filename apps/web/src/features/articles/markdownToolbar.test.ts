import { describe, expect, it } from "vitest";
import {
  applyToolbarAction,
  LINK_PLACEHOLDER,
  type TextSelection,
  type ToolbarAction,
} from "./markdownToolbar";

/**
 * A selection written as a string with the selected range in `«»`, so the
 * expectation reads like what the author sees rather than like arithmetic.
 */
function sel(marked: string): TextSelection {
  const start = marked.indexOf("«");
  if (start === -1) {
    const caret = marked.indexOf("|");
    const text = marked.replace("|", "");
    return { text, start: caret, end: caret };
  }
  const withoutOpen = marked.replace("«", "");
  const end = withoutOpen.indexOf("»");
  return { text: withoutOpen.replace("»", ""), start, end };
}

/** Inverse of `sel`, for assertions. */
function show(selection: TextSelection): string {
  const { text, start, end } = selection;
  if (start === end) {
    return `${text.slice(0, start)}|${text.slice(start)}`;
  }
  return `${text.slice(0, start)}«${text.slice(start, end)}»${text.slice(end)}`;
}

const apply = (marked: string, action: ToolbarAction): string =>
  show(applyToolbarAction(sel(marked), action));

describe("wrapping actions", () => {
  it("wraps a selection and keeps the selection on the author's words", () => {
    // Not on the markers: this is what lets bold-then-italic stack.
    expect(apply("make «this» bold", "bold")).toBe("make **«this»** bold");
    expect(apply("make «this» italic", "italic")).toBe("make *«this»* italic");
    expect(apply("make «this» struck", "strike")).toBe(
      "make ~~«this»~~ struck",
    );
  });

  it("puts the caret between the markers when nothing is selected", () => {
    // The whole point of the empty-selection case: the author keeps typing and
    // the text lands inside the emphasis.
    expect(apply("type here |", "bold")).toBe("type here **|**");
    expect(apply("type here |", "italic")).toBe("type here *|*");
  });

  it("unwraps a selection that already carries the markers", () => {
    // A toolbar that only ever adds markers turns a mis-click into `****text****`.
    expect(apply("make «**this**» plain", "bold")).toBe("make «this» plain");
  });

  it("unwraps when the markers sit just outside the selection", () => {
    expect(apply("make **«this»** plain", "bold")).toBe("make «this» plain");
  });

  it("stacks bold and italic around the same words", () => {
    const bolded = applyToolbarAction(sel("make «this» loud"), "bold");
    expect(show(applyToolbarAction(bolded, "italic"))).toBe(
      "make ***«this»*** loud",
    );
  });
});

describe("line-prefix actions", () => {
  it("quotes every line the selection touches", () => {
    // Prefixing only the first line leaves one quoted line and two orphans.
    expect(apply("«one\ntwo\nthree»", "quote")).toBe("«> one\n> two\n> three»");
  });

  it("quotes the caret's line when nothing is selected", () => {
    expect(apply("one\ntw|o\nthree", "quote")).toBe("one\n«> two»\nthree");
  });

  it("unquotes when every touched line is already quoted", () => {
    expect(apply("«> one\n> two»", "quote")).toBe("«one\ntwo»");
  });

  it("completes a partly quoted selection rather than half-unquoting it", () => {
    expect(apply("«> one\ntwo»", "quote")).toBe("«> > one\n> two»");
  });

  it("bullets every selected line", () => {
    expect(apply("«one\ntwo»", "list")).toBe("«- one\n- two»");
  });

  it("numbers an ordered list per line", () => {
    expect(apply("«one\ntwo\nthree»", "orderedList")).toBe(
      "«1. one\n2. two\n3. three»",
    );
  });

  it("leaves text outside the touched lines untouched", () => {
    expect(apply("before\n«middle»\nafter", "list")).toBe(
      "before\n«- middle»\nafter",
    );
  });
});

describe("heading", () => {
  it("cycles h2, h3, h1, then off", () => {
    // A single button covering the levels an article actually uses. `##` first
    // because the article's own title is the h1.
    let current = sel("|Title");
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      current = applyToolbarAction(current, "heading");
      seen.push(current.text);
    }
    expect(seen).toEqual(["## Title", "### Title", "# Title", "Title"]);
  });

  it("acts on the caret's line only", () => {
    expect(applyToolbarAction(sel("one\ntw|o\nthree"), "heading").text).toBe(
      "one\n## two\nthree",
    );
  });
});

describe("link", () => {
  it("selects the placeholder destination so typing replaces it", () => {
    expect(apply("see «the docs» now", "link")).toBe(
      `see [the docs](«${LINK_PLACEHOLDER}») now`,
    );
  });

  it("treats a selected URL as the destination, not the label", () => {
    // Selecting a URL and pressing link means "make this a link", so the caret
    // belongs where the words go.
    expect(apply("«https://example.com»", "link")).toBe(
      "[|](https://example.com)",
    );
  });

  it("inserts an empty link with the destination selected when nothing is chosen", () => {
    expect(apply("|", "link")).toBe(`[](«${LINK_PLACEHOLDER}»)`);
  });
});

describe("code", () => {
  it("uses a backtick span for a single-line selection", () => {
    expect(apply("call «fetch()» here", "code")).toBe("call `«fetch()»` here");
  });

  it("uses a fence for a multi-line selection", () => {
    // A backtick span containing a newline does not render as code at all.
    expect(apply("«const a = 1;\nconst b = 2;»", "code")).toBe(
      "```\n«const a = 1;\nconst b = 2;»\n```",
    );
  });

  it("fences the caret's line when nothing is selected", () => {
    expect(applyToolbarAction(sel("plain|"), "code").text).toBe(
      "```\nplain\n```",
    );
  });
});

describe("robustness", () => {
  it("normalizes a reversed selection", () => {
    // A drag-selection right to left hands over start > end.
    const reversed: TextSelection = {
      text: "make this bold",
      start: 9,
      end: 5,
    };
    expect(applyToolbarAction(reversed, "bold").text).toBe(
      "make **this** bold",
    );
  });

  it("clamps a selection that runs past the end of the text", () => {
    const out: TextSelection = { text: "short", start: 2, end: 900 };
    const result = applyToolbarAction(out, "bold");
    expect(result.text).toBe("sh**ort**");
    expect(result.end).toBeLessThanOrEqual(result.text.length);
  });

  it("handles an empty document", () => {
    expect(applyToolbarAction({ text: "", start: 0, end: 0 }, "bold")).toEqual({
      text: "****",
      start: 2,
      end: 2,
    });
  });

  it("never loses the author's text", () => {
    // The one invariant that matters: whatever the action, every word the author
    // typed is still in the result.
    const actions: readonly ToolbarAction[] = [
      "bold",
      "italic",
      "strike",
      "heading",
      "quote",
      "list",
      "orderedList",
      "link",
      "code",
    ];
    const source = "First line\nSecond line\nThird line";
    for (const action of actions) {
      for (const [start, end] of [
        [0, 0],
        [0, source.length],
        [6, 10],
        [11, 22],
        [source.length, source.length],
      ] as const) {
        const result = applyToolbarAction({ text: source, start, end }, action);
        for (const word of ["First", "Second", "Third"]) {
          expect(result.text, `${action} @ ${start}-${end}`).toContain(word);
        }
        expect(result.start).toBeGreaterThanOrEqual(0);
        expect(result.end).toBeLessThanOrEqual(result.text.length);
      }
    }
  });
});
