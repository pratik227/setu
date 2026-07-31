/**
 * The two layout pieces every sign-in surface shares.
 *
 * Extracted from `LoginScreen` when remote signing arrived: the bunker flows are a
 * screen of their own (two directions, a live handshake, a relay to choose) and
 * inlining them would have taken the login screen past the 700-line ceiling. Sharing
 * the shell rather than reimplementing it is also what keeps every step of sign-in
 * looking like one flow.
 */

import { Button, Input, Label } from "@setu/ui";

export function Field({
  label,
  hint,
  id,
  ...props
}: React.ComponentProps<"input"> & { label: string; hint?: string }) {
  // A generated id rather than nesting the input inside the label: a `hint`
  // sitting inside the label element would be read out as part of the label.
  const fieldId = id ?? `field-${label.toLowerCase().replace(/\s+/g, "-")}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  return (
    <div className="space-y-1">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input id={fieldId} aria-describedby={hintId} {...props} />
      {hint ? (
        <p id={hintId} className="text-2xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function AuthShell({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack?(): void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Setu verifies every event locally. Nothing is trusted because a
            server said so.
          </p>
        </div>
        {children}
        {onBack ? (
          <Button variant="ghost" size="sm" className="w-full" onClick={onBack}>
            Back
          </Button>
        ) : null}
      </div>
    </div>
  );
}
