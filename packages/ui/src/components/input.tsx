import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Text input.
 *
 * `autoCapitalize`, `autoCorrect` and `spellCheck` are switched off at the
 * primitive rather than per field. Almost everything typed into this app is a
 * key, a relay URL, a NIP-05 identifier or a hashtag — strings where a mobile
 * keyboard capitalising the first letter or "correcting" a word produces a value
 * that silently fails to parse. The prose surfaces (the composer, an article
 * body) are textareas and opt back in explicitly.
 *
 * `text-base` with `md:text-sm` is deliberate: iOS Safari zooms the viewport when
 * a focused input's text is under 16px, so the larger size is what stops the page
 * jumping on every tap.
 */
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      type={type}
      className={cn(
        "flex h-9 w-full rounded-lg border border-input/40 bg-background px-3 py-1",
        "text-base transition-colors md:text-sm",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "placeholder:text-muted-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Multi-line input.
 *
 * Spellcheck and autocorrect stay off by default for the same reason as
 * {@link Input}; a field holding prose should set `spellCheck` back on.
 */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      className={cn(
        "flex min-h-20 w-full rounded-lg border border-input/40 bg-background px-3 py-2",
        "text-base transition-colors md:text-sm",
        "placeholder:text-muted-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
