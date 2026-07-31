import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Card,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Panel,
  ScrollArea,
  SectionLabel,
  Skeleton,
} from "@setu/ui";
import { ChevronDown, Database } from "lucide-react";
import { useCallback } from "react";
import { compactCount } from "../notes/relativeTime";
import type { AuthorView } from "../notes/types";
import { setDeviceSettings, useDeviceSettings } from "../sync/localSettings";
import { TopicChips } from "./TopicChips";
import { useActiveAuthors } from "./useActiveAuthors";
import { type LocalStats, useLocalStats } from "./useLocalStats";
import { useTrendingTopics } from "./useTrendingTopics";

/**
 * The right-hand discovery column.
 *
 * Every number on this panel is measured on this device: counts from the local
 * event store and statuses from the relay pool. Nothing here is a network-wide
 * figure, and the headings say so — "in your feed", "on this device". That is not
 * modesty, it is the only claim the data supports, and a panel that rounded it up
 * to "trending on Nostr" would be inventing an indexer we do not have.
 */

function StatRow({
  label,
  value,
  ready,
}: {
  label: string;
  value: number;
  ready: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      {ready ? (
        <span className="shrink-0 text-sm font-semibold tabular-nums">
          {compactCount(value)}
        </span>
      ) : (
        <Skeleton className="h-3.5 w-10" />
      )}
    </div>
  );
}

function IndexStats({ stats }: { stats: LocalStats }) {
  const { relaysConnected, relaysFailed, relaysConfigured, ready } = stats;
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Database className="size-3.5 text-muted-foreground" />
        <SectionLabel className="px-0">On this device</SectionLabel>
      </div>
      <div className="flex flex-col gap-1.5">
        <StatRow label="Events held" value={stats.events} ready={ready} />
        <StatRow label="Notes" value={stats.notes} ready={ready} />
        <StatRow label="Profiles known" value={stats.profiles} ready={ready} />
        <StatRow label="Zap receipts" value={stats.zapReceipts} ready={ready} />
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 border-t border-border/60 pt-2.5">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            relaysConnected > 0 ? "bg-verified" : "bg-muted-foreground/50",
          )}
        />
        <span className="text-2xs text-muted-foreground">
          {relaysConnected}/{relaysConfigured} relays connected
          {relaysFailed > 0 ? `, ${relaysFailed} failed` : ""}
        </span>
      </div>
      <p className="mt-1.5 text-2xs text-muted-foreground/80">
        Counts are of events this client has received and verified — not
        network-wide totals.
      </p>
    </Card>
  );
}

function AuthorTile({
  author,
  count,
  onOpenProfile,
}: {
  author: AuthorView;
  count: number;
  onOpenProfile?(pubkey: string): void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenProfile?.(author.pubkey)}
      title={`${author.displayName} — ${count} ${
        count === 1 ? "note" : "notes"
      } in your local index`}
      className={cn(
        "flex min-w-0 flex-col items-center gap-1 rounded-md p-1",
        "transition-colors duration-(--motion-duration-instant) hover:bg-muted/60",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
      )}
    >
      <Avatar className="size-10">
        {author.avatarUrl ? (
          <AvatarImage src={author.avatarUrl} alt={author.displayName} />
        ) : null}
        <AvatarFallback>
          {author.displayName.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="w-full truncate text-center text-2xs">
        {author.displayName}
      </span>
    </button>
  );
}

export interface DiscoverPanelProps {
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}

/**
 * How far back the topic ranking looks.
 *
 * Filtering happens over the sample this device already holds, so changing the
 * window fetches nothing — a shorter window is strictly cheaper than a longer one
 * and answers "what is being talked about right now" instead of "at some point
 * this week".
 *
 * Named "Talked about", not "Trending". Trending is a ranking over everything
 * published and needs an indexer that has seen everything published; Setu has the
 * events a handful of relays handed this device. `ranking.ts` makes the same
 * point. The window label and the denominator are both shown so the claim is
 * always bounded on screen.
 */
interface TrendingWindow {
  readonly label: string;
  readonly seconds: number;
}

const TRENDING_WINDOWS: readonly TrendingWindow[] = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "4 hours", seconds: 4 * 60 * 60 },
  { label: "12 hours", seconds: 12 * 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
];

