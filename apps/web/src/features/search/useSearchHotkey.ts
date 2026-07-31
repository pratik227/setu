/**
 * The keyboard shortcut the sidebar advertises.
 *
 * It lives here rather than on the button because the button is not always the
 * thing with focus — the whole point of ⌘K is that it works from wherever the
 * reader happens to be, including inside the feed and inside a text field. A
 * listener on the button would only fire when the button already had focus, at
 * which point Enter would do.
 *
 * Both modifiers are accepted regardless of platform. Ctrl+K is the browser's own
 * "focus the search bar" on Windows and Linux and does nothing on macOS, so
 * accepting only the platform's canonical modifier would leave one of the two
 * combinations a reader might reasonably try silently doing something else.
 */

import { useEffect, useRef } from "react";

export function useSearchHotkey(onTrigger: () => void): void {
  // Read through a ref so the listener is installed once. Callers pass an inline
  // arrow, and depending on its identity would add and remove a window listener
  // on every render of the shell.
  const handler = useRef(onTrigger);
  handler.current = onTrigger;

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key !== "k" && event.key !== "K") return;
      if (!event.metaKey && !event.ctrlKey) return;
      // Cmd+Shift+K and Alt+K are other shortcuts, some of them the browser's.
      // Claiming a combination we do not implement is how a devtools shortcut
      // stops working inside one tab.
      if (event.altKey || event.shiftKey) return;
      // Ctrl+K focuses the address bar in Chrome and Firefox. Without this the
      // palette opens and the reader's next keystroke goes to the URL bar.
      event.preventDefault();
      handler.current();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
