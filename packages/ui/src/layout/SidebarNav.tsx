import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * A sidebar row.
 *
 * Hover and active are neutral ink washes — 4% and 7% — with the label keeping
 * the normal foreground colour. Buzz's rule, and worth stating because the
 * obvious alternative is worse: filling the active row with the accent and
 * recolouring its text makes the nav shout, and on a client where the nav is
 * always visible and rarely the subject, the selected row only has to be
 * findable, not loud.
 *
 * The `var(--setu-*, fallback)` pattern lets the optional gradient theme
 * substitute its own washes; under the flat default they resolve to plain ink.
 */
export interface SidebarRowProps extends ComponentProps<"button"> {
  active?: boolean;
  icon?: ReactNode;
  /** Right-aligned slot: count badge, unread dot, hover actions. */
  trailing?: ReactNode;
  collapsed?: boolean;
  /**
   * `lg` is for primary navigation, where each row is a destination rather than
   * one item in a long list, and deserves the larger tap target and type size.
   */
  size?: "default" | "lg";
}

export function SidebarRow({
  className,
  active = false,
  icon,
  trailing,
  collapsed = false,
  size = "default",
  children,
  ...props
}: SidebarRowProps) {
  const large = size === "lg";
  return (
    <button
      type="button"
      data-active={active || undefined}
      className={cn(
        // `rounded-md` at every size. A full-radius pill is a different design
        // language — it reads as a floating chip rather than a band of the
        // sidebar — and it makes the nav the loudest thing on the screen.
        "cv-auto-sidebar-row group/row flex w-full items-center rounded-md transition-colors",
        "duration-(--motion-duration-instant)",
        large ? "h-10 gap-3 px-2 text-sm" : "h-8 gap-2 px-2 text-sm",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        active
          ? cn(
              "font-semibold shadow-xs",
              "bg-[var(--setu-active-surface,hsl(var(--foreground)/0.07))]",
              "text-[color:var(--setu-active-foreground,hsl(var(--foreground)))]",
            )
          : cn(
              "text-[color:var(--setu-chrome-foreground,hsl(var(--sidebar-foreground)))]",
              "hover:bg-[var(--setu-hover-surface,hsl(var(--foreground)/0.04))]",
              "hover:text-foreground",
            ),
        collapsed && "justify-center px-0",
        className,
      )}
      {...props}
    >
      {icon}
      {!collapsed && (
        <>
          <span className="grid min-w-0 flex-1 overflow-hidden text-left">
            {/*
             * The active row bolds its label, and bold text is wider — so
             * without this the whole row's contents shift sideways the moment it
             * becomes active, and anything trailing it moves with them. An
             * invisible copy at the heavier weight reserves the widest state in
             * the same grid cell, so the visible copy never changes the row's
             * measure. The visible copy stays the accessible label.
             */}
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 truncate font-semibold"
            >
              {children}
            </span>
            <span className="col-start-1 row-start-1 truncate">{children}</span>
          </span>
          {trailing ? (
            <span className="flex shrink-0 items-center gap-1">{trailing}</span>
          ) : null}
        </>
      )}
    </button>
  );
}

/**
 * A collapsible sidebar section.
 *
 * Section actions stay at `opacity-0` until the section is hovered — the sidebar
 * at rest shows only names, and affordances appear where the pointer is. Keeping
 * them mounted (rather than conditionally rendered) means no layout shift when
 * they appear, and keyboard focus can still reach them.
 */
export interface SidebarSectionProps {
  label: string;
  open?: boolean;
  onToggle?(): void;
  /** Hover-revealed controls, e.g. an add button or an overflow menu. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SidebarSection({
  label,
  open = true,
  onToggle,
  actions,
  children,
  className,
}: SidebarSectionProps) {
  return (
    <section className={cn("group/section flex flex-col", className)}>
      <div className="flex h-7 items-center gap-1 pr-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1",
            "text-2xs font-semibold tracking-[0.12em] uppercase",
            "text-[color:var(--setu-muted-foreground,hsl(var(--muted-foreground)))]",
            "hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
          )}
        >
          <ChevronRight
            className={cn(
              "size-3 transition-transform duration-(--motion-duration-instant)",
              open && "rotate-90",
            )}
          />
          <span className="truncate">{label}</span>
        </button>
        {actions ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity",
              "duration-(--motion-duration-instant)",
              "group-hover/section:opacity-100 focus-within:opacity-100",
            )}
          >
            {actions}
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-0.5 pb-1">{children}</div>
      ) : null}
    </section>
  );
}

/**
 * The keyboard hint for the search affordance, in this platform's notation.
 *
 * Hardcoded "⌘K" was wrong on every machine without a ⌘ key: the hint named a
 * shortcut the reader could not press, while the one they could — Ctrl+K — went
 * unadvertised. An affordance that states the wrong key is worse than one that
 * states none, because it teaches the reader the feature does not work.
 *
 * Resolved once at module load: it cannot change while the page is open. Guarded
 * because `navigator` is absent when this module is imported outside a browser,
 * and a design-system import that throws in a test runner fails for reasons that
 * have nothing to do with what is under test.
 */
const SEARCH_SHORTCUT_HINT: string = (() => {
  if (typeof navigator === "undefined") return "⌘K";
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
})();

/** Search entry in the sidebar: a 4%-ink pill, not a bordered input. */
export function SidebarSearchButton({
  className,
  children,
  shortcut = SEARCH_SHORTCUT_HINT,
  ...props
}: ComponentProps<"button"> & { shortcut?: string }) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm",
        "bg-[var(--setu-search-surface,hsl(var(--muted)))]",
        "text-[color:var(--setu-muted-foreground,hsl(var(--muted-foreground)))]",
        "transition-colors duration-(--motion-duration-instant)",
        "hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <kbd className="ml-auto font-sans text-2xs tracking-wider opacity-70">
        {shortcut}
      </kbd>
    </button>
  );
}
