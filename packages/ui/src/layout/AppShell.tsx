import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * The two brand-gradient layers.
 *
 * Both stay mounted at all times and only `opacity` toggles between them.
 * Swapping `background-image` on a translucent surface leaves WKWebView holding
 * the previous raster, so a theme flip without a page reload would show the old
 * ramp until something else forced a repaint.
 */
export function GradientLayers() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <div className="setu-gradient-layer-light absolute inset-0 opacity-0 transition-opacity duration-(--motion-duration-standard)" />
      <div className="setu-gradient-layer-dark absolute inset-0 opacity-0 transition-opacity duration-(--motion-duration-standard)" />
    </div>
  );
}

/** Fixed-height app surface. The gradient is painted here, once. */
export function AppShell({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative isolate h-full w-full overflow-hidden",
        className,
      )}
      {...props}
    >
      <GradientLayers />
      <div className="relative flex h-full flex-col">{children}</div>
    </div>
  );
}

/**
 * Top chrome. 40px is a deliberate px value — it is matched to the macOS traffic
 * lights, which do not scale with the app's font size, so this one measurement
 * must not be rem.
 */
export function TopChrome({
  className,
  children,
  ...props
}: ComponentProps<"header">) {
  return (
    <header
      data-setu-chrome=""
      className={cn(
        "setu-drag-region flex h-10 shrink-0 items-center gap-2 px-3",
        "text-[color:var(--setu-chrome-foreground,hsl(var(--muted-foreground)))]",
        className,
      )}
      {...props}
    >
      {children}
    </header>
  );
}

/** The middle band: sidebar, content card, optional auxiliary panel. */
export function ShellBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-setu-shadow-viewport=""
      className={cn("flex min-h-0 flex-1", className)}
      {...props}
    />
  );
}

export interface SidebarProps extends ComponentProps<"aside"> {
  /** Collapsed rail mode hides labels and narrows to icon width. */
  collapsed?: boolean;
}

/**
 * 280px, wide enough for a feed name plus a count badge without truncating.
 * Solid and one luminance step below the reading surface by default; the
 * gradient themes make it transparent so the painted ramp shows through instead.
 */
export function Sidebar({
  className,
  collapsed = false,
  ...props
}: SidebarProps) {
  return (
    <aside
      data-setu-chrome=""
      data-setu-sidebar-edge=""
      className={cn(
        "flex shrink-0 flex-col overflow-hidden",
        "transition-[width] duration-(--motion-duration-standard) ease-(--motion-ease-standard)",
        collapsed ? "w-14" : "w-[16.5rem] xl:w-[17.5rem]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The reading surface. Flush against the chrome by default; the gradient themes
 * round its top-left corner so it reads as a sheet tucked underneath instead.
 */
export function ContentSurface({
  className,
  ...props
}: ComponentProps<"main">) {
  return (
    <main
      data-setu-content-surface=""
      className={cn(
        "flex min-w-0 flex-1 flex-col overflow-hidden bg-background",
        /*
         * No vertical borders at all. Both seams belong to the neighbours.
         *
         * This element used to carry `border-x`, which doubled *both* dividers: the
         * left edge sat against `[data-setu-sidebar-edge]`'s `border-right` (in
         * `tokens.css`) and the right edge sat against `AuxiliaryPanel`'s `border-l`.
         * Two adjacent 1px rules do not read as a wider line, they read as a *darker*
         * one — a seam that looks like a rendering fault rather than a divider.
         *
         * The rule for the shell is that every vertical boundary is drawn by exactly
         * one element, and for both of these the neighbour is the better owner: the
         * sidebar's edge has to stay paired with its own chrome fill (it goes
         * transparent with it in gradient mode), and the panel's edge only exists when
         * the panel does. Leaving the surface bare means no boundary can be drawn twice
         * no matter which neighbours are mounted.
         */
        className,
      )}
      {...props}
    />
  );
}

/**
 * Right-hand panel: threads, profile previews, relay detail. Threads opening
 * here rather than as a full-page push is Setu's main structural departure from
 * the usual timeline client — you keep your place in the feed while reading a
 * conversation.
 */
export function AuxiliaryPanel({
  className,
  children,
  ...props
}: ComponentProps<"aside">) {
  if (!children) return null;
  return (
    <aside
      className={cn(
        "hidden w-[21rem] shrink-0 flex-col overflow-hidden bg-background",
        "border-l border-border xl:w-[23.75rem] lg:flex",
        className,
      )}
      {...props}
    >
      {children}
    </aside>
  );
}

/** Scrollable region with the quiet-scrollbar treatment and a stable gutter. */
export function ScrollArea({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("setu-scroll min-h-0 flex-1", className)} {...props} />
  );
}

/** Sticky header inside the content card (feed title, tabs). */
export function ContentHeader({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "setu-chrome-surface sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 px-4",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function ReadingColumn({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("setu-reading-column", className)}>{children}</div>;
}
