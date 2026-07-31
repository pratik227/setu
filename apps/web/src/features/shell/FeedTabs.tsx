import { cn } from "@setu/ui";
import { Plus, X } from "lucide-react";
import { useCallback, useRef } from "react";

export interface FeedTab {
  readonly id: string;
  readonly label: string;
  /** Pinned tabs can be removed; built-ins cannot. */
  readonly removable?: boolean;
}

export interface FeedTabsProps {
  tabs: readonly FeedTab[];
  activeId: string;
  onSelect(id: string): void;
  onRemove?(id: string): void;
  onAdd?(): void;
}

/**
 * Horizontal feed switcher for the content header.
 *
 * Implemented as a real tablist so keyboard users get arrow-key traversal and
 * screen readers announce the selected feed. Roving `tabIndex` (only the active
 * tab is focusable) is what keeps Tab from walking through every feed on the way
 * to the timeline.
 */
export function FeedTabs({
  tabs,
  activeId,
  onSelect,
  onRemove,
  onAdd,
}: FeedTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const delta =
        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      const index = tabs.findIndex((tab) => tab.id === activeId);
      // Wrap, so arrowing past the end returns to the start rather than dead-ending.
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      if (!next) return;
      onSelect(next.id);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)
        ?.focus();
    },
    [tabs, activeId, onSelect],
  );

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Feeds"
      onKeyDown={onKeyDown}
      className="setu-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div key={tab.id} className="group/tab relative shrink-0">
            <button
              type="button"
              role="tab"
              data-tab-id={tab.id}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm whitespace-nowrap transition-colors",
                "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
                active
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
                tab.removable && "pr-6",
              )}
            >
              {tab.label}
              {active ? (
                <span
                  aria-hidden
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
                />
              ) : null}
            </button>
            {tab.removable && onRemove ? (
              <button
                type="button"
                aria-label={`Remove ${tab.label}`}
                onClick={() => onRemove(tab.id)}
                className={cn(
                  "absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5",
                  "text-muted-foreground opacity-0 transition-opacity",
                  "group-hover/tab:opacity-100 focus-visible:opacity-100",
                  "hover:text-foreground focus-visible:outline-hidden",
                )}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        );
      })}
      {onAdd ? (
        <button
          type="button"
          aria-label="Add a feed"
          onClick={onAdd}
          className={cn(
            "shrink-0 rounded-md p-1 text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
          )}
        >
          <Plus className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
