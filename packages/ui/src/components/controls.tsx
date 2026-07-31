import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as LabelPrimitive from "@radix-ui/react-label";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Field label. Radix ties it to its control, including for a nested input. */
export function Label({
  className,
  ...props
}: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        "text-sm leading-none font-medium",
        // A disabled control should not leave its label looking actionable.
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}

export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer size-4 shrink-0 rounded-xs border border-primary",
        "ring-offset-background transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {/* Decorative: the checkbox itself carries the state and the label. */}
        <svg
          aria-hidden="true"
          role="presentation"
          viewBox="0 0 24 24"
          fill="none"
          className="size-4"
        >
          <path
            d="m5 12 4 4L19 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center",
        "rounded-full border-2 border-transparent shadow-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "focus-visible:ring-offset-background focus-visible:outline-hidden",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background",
          "shadow-none ring-0 transition-transform",
          "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

/**
 * Rule between groups.
 *
 * `decorative` defaults to true, which drops it from the accessibility tree —
 * correct for a divider that only reinforces grouping already conveyed by
 * headings. Pass `decorative={false}` when the rule is the only thing marking a
 * boundary.
 */
export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Indeterminate progress.
 *
 * Announced as a status by default. Pass `aria-hidden` where a nearby live
 * region already says what is happening, so a screen reader is not told twice.
 */
export function Spinner({
  children,
  className,
  size,
  role = "status",
  "aria-label": ariaLabel = "Loading",
  "aria-hidden": ariaHidden,
  style,
  ...props
}: ComponentProps<"span"> & { size?: number | string }) {
  const decorative = ariaHidden === true || ariaHidden === "true";
  return (
    <span
      aria-hidden={ariaHidden}
      role={decorative ? undefined : role}
      className={cn(
        "motion-spin-arc inline-block size-6 shrink-0 rounded-full",
        "border-4 border-current/10 border-t-current",
        className,
      )}
      style={{
        ...(size === undefined ? null : { height: size, width: size }),
        ...style,
      }}
      {...props}
    >
      {children}
      {decorative ? null : <span className="sr-only">{ariaLabel}</span>}
    </span>
  );
}