/**
 * A label for a window, listed or not.
 *
 * The picker offers four, but the *setting* is a number and syncs between devices, so
 * a build that lists different windows than the one that wrote the document will
 * arrive here with a value matching none of them. The window in effect is the one the
 * setting names, so it is labelled rather than rounded to the nearest option: showing
 * "12 hours" while filtering on six would make every count on the panel a claim about
 * a period the panel does not name.
 */
export function trendingWindowLabel(seconds: number): string {
  const listed = TRENDING_WINDOWS.find((option) => option.seconds === seconds);
  if (listed) return listed.label;
  if (seconds < 60) {
    const whole = Math.max(1, Math.round(seconds));
    return `${whole} ${whole === 1 ? "second" : "seconds"}`;
  }
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.round(seconds / 3600);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function TrendingWindowPicker({
  seconds,
  onChange,
}: {
  seconds: number;
  onChange(next: number): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="gap-1 text-muted-foreground data-[state=open]:bg-accent"
        >
          {trendingWindowLabel(seconds)}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {TRENDING_WINDOWS.map((option) => (
          <DropdownMenuItem
            key={option.seconds}
            onSelect={() => onChange(option.seconds)}
            className={option.seconds === seconds ? "font-semibold" : ""}
          >
            Last {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DiscoverPanel({
  onOpenProfile,
  onOpenHashtag,
}: DiscoverPanelProps) {
  const stats = useLocalStats();

  /*
   * The window is the synced setting, read and written directly.
   *
   * Previously pinned to `TRENDING_WINDOWS[2]` in local state, so the preference
   * Settings shows as synced never reached the panel it configures, and choosing a
   * window lasted until the next navigation away from Home.
   */
  const { trendingWindowSeconds } = useDeviceSettings();
  const setWindowSeconds = useCallback(
    (seconds: number) => setDeviceSettings({ trendingWindowSeconds: seconds }),
    [],
  );
  const windowLabel = trendingWindowLabel(trendingWindowSeconds);

  const { topics, sampleSize } = useTrendingTopics({
    limit: 10,
    windowSeconds: trendingWindowSeconds,
  });
  const { authors: activeAuthors } = useActiveAuthors({ limit: 8 });
  // Only authors whose kind-0 has arrived. A tile is an invitation to click, and
  // a truncated pubkey tells the reader nothing about whether they want to —
  // an unnamed tile is worse than one fewer tile.
  const authors = activeAuthors.filter((entry) => entry.author.resolved);

  return (
    <ScrollArea className="px-3 py-3">
      <div className="flex flex-col gap-4">
        <IndexStats stats={stats} />

        {/* Each section is its own bordered module so the column reads as
            distinct blocks rather than one long run of small text. The scope
            qualifier stays inside the module it applies to — a count separated
            from "in your local index" is a count that looks network-wide. */}
        <Panel
          title="Talked about"
          action={
            <TrendingWindowPicker
              seconds={trendingWindowSeconds}
              onChange={setWindowSeconds}
            />
          }
        >
          <div className="px-4 pb-3">
            {topics.length > 0 ? (
              <>
                <TopicChips topics={topics} onOpenHashtag={onOpenHashtag} />
                <p className="mt-2 text-2xs text-muted-foreground/80">
                  Across {sampleSize} {sampleSize === 1 ? "note" : "notes"} from
                  the last {windowLabel} in your local index.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                No hashtags from the last {windowLabel} in your index. Try a
                longer window, or open a feed to fill it.
              </p>
            )}
          </div>
        </Panel>

        <Panel title="Active in your feed">
          <div className="px-4 pb-3">
            {authors.length > 0 ? (
              <div className="grid grid-cols-4 gap-1">
                {authors.map((entry) => (
                  <AuthorTile
                    key={entry.author.pubkey}
                    author={entry.author}
                    count={entry.count}
                    onOpenProfile={onOpenProfile}
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {activeAuthors.length > 0
                  ? "Still loading names for the people in your feed."
                  : "Nobody indexed yet — this fills in as notes arrive."}
              </p>
            )}
          </div>
        </Panel>
      </div>
    </ScrollArea>
  );
}
