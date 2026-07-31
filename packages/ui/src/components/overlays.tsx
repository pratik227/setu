import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * The surface every anchored overlay sits on.
 *
 * A hair of `muted` mixed into the background rather than a flat `popover` fill:
 * against a page that is already near-white or near-black, a panel of exactly the
 * page colour reads as part of the page, and the border ends up doing all the
 * work. The three-layer shadow is deliberately tiny (2%/4%/4%) — enough to lift,
 * not enough to look like a card.
 */
export const POPOVER_SURFACE = cn(
  "border border-border/60 text-popover-foreground shadow-popover",
  "bg-[color-mix(in_srgb,hsl(var(--background))_80%,hsl(var(--muted))_20%)]",
);

/* -------------------------------------------------------------------------- */
/* Dialog                                                                      */
/* -------------------------------------------------------------------------- */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "motion-overlay fixed inset-0 z-50 backdrop-blur-[5px]",
        // Light needs only a wash to signal "behind"; dark needs real weight or
        // the panel and the page read as the same plane.
        "bg-black/10 dark:bg-black/60",
        className,
      )}
      {...props}
    />
  );
}

export interface DialogContentProps
  extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Hide the built-in close button when the dialog supplies its own. */
  hideClose?: boolean;
}

export function DialogContent({
  className,
  children,
  hideClose = false,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "motion-dialog fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          // `w-[calc(100vw-2rem)]` rather than a percentage: it guarantees a
          // gutter on a narrow viewport instead of scaling one.
          "grid w-[calc(100vw-2rem)] max-w-2xl gap-4",
          "rounded-2xl bg-background p-6 shadow-2xl outline-hidden",
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            aria-label="Close"
            className={cn(
              "absolute top-4 right-4 flex size-8 items-center justify-center",
              "rounded-md text-muted-foreground transition-colors",
              "duration-(--motion-duration-instant)",
              "hover:bg-accent hover:text-accent-foreground",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
              "[&_svg]:size-4",
            )}
          >
            <X />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-xl font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * Action row.
 *
 * `flex-col-reverse` on narrow screens so the primary action — last in the DOM,
 * which is the correct tab order — ends up on top where the thumb is.
 */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Dropdown menu                                                               */
/* -------------------------------------------------------------------------- */

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "motion-popover z-50 min-w-44 overflow-hidden rounded-lg p-1",
          POPOVER_SURFACE,
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive = false,
  ...props
}: ComponentProps<typeof MenuPrimitive.Item> & { destructive?: boolean }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
        "text-sm outline-hidden select-none",
        "transition-colors duration-(--motion-duration-instant)",
        // Radix drives hover *and* keyboard focus through `highlighted`, so both
        // land on one visual state instead of two that can disagree.
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        destructive &&
          "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn(
        "px-2 py-1.5 text-2xs font-semibold tracking-[0.12em] text-muted-foreground uppercase",
        className,
      )}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Wrap the app once. Radix shares open/close timing across every tooltip inside
 * a provider, which is what stops a row of icon buttons flashing a tooltip each
 * as the pointer crosses them.
 */
export function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 200,
  children,
}: {
  delayDuration?: number;
  skipDelayDuration?: number;
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
    >
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * Hover/focus hint for a control whose icon is not self-explanatory.
 *
 * A tooltip is never the only place a label exists: touch and screen-reader users
 * never see it, so the trigger must carry an `aria-label` regardless. This
 * repeats that label visually for pointer users rather than supplying it.
 */
export function Tooltip({
  label,
  side = "top",
  children,
}: {
  label: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            "motion-popover z-50 rounded-md px-2 py-1 text-xs",
            POPOVER_SURFACE,
          )}
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
