/**
 * Markdown insertions, as a pure function of text and selection.
 *
 * The reason this is a module and not a handful of `setState` calls inside the
 * editor: **the caret is the thing a hand-rolled editor gets wrong.** Setting a
 * textarea's value from React drops the selection, so the naive toolbar button
 * appends its markers and dumps the caret at the end of the document. After two
 * clicks the author stops using the toolbar. Restoring the selection requires
 * knowing exactly where it should land, which means every action has to *return*
 * a selection rather than mutate a DOM node and hope.
 *
 * Keeping that arithmetic here, away from React, is also the only way it can be
 * tested — and off-by-one errors in caret math are invisible in review and
 * obvious in use.
 */

export type ToolbarAction =
  | "bold"
  | "italic"
  | "strike"
  | "heading"
  | "quote"
  | "list"
  | "orderedList"
  | "link"
  | "code";

/** A textarea's value and selection. The unit this module transforms. */
export interface TextSelection {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Placeholder used when an action needs a target and the selection is empty. */
export const LINK_PLACEHOLDER = "https://";

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/** Normalize a possibly reversed or out-of-range selection. */
function normalize(selection: TextSelection): TextSelection {
  const text = typeof selection.text === "string" ? selection.text : "";
  const a = clamp(selection.start, text.length);
  const b = clamp(selection.end, text.length);
  return { text, start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * Wrap the selection in `marker`, or unwrap it when it is already wrapped.
 *
 * Toggling matters more than it sounds: a bold button that only ever adds
 * markers turns a mis-click into `****text****`, which renders as literal
 * asterisks and has to be repaired by hand.
 */
function wrap(selection: TextSelection, marker: string): TextSelection {
  const { text, start, end } = selection;
  const selected = text.slice(start, end);

  if (selected === "") {
    // Empty selection: insert the pair and put the caret between the markers, so
    // the author simply keeps typing.
    const inserted = `${marker}${marker}`;
    const caret = start + marker.length;
    return {
      text: `${text.slice(0, start)}${inserted}${text.slice(end)}`,
      start: caret,
      end: caret,
    };
  }

  // Every marker is a run of one character, and the runs adjacent to the
  // selection must match the marker *exactly* — not merely start with it. Taking
  // one `*` off each side of `**bold**` because the italic marker is `*` turns
  // bold into italic and looks, from the code, like a correct unwrap.
  const ch = marker[0] as string;
  const runBackward = (from: number): number => {
    let n = 0;
    while (from - n > 0 && text[from - n - 1] === ch) n++;
    return n;
  };
  const runForward = (from: number): number => {
    let n = 0;
    while (text[from + n] === ch) n++;
    return n;
  };

  // Already wrapped inside the selection: `**bold**` selected whole.
  const innerLead = runForward(start);
  if (
    selected.length >= marker.length * 2 &&
    innerLead === marker.length &&
    selected.endsWith(marker) &&
    runBackward(end) === marker.length
  ) {
    const inner = selected.slice(
      marker.length,
      selected.length - marker.length,
    );
    return {
      text: `${text.slice(0, start)}${inner}${text.slice(end)}`,
      start,
      end: start + inner.length,
    };
  }

  // Already wrapped just outside the selection: `**bold**` with `bold` selected.
  if (
    runBackward(start) === marker.length &&
    runForward(end) === marker.length
  ) {
    const from = start - marker.length;
    return {
      text: `${text.slice(0, from)}${selected}${text.slice(end + marker.length)}`,
      start: from,
      end: from + selected.length,
    };
  }

  return {
    text: `${text.slice(0, start)}${marker}${selected}${marker}${text.slice(end)}`,
    // The selection stays on the author's own words, not on the markers, so a
    // second action composes: bold then italic wraps twice around the same text.
    start: start + marker.length,
    end: end + marker.length,
  };
}

/** Start of the line containing `at`. */
function lineStart(text: string, at: number): number {
  const found = text.lastIndexOf("\n", Math.max(0, at - 1));
  return found === -1 ? 0 : found + 1;
}

/** End of the line containing `at`, exclusive of the newline. */
function lineEnd(text: string, at: number): number {
  const found = text.indexOf("\n", at);
  return found === -1 ? text.length : found;
}

/**
 * Toggle a line prefix across every line the selection touches.
 *
 * Line-oriented syntax has to be applied per line: prefixing only the first line
 * of a three-line selection produces one quoted line and two orphans, which is
 * never what a selection of three lines meant.
 */
function prefixLines(
  selection: TextSelection,
  prefix: string | ((index: number) => string),
): TextSelection {
  const { text, start, end } = selection;
  const from = lineStart(text, start);
  const to = lineEnd(text, end);
  const lines = text.slice(from, to).split("\n");

  const prefixAt = (i: number): string =>
    typeof prefix === "string" ? prefix : prefix(i);

  // Remove only when *every* touched line already has it, so a partly-quoted
  // selection becomes fully quoted rather than half-unquoted.
  const allPrefixed = lines.every((line, i) => line.startsWith(prefixAt(i)));

  const rewritten = lines
    .map((line, i) =>
      allPrefixed ? line.slice(prefixAt(i).length) : `${prefixAt(i)}${line}`,
    )
    .join("\n");

  const delta = rewritten.length - (to - from);
  return {
    text: `${text.slice(0, from)}${rewritten}${text.slice(to)}`,
    // The whole affected range stays selected: the author can hit the button
    // again to undo, or a second button to stack.
    start: from,
    end: to + delta,
  };
}

/** Heading levels the heading button cycles through. */
const HEADING_PREFIXES = ["## ", "### ", "# "] as const;

/** Next heading prefix for a line, cycling `##` → `###` → `#` → none. */
function cycleHeading(selection: TextSelection): TextSelection {
  const { text, start } = selection;
  const from = lineStart(text, start);
  const to = lineEnd(text, selection.end);
  const line = text.slice(from, to);

  const current = HEADING_PREFIXES.findIndex((p) => line.startsWith(p));
  const bare =
    current === -1
      ? line
      : line.slice((HEADING_PREFIXES[current] as string).length);
  const nextIndex = current + 1;
  const next =
    nextIndex >= HEADING_PREFIXES.length
      ? ""
      : (HEADING_PREFIXES[nextIndex] as string);

  const rewritten = `${next}${bare}`;
  return {
    text: `${text.slice(0, from)}${rewritten}${text.slice(to)}`,
    start: from + next.length,
    end: from + rewritten.length,
  };
}

/** `[label](url)`, with the part the author still has to fill in selected. */
function insertLink(selection: TextSelection): TextSelection {
  const { text, start, end } = selection;
  const selected = text.slice(start, end);

  // A selected URL becomes the destination, not the label — that is what the
  // author meant by selecting it.
  const selectionIsUrl = /^(?:https?:\/\/|mailto:|nostr:)\S*$/.test(selected);
  const label = selectionIsUrl ? "" : selected;
  const href = selectionIsUrl ? selected : LINK_PLACEHOLDER;

  const inserted = `[${label}](${href})`;
  const next = `${text.slice(0, start)}${inserted}${text.slice(end)}`;

  if (selectionIsUrl) {
    // Caret in the empty label: the destination is known, the words are not.
    const caret = start + 1;
    return { text: next, start: caret, end: caret };
  }
  // Select the placeholder destination so typing replaces it outright.
  const hrefStart = start + inserted.length - 1 - href.length;
  return { text: next, start: hrefStart, end: hrefStart + href.length };
}

/**
 * Inline code for a one-line selection, a fenced block for anything multi-line.
 *
 * A backtick span containing a newline does not render as code at all, so
 * guessing wrong here produces output that silently is not code.
 */
function insertCode(selection: TextSelection): TextSelection {
  const { text, start, end } = selection;
  const selected = text.slice(start, end);
  if (selected !== "" && !selected.includes("\n")) return wrap(selection, "`");

  const from = lineStart(text, start);
  const to = lineEnd(text, end);
  const body = text.slice(from, to);
  const opening = "```\n";
  const rewritten = `${opening}${body}\n\`\`\``;
  return {
    text: `${text.slice(0, from)}${rewritten}${text.slice(to)}`,
    // Select the body, leaving the fences alone.
    start: from + opening.length,
    end: from + opening.length + body.length,
  };
}

/**
 * Apply a toolbar action.
 *
 * Returns the new text together with the selection the textarea must be restored
 * to. Callers must apply *both* — applying only the text is exactly the bug this
 * module exists to prevent.
 */
export function applyToolbarAction(
  selection: TextSelection,
  action: ToolbarAction,
): TextSelection {
  const normalized = normalize(selection);
  switch (action) {
    case "bold":
      return wrap(normalized, "**");
    case "italic":
      return wrap(normalized, "*");
    case "strike":
      return wrap(normalized, "~~");
    case "heading":
      return cycleHeading(normalized);
    case "quote":
      return prefixLines(normalized, "> ");
    case "list":
      return prefixLines(normalized, "- ");
    case "orderedList":
      return prefixLines(normalized, (i) => `${i + 1}. `);
    case "link":
      return insertLink(normalized);
    case "code":
      return insertCode(normalized);
    default: {
      // Exhaustiveness guard: an unhandled action must not silently discard the
      // author's text.
      const never: never = action;
      void never;
      return normalized;
    }
  }
}
