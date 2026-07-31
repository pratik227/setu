import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Compact, desktop-app density. Sizes are deliberately smaller than a marketing
 * site's: a client shows many controls at once, and a 44px button ramps a
 * toolbar into a wall.
 */
export const buttonVariants = cva(
  cn(
    "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg",
    "text-sm font-medium whitespace-nowrap",
    "transition-colors duration-(--motion-duration-instant)",
    "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
    // A disabled control must look inert, not merely faded. Opacity alone is not
    // enough here: `primary` is ink rather than a hue, so a filled button at 50%
    // in dark mode is a light grey rectangle that reads as perfectly clickable.
    // Changing the surface is what makes "unavailable" legible. The `disabled:`
    // variant outranks the plain background utility on specificity, so this wins
    // for every variant without needing per-variant overrides.
    "disabled:pointer-events-none disabled:border-transparent",
    "disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none",
    "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:pointer-events-none",
  ),
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        // A tinted fill needs less lift than the primary one: `shadow-xs` is a
        // single 5% layer, enough to seat the button without making a secondary
        // action compete with the main one.
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        outline: "border border-input/40 bg-background hover:bg-muted/70",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        /** For chrome over the brand gradient: neutral ink, no colored fill. */
        chrome:
          "text-[color:var(--setu-chrome-foreground,hsl(var(--muted-foreground)))] hover:bg-[var(--setu-hover-surface,hsl(var(--accent)))] hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      /**
       * Shape is separate from size so any size can be a pill. A fully rounded
       * primary action reads as the page's one main affordance in a way a
       * same-radius-as-everything button does not.
       */
      shape: {
        default: "",
        pill: "rounded-full",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        xs: "h-6 px-2 text-xs",
        lg: "h-10 px-8",
        icon: "h-8 w-8",
        "icon-xs": "h-6 w-6 [&_svg]:size-3.5",
        /** Primary call to action: taller, wider, meant to be pilled. */
        cta: "h-11 px-6 text-base",
      },
    },
    defaultVariants: { variant: "default", size: "default", shape: "default" },
  },
);

export interface ButtonProps
  extends ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  shape,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, shape }), className)}
      {...props}
    />
  );
}
