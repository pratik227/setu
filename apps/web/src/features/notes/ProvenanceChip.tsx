import { cn } from "@setu/ui";
import { useState } from "react";
import { relayHost } from "./useProvenance";

/**
 * Signature element: what this client knows about where a note came from.
 *
 * Reads as `✓ 3` — the signature verified locally, and three relays served it.
 * Both halves are claims only a verifying, local-first client can make, and
 * neither is available in a client that trusts a server's word. Quiet by
 * default, because it is context rather than content; on demand it names the
 * relays, because "three" is only useful if you can ask which three.
 *
 * The check mark is *not* decoration and must never be shown for an unverified
 * event: every event in the store passed verification on the way in, which is
 * exactly what makes the mark meaningful. If that ever stops being true, this
 * component has to stop claiming it.
 */
export function ProvenanceChip({
  relays,
  className,
}: {
  relays: readonly string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  // No provenance recorded means the note reached the store by a path that did
  // not name a relay — our own published note, most often. Claiming zero relays
  // would be wrong, so the chip stays out of the way instead.
  if (relays.length === 0) return null;

  const hosts = relays.map(relayHost);

  return (
    <span className={cn("relative inline-flex", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Signature verified. Served by ${hosts.length} ${
          hosts.length === 1 ? "relay" : "relays"
        }: ${hosts.join(", ")}`}
        className={cn(
          "setu-mono inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs",
          "text-muted-foreground/70 transition-colors",
          "hover:bg-accent hover:text-foreground",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        )}
      >
        {/* Drawn rather than an icon-font glyph so it keeps the mono grid. */}
        {/* Decorative: the button's aria-label already states the meaning, so a
            title here would only duplicate it into the accessible name. */}
        <svg
          viewBox="0 0 10 10"
          role="presentation"
          aria-hidden="true"
          className="size-2.5 shrink-0 text-verified"
        >
          <path
            d="M1.5 5.5 4 8l4.5-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {hosts.length}
      </button>

      {open ? (
        <span
          role="tooltip"
          className={cn(
            // Anchored to the chip's *right* edge, opening leftward. The chip
            // sits at the right end of the action row, so `left-0` sent the
            // panel off the side of the feed column, where it was clipped to a
            // sliver of unreadable text — the relay names it exists to show
            // were the part cut off.
            "absolute bottom-full right-0 z-20 mb-1 w-max max-w-64 rounded-lg border",
            "border-border bg-popover p-2 shadow-popover",
          )}
        >
          <span className="mb-1 block text-2xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            Served by
          </span>
          {hosts.map((host) => (
            <span
              key={host}
              className="setu-mono block text-2xs whitespace-nowrap"
            >
              {host}
            </span>
          ))}
          <span className="mt-1.5 block text-2xs text-muted-foreground">
            Signature checked on this device.
          </span>
        </span>
      ) : null}
    </span>
  );
}
