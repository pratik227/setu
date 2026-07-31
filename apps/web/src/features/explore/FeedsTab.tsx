import type { FeedDefinition } from "@setu/core";
import { Card, cn, EmptyState, SectionLabel } from "@setu/ui";
import {
  Globe,
  Hash,
  Highlighter,
  Images,
  Music,
  Radio,
  ScrollText,
  Server,
} from "lucide-react";
import type { ReactNode } from "react";
import { compactCount } from "../notes/relativeTime";
import {
  type CuratedFeed,
  curatedFeeds,
  type FeedIconKey,
  relayLabel,
} from "./curatedFeeds";
import { useDiscoveredFeeds } from "./useDiscoveredFeeds";
import { useFeedCounts } from "./useFeedCounts";

const ICONS: Record<FeedIconKey, ReactNode> = {
  globe: <Globe />,
  article: <ScrollText />,
  media: <Images />,
  music: <Music />,
  highlight: <Highlighter />,
  topic: <Hash />,
};

function FeedCard({
  feed,
  held,
  onOpen,
}: {
  feed: CuratedFeed;
  /** Matching events already in the local store; `undefined` until counted. */
  held: number | undefined;
  onOpen?(definition: FeedDefinition, label: string): void;
}) {
  return (
    <Card
      className={cn(
        "overflow-hidden transition-colors duration-(--motion-duration-instant)",
        "hover:border-border hover:bg-muted/30",
        "focus-within:ring-1 focus-within:ring-ring",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen?.(feed.definition, feed.name)}
        className="flex h-full w-full flex-col gap-2 p-3 text-left focus-visible:outline-hidden"
      >
        <span className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
            {ICONS[feed.icon]}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {feed.name}
          </span>
        </span>

        <span className="line-clamp-2 text-xs text-muted-foreground">
          {feed.description}
        </span>

        <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Server className="size-3" />
            {relayLabel(feed.definition.relays)}
          </span>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          {/* Not a like count and not a zap count: those are network-wide
              numbers we cannot compute. This is how much of the feed is already
              on this device. */}
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Radio className="size-3" />
            {held === undefined
              ? "counting…"
              : `${compactCount(held)} held locally`}
          </span>
        </span>
      </button>
    </Card>
  );
}

export interface FeedsTabProps {
  readonly relays: readonly string[];
  onOpenFeed?(definition: FeedDefinition, label: string): void;
}

export function FeedsTab({ relays, onOpenFeed }: FeedsTabProps) {
  const curated = curatedFeeds(relays);
  const discovered = useDiscoveredFeeds();
  const counts = useFeedCounts([...curated, ...discovered]);

  if (relays.length === 0) {
    return (
      <EmptyState
        icon={<Server className="size-6" />}
        title="No relays configured"
        description="A feed is a filter plus a relay set, and this client has no relays to ask. Add one in settings."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <section>
        <SectionLabel className="mb-2 px-0">Curated filters</SectionLabel>
        <div className="grid gap-2 sm:grid-cols-2">
          {curated.map((feed) => (
            <FeedCard
              key={feed.id}
              feed={feed}
              held={counts.get(feed.id)}
              onOpen={onOpenFeed}
            />
          ))}
        </div>
      </section>

      <section>
        <SectionLabel className="mb-2 px-0">
          Follow packs in your index
        </SectionLabel>
        {discovered.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {discovered.map((feed) => (
              <FeedCard
                key={feed.id}
                feed={feed}
                held={counts.get(feed.id)}
                onOpen={onOpenFeed}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No NIP-51 follow packs (kind 39089) have reached this client yet.
            They appear here as relays deliver them — packs are not ranked,
            since their popularity is not something a client can measure.
          </p>
        )}
      </section>
    </div>
  );
}
