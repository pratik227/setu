/**
 * Wrapping decisions for rendered Markdown.
 *
 * Separate from the parser because it is a layout concern, and separate from the
 * renderer because it is testable arithmetic over a string rather than something
 * only observable in a browser.
 */

/**
 * Length past which a single unbroken run of non-space characters must be
 * force-broken.
 *
 * `overflow-wrap: break-word` (Tailwind's `break-words`) only breaks a word that
 * would otherwise overflow *its own line*; a 900-character token inside a table
 * cell or a flex child still pushes the container wide and gives the whole page
 * a horizontal scrollbar. `break-all` fixes that but ruins normal prose, so it
 * is applied only to the runs that need it.
 */
export const UNBREAKABLE_RUN_THRESHOLD = 48;

const WRAP_CLASS = "break-words";
const BREAK_ALL_CLASS = "break-words break-all";

/** True when `text` contains a run of non-whitespace longer than `threshold`. */
export function hasUnbreakableRun(
  text: string,
  threshold: number = UNBREAKABLE_RUN_THRESHOLD,
): boolean {
  let run = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      run = 0;
      continue;
    }
    run++;
    if (run > threshold) return true;
  }
  return false;
}

/**
 * Wrapping classes for a chunk of text: always `break-words`, plus `break-all`
 * when the text contains a run long enough to overflow on its own.
 */
export function wrapClass(text: string): string {
  return hasUnbreakableRun(text) ? BREAK_ALL_CLASS : WRAP_CLASS;
}
