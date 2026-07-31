import { Button, cn } from "@setu/ui";
import {
  Bold,
  Code,
  Heading,
  Italic,
  Link as LinkIcon,
  List,
  Quote,
  Strikethrough,
} from "lucide-react";
import type { RefObject } from "react";
import { useCallback } from "react";
import { applyToolbarAction, type ToolbarAction } from "./markdownToolbar";

/**
 * The formatting toolbar.
 *
 * Named `EditorToolbar` rather than `MarkdownToolbar` so the filename cannot
 * collide with `markdownToolbar.ts` beside it: on a case-insensitive filesystem
 * those resolve to the same module and one of the two imports silently returns
 * the wrong file.
 *
 * All of the interesting behavior is the caret. React re-renders a controlled
 * textarea from state, and that resets the selection — so a button that only
 * calls `onChange` leaves the caret at the end of the document, and after two
 * clicks the author abandons the toolbar and types the syntax by hand.
 *
 * The fix has three parts and needs all three:
 *
 *  1. Read the *live* selection off the DOM node at click time. React state does
 *     not track it, and a stale copy silently formats the wrong words.
 *  2. Compute the next text *and* the next selection together — that is what
 *     `applyToolbarAction` returns, and why it is a pure function rather than
 *     something scattered through this component.
 *  3. Restore the selection after React has committed the new value. Doing it
 *     synchronously would set a selection on text that is about to be replaced.
 *     `requestAnimationFrame` lands after the commit; `focus()` first, because a
 *     selection on an unfocused textarea is invisible.
 */

const ACTIONS: readonly {
  readonly action: ToolbarAction;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly shortcut?: string;
}[] = [
  { action: "bold", label: "Bold", icon: <Bold />, shortcut: "b" },
  { action: "italic", label: "Italic", icon: <Italic />, shortcut: "i" },
  { action: "strike", label: "Strikethrough", icon: <Strikethrough /> },
  { action: "heading", label: "Heading", icon: <Heading /> },
  { action: "quote", label: "Blockquote", icon: <Quote /> },
  { action: "list", label: "Bulleted list", icon: <List /> },
  { action: "link", label: "Link", icon: <LinkIcon />, shortcut: "k" },
  { action: "code", label: "Code", icon: <Code /> },
];

export interface EditorToolbarProps {
  textarea: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange(next: string): void;
  disabled?: boolean;
  className?: string;
}

/**
 * Apply an action to a textarea and restore the caret. Exported so the editor's
 * keyboard shortcuts run the exact same path as the buttons.
 */
export function runToolbarAction(
  node: HTMLTextAreaElement | null,
  value: string,
  action: ToolbarAction,
  onChange: (next: string) => void,
): void {
  if (!node) return;
  const next = applyToolbarAction(
    { text: value, start: node.selectionStart, end: node.selectionEnd },
    action,
  );
  onChange(next.text);
  requestAnimationFrame(() => {
    node.focus();
    node.setSelectionRange(next.start, next.end);
  });
}

export function EditorToolbar({
  textarea,
  value,
  onChange,
  disabled = false,
  className,
}: EditorToolbarProps) {
  const run = useCallback(
    (action: ToolbarAction) => {
      runToolbarAction(textarea.current, value, action, onChange);
    },
    [textarea, value, onChange],
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-0.5 border-b border-border/60 px-1 py-1",
        className,
      )}
    >
      {ACTIONS.map(({ action, label, icon, shortcut }) => (
        <Button
          key={action}
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={shortcut ? `${label} (Ctrl+${shortcut})` : label}
          title={shortcut ? `${label} — Ctrl/Cmd+${shortcut}` : label}
          // The caret must not leave the textarea, and a button takes focus on
          // mousedown before any click handler runs.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(action)}
        >
          {icon}
        </Button>
      ))}
    </div>
  );
}
