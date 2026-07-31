/**
 * A note's reactions, broken out by emoji.
 *
 * The action row's heart is one total and cannot show *what* people reacted with —
 * and for a NIP-30 custom emoji reaction it discards the thing the reactor actually
 * chose: a kind-7 whose content is `:soapbox:` counts as one anonymous heart and
 * the image never appears anywhere in the UI. This row is where it appears.
 *
 * Two rules about the wording, in the spirit of every other count in this app:
 *
 *  - The trailing line says the chips are what *this device holds*. Reaction
 *    queries are bounded and our relay set is not the network, so a chip reading
 *    "🔥 12" is a floor. Without the line it reads as the note's twelve fire
 *    reactions, full stop.
 *  - Nothing here is a percentage or a ranking of accounts. Counts are distinct
 *    pubkeys within the sample, ordered by size with a deterministic tie-break so
 *    the chips do not shuffle as reactions arrive.
 */

import { cn } from "@setu/ui";
import { CustomEmoji } from "./CustomEmoji";
import type { GroupedReactions, ReactionGroup } from "./noteReactions";

export function ReactionRow({
  reactions,
  className,
}: {
  reactions: GroupedReactions;
  className?: string;
}) {
  if (reactions.groups.length === 0) return null;

  return (
    <div className={cn("mt-1.5 flex flex-wrap items-center gap-1", className)}>
      {reactions.groups.map((group) => (
        <ReactionChip key={group.key} group={group} />
      ))}
      {/* The caption is not optional. A row of counts with no denominator reads as
          the note's reaction totals, which is a claim no client can make. */}
      <span className="ml-1 text-2xs text-muted-foreground">
        from {reactions.events}{" "}
        {reactions.events === 1 ? "reaction" : "reactions"} this device holds
      </span>
    </div>
  );
}

/**
 * One reaction and its count.
 *
 * A `span`, not a button: reacting *with* someone else's emoji would mean publishing
 * a kind-7 carrying their `emoji` tag, and this row does not own a publish path. A
 * clickable chip that did nothing would be worse than a static one — the same rule
 * the overflow menu follows.
 */
function ReactionChip({ group }: { group: ReactionGroup }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5",
        "setu-mono text-2xs tabular-nums",
        group.viewerReacted
          ? "border-primary/60 bg-primary/10"
          : "border-border/60 bg-muted/40",
      )}
    >
      {group.imageUrl === undefined ? (
        <span aria-hidden className="text-sm leading-none">
          {group.label}
        </span>
      ) : (
        <CustomEmoji url={group.imageUrl} label={group.label} />
      )}
      <span className="text-muted-foreground">{group.count}</span>
      <span className="sr-only">
        {group.label}
        {group.viewerReacted ? ", including you" : ""}
      </span>
    </span>
  );
}
