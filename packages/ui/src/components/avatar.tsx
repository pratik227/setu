import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * 36px is the feed-row default — large enough to recognize a face, small enough
 * that the note text, not the avatar column, sets the row's rhythm.
 */
export function Avatar({
  className,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative flex size-9 shrink-0 overflow-hidden rounded-full",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarImage({
  className,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      className={cn("aspect-square size-full object-cover", className)}
      // A feed scrolls past hundreds of these. Lazy loading keeps off-screen
      // avatars off the network, and async decoding keeps the ones that do load
      // from blocking the frame the row paints in.
      decoding="async"
      loading="lazy"
      {...props}
    />
  );
}

export function AvatarFallback({
  className,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        // `inherit` rather than `rounded-full`: a caller that squares off the
        // root (a community or relay avatar) would otherwise get a circular
        // fallback behind a square image.
        "flex size-full items-center justify-center rounded-[inherit]",
        "bg-muted text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
