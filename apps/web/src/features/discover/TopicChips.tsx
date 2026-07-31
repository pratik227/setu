import { cn } from "@setu/ui";
import type { RankedTopic } from "./ranking";

/**
 * Chips for a topic ranking.
 *
 * Size encodes rank, not magnitude: the type scale has four steps and a count of
 * 40 vs 38 is not a visible difference worth inventing a size for. Chips are
 * bucketed by position in the ranking so the strip reads as an ordering, which is
 * the only thing the sample can actually support — and the count is printed next
 * to each one so nobody has to infer it from the size.
 */

export interface TopicChipsProps {
  readonly topics: readonly RankedTopic[];
  onOpenHashtag?(tag: string): void;
  /** Emphasize the leading chips. Off in the narrow panel, where space is tight. */
  readonly scaled?: boolean;
  readonly className?: string;
}

function chipScale(index: number, scaled: boolean): string {
  if (!scaled) return "text-xs";
  if (index === 0) return "text-base font-semibold";
  if (index < 3) return "text-sm font-medium";
  return "text-xs";
}

export function TopicChips({
  topics,
  onOpenHashtag,
  scaled = false,
  className,
}: TopicChipsProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {topics.map((topic, index) => (
        <button
          key={topic.tag}
          type="button"
          onClick={() => onOpenHashtag?.(topic.tag)}
          title={`${topic.count} ${
            topic.count === 1 ? "note" : "notes"
          } in your local index`}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border/60",
            "bg-muted/40 px-2.5 py-1",
            "transition-colors duration-(--motion-duration-instant)",
            "hover:border-border hover:bg-muted",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
            chipScale(index, scaled),
          )}
        >
          <span className="truncate">
            <span className="text-muted-foreground">#</span>
            {topic.tag}
          </span>
          <span className="text-2xs text-muted-foreground tabular-nums">
            {topic.count}
          </span>
        </button>
      ))}
    </div>
  );
}
