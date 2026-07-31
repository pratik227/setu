import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * A grouped module in a side column: heading plus content, in a bordered card.
 *
 * The border is what separates one module from the next without needing a rule
 * between them, and it keeps a side column from reading as one undifferentiated
 * list of small text.
 */
export function Panel({
  title,
  action,
  className,
  children,
  ...props
}: ComponentProps<"section"> & {
  title?: string;
  action?: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border border-border/70 bg-card",
        className,
      )}
      {...props}
    >
      {title ? (
        <header className="flex items-center gap-2 px-4 pt-3 pb-1">
          <h2 className="text-base font-bold tracking-tight">{title}</h2>
          {action ? <div className="ml-auto">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** A row inside a {@link Panel}. */
export function PanelRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "px-4 py-2.5 transition-colors hover:bg-muted/50",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/70 bg-card/80 text-card-foreground shadow-xs",
        className,
      )}
      {...props}
    />
  );
}

/** Section heading inside the sidebar or a settings pane. */
export function SectionLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "px-2 text-2xs font-semibold tracking-[0.12em] uppercase",
        "text-[color:var(--setu-muted-foreground,hsl(var(--muted-foreground)))]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Loading placeholder. Pair with `motion-shimmer` for the sweep; on its own it
 * is a static block, which is what reduced-motion users get.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("motion-shimmer rounded-md bg-primary/10", className)}
      {...props}
    />
  );
}

/**
 * Empty state. Feeds are empty for real reasons in Nostr (no follows yet, relay
 * unreachable, filter too narrow), so an empty state must say which — a bare
 * "Nothing here" leaves the user unable to tell a broken client from a quiet one.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
  ...props
}: ComponentProps<"div"> & {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-16 text-center",
        className,
      )}
      {...props}
    >
      {icon ? <div className="mb-1 text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
