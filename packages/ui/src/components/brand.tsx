import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * The Setu mark: a span between two shores.
 *
 * Setu is Sanskrit for bridge, and the mark is the shape of one — an arch over a
 * waterline. Drawn in `currentColor` rather than the favicon's fixed palette, so
 * one mark works on the light chrome, the dark chrome and the gradient themes
 * without three assets that can drift apart.
 *
 * Inline SVG, not an `<img>`: the mark sits in the window chrome, which is the
 * first thing painted, and a mark that arrives one network round trip late reads
 * as a broken image in the corner of the app.
 */
export function SetuMark({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      role="presentation"
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      {/* The span. */}
      <path
        d="M4 21c6 0 6-9 12-9s6 9 12 9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* The water it crosses, held back so the arch stays the subject. */}
      <path
        d="M4 25.5h24"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}

/**
 * Mark plus wordmark, for the window chrome.
 *
 * The word is set in small caps with wide tracking so it reads as an identifier
 * rather than a heading — the chrome is not where the page title belongs.
 */
export function SetuLogo({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    >
      <SetuMark />
      <span className="text-2xs font-semibold tracking-[0.18em] uppercase">
        Setu
      </span>
    </span>
  );
}
