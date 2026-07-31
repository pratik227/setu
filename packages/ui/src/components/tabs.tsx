import type { ReactNode } from "react";
import { useRef } from "react";
import { cn } from "../lib/cn";

/**
 * A tab strip.
 *
 * Deliberately not a context-based compound component: a tab strip's whole state
 * is "which id is selected", and the caller already owns that. Threading it
 * through context would hide the one thing worth seeing at the call site, and it
 * would make the panel's `aria-labelledby` wiring implicit — which is exactly
 * the part that silently breaks.
 *
 * Keyboard behavior follows the WAI-ARIA tabs pattern with *automatic*
 * activation: arrow keys move selection, not just focus. That is the right
 * choice when switching panels is cheap and non-destructive, and it means a
 * keyboard user needs one keypress rather than two. A roving tabindex keeps the
 * whole strip a single Tab stop.
 */

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
}

export interface TabListProps {
  readonly tabs: readonly TabDefinition[];
  readonly value: string;
  onChange(id: string): void;
  /** Accessible name for the strip — required; an unnamed tablist is a puzzle. */
  readonly label: string;
  /**
   * Namespace for the generated tab/panel ids. Needed when two strips coexist,
   * since `aria-controls` and `aria-labelledby` must point at unique ids.
   */
  readonly idPrefix?: string;
  readonly className?: string;
}

function tabId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}

function panelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`;
}

/**
 * Props for the panel a tab controls. Spread this onto the panel element so the
 * `role`/`aria-labelledby`/`id` triple can never drift from the strip's.
 */
export function tabPanelProps(
  id: string,
  idPrefix = "tabs",
): {
  id: string;
  role: "tabpanel";
  "aria-labelledby": string;
  tabIndex: number;
} {
  return {
    id: panelId(idPrefix, id),
    role: "tabpanel",
    "aria-labelledby": tabId(idPrefix, id),
    // A panel with no focusable content still has to be reachable, or a
    // keyboard user can select a tab and never read what it revealed.
    tabIndex: 0,
  };
}

export function TabList({
  tabs,
  value,
  onChange,
  label,
  idPrefix = "tabs",
  className,
}: TabListProps) {
  // Buttons are held by ref rather than looked up by selector: a tab id is
  // caller-supplied, and `querySelector("#" + id)` on an id needing CSS escaping
  // throws rather than returning nothing — a keyboard-only crash in a component
  // whose whole job is keyboard navigation.
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const move = (delta: number | "first" | "last"): void => {
    if (tabs.length === 0) return;
    const current = tabs.findIndex((tab) => tab.id === value);
    const next =
      delta === "first"
        ? 0
        : delta === "last"
          ? tabs.length - 1
          : // Wrap, per the ARIA pattern: the strip is a ring, not a line.
            (current + delta + tabs.length) % tabs.length;
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    // Selection moved, so focus must follow it — otherwise the next arrow key
    // is computed from a tab the user can no longer see highlighted.
    buttons.current.get(target.id)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className={cn("flex items-center gap-1 overflow-x-auto", className)}
      onKeyDown={(event) => {
        switch (event.key) {
          case "ArrowRight":
            event.preventDefault();
            move(1);
            break;
          case "ArrowLeft":
            event.preventDefault();
            move(-1);
            break;
          case "Home":
            event.preventDefault();
            move("first");
            break;
          case "End":
            event.preventDefault();
            move("last");
            break;
          default:
            break;
        }
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            id={tabId(idPrefix, tab.id)}
            ref={(node) => {
              if (node) buttons.current.set(tab.id, node);
              else buttons.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId(idPrefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5",
              "text-sm whitespace-nowrap",
              "transition-colors duration-(--motion-duration-instant)",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
              "[&_svg]:size-3.5 [&_svg]:shrink-0",
              selected
                ? "bg-muted font-semibold text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
