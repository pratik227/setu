import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * The wide-tracked uppercase micro-pill. The 0.18em tracking on 11px text is the
 * signature detail — it reads as a label rather than as shouting, which is why
 * the uppercase works at all at this size.
 */
export const badgeVariants = cva(
  cn(
    "inline-flex items-center rounded-full px-2 pt-[5px] pb-[3px]",
    "text-2xs leading-none font-semibold tracking-[0.18em] uppercase",
    "whitespace-nowrap",
  ),
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-muted text-muted-foreground",
        outline:
          "border border-border/70 bg-background/80 text-muted-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        // Tinted status variants: a 15% wash with saturated ink, so a badge
        // reads as a state rather than as another filled button.
        warning: "bg-zap/15 text-zap",
        success: "bg-repost/15 text-repost",
        info: "bg-verified/15 text-verified",
        zap: "bg-zap/15 text-zap",
        muted: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

/**
 * Numeric unread indicator. Caps at 99+ — past that the exact number stops
 * being information and starts being anxiety.
 */
export function CountBadge({
  count,
  className,
  ...props
}: ComponentProps<"span"> & { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-4 items-center justify-center rounded-full px-1",
        "bg-primary text-primary-foreground",
        "text-2xs leading-none font-semibold tabular-nums",
        "h-4",
        className,
      )}
      {...props}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Plain dot for "there is something new, but it is not addressed to you". */
export function UnreadDot({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("size-1.5 rounded-full bg-foreground/60", className)}
      {...props}
    />
  );
}
