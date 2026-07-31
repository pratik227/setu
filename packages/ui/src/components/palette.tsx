import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { POPOVER_SURFACE } from "./overlays";

/**
 * A command palette: one text field over one keyboard-driven list.
 *
 * Presentation only — it knows nothing about what is being searched, which is
 * what keeps it in this layer. The consumer owns the query, the results and the
 * selection; these parts own the surface, the type and the focus behaviour.
 *
 * Three things here are load-bearing rather than decorative.
 *
 * **The list is not focusable.** Focus stays in the input for the whole
 * interaction and the selected row is announced through `aria-activedescendant`,
 * which is the ARIA combobox pattern. Moving DOM focus onto rows instead — the
 * obvious implementation — means every arrow key steals focus from the field, so
 * the next character typed goes nowhere and the query the reader is refining stops
 * updating.
 *
 * **Position uses margins, not transforms.** `left-1/2 -translate-x-1/2` is the
 * usual way to centre a fixed panel, and it silently loses to the arrival
 * animation: `motion-dialog` animates `transform` with `animation-fill-mode: both`,
 * so the keyframe's final `transform` sticks and overwrites the centring class for
 * the life of the panel. Insets plus `mx-auto` centre without touching `transform`,
 * leaving the animation the only thing that owns it.
 *
 * **The height is capped in viewport units.** A palette that grows with its result
 * list pushes its own footer off the bottom of a laptop screen — and the footer is
 * where this app says what search did and did not cover, which is the part that
 * must not be the first thing to disappear.
 */
export function PaletteDialog({
  open,
  onOpenChange,
  title,
  children,
  className,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Accessible name. Rendered for screen readers only; the field is the label. */
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "motion-overlay fixed inset-0 z-50 backdrop-blur-[5px]",
            "bg-black/10 dark:bg-black/60",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "motion-dialog fixed inset-x-4 top-[12vh] z-50 mx-auto",
            "flex max-h-[70vh] w-auto max-w-xl flex-col overflow-hidden",
            "rounded-2xl shadow-2xl outline-hidden",
            POPOVER_SURFACE,
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The query field.
 *
 * Borderless and full-bleed: the panel edge is already the boundary, and a second
 * bordered box inside it reads as a form the reader has to submit rather than a
 * field that filters as they type.
 */
export function PaletteField({
  icon,
  trailing,
  className,
  ...props
}: ComponentProps<"input"> & { icon?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/60 px-4">
      {icon ? (
        <span className="shrink-0 text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <input
        // Off at the primitive for the same reason as `Input`: most of what gets
        // typed here is a key, a handle or a hashtag, and a mobile keyboard
        // capitalising the first letter produces a value that fails to parse.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        type="text"
        className={cn(
          // `text-base` up to `md` stops iOS Safari zooming the viewport on focus,
          // which on a fixed-position panel leaves it half off-screen.
          "min-w-0 flex-1 bg-transparent text-base outline-hidden md:text-sm",
          "placeholder:text-muted-foreground",
          className,
        )}
        {...props}
      />
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </div>
  );
}

/** The scrolling results region. Owns `role="listbox"`; rows are its options. */
export function PaletteList({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="listbox"
      className={cn("setu-scroll min-h-0 flex-1 py-1", className)}
      {...props}
    />
  );
}

/**
 * A labelled run of rows, so "People" and "Notes" are distinguishable.
 *
 * `role="group"` is suppressed against `useSemanticElements` below because the
 * rule's suggested replacement is `<fieldset>` — a form-control container, and not
 * a legal child of a listbox. Grouping is the one thing ARIA offers here.
 */
export function PaletteGroup({
  label,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { label: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset cannot be a listbox child
    <div role="group" aria-label={label} className={className} {...props}>
      <div className="px-4 pt-2 pb-1 text-2xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * One result row.
 *
 * `selected` is driven by the consumer's keyboard state and hover both, so
 * pointer and keyboard land on one visual state instead of two that can disagree
 * about which row Enter will open. Deliberately a `div`, not a `button`: a button
 * inside a listbox is not an `option`, and giving it a role that contradicts its
 * tag is how a row ends up announced twice.
 */
export function PaletteOption({
  selected = false,
  className,
  ...props
}: ComponentProps<"div"> & { selected?: boolean }) {
  return (
    <div
      role="option"
      aria-selected={selected}
      // Focusable programmatically, never in the tab order. The combobox pattern
      // keeps DOM focus in the field and points here with
      // `aria-activedescendant`, so a positive `tabIndex` would insert every
      // result into the page's tab sequence.
      tabIndex={-1}
      data-selected={selected || undefined}
      className={cn(
        "flex cursor-pointer items-center gap-3 px-4 py-2 text-left",
        "transition-colors duration-(--motion-duration-instant)",
        selected && "bg-accent text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The band under the list, for coverage statements and key hints.
 *
 * `shrink-0` so it survives a long result list: it carries what the search did
 * and did not cover, and a footer that scrolls away turns a qualified answer into
 * an unqualified one.
 */
export function PaletteFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2",
        "text-2xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** A key cap, for the hints in the footer. */
export function PaletteKey({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "rounded border border-border/70 px-1 font-sans text-2xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
