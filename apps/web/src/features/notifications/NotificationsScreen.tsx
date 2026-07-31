import {
  ContentHeader,
  EmptyState,
  ScrollArea,
  Skeleton,
  type TabDefinition,
  TabList,
  tabPanelProps,
} from "@setu/ui";
import { AtSign, Bell, Heart, Inbox, Repeat2, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuthors } from "../profiles/useAuthors";
import {
  filterByKind,
  type NotificationItem,
  type NotificationKind,
} from "./groupNotifications";
import { NotificationRow } from "./NotificationRow";
import { useMarkNotificationsRead } from "./readState";
import { useNotifications } from "./useNotifications";

/**
 * Notifications.
 *
 * Every row on this screen is derived from events this client holds and verified —
 * there is no "N people liked this" figure sourced from anywhere else, and a row
 * whose target we do not hold says so instead of describing it. That is the same
 * rule Explore is built on, and it is why the grouping lives in a pure module with
 * its own tests rather than inside this component.
 */

const TAB_IDS = ["all", "mentions", "reactions", "zaps", "reposts"] as const;
type TabId = (typeof TAB_IDS)[number];

const TABS: readonly TabDefinition[] = [
  { id: "all", label: "All", icon: <Bell /> },
  { id: "mentions", label: "Mentions", icon: <AtSign /> },
  { id: "reactions", label: "Reactions", icon: <Heart /> },
  { id: "zaps", label: "Zaps", icon: <Zap /> },
  { id: "reposts", label: "Reposts", icon: <Repeat2 /> },
];

const ID_PREFIX = "notifications";

/**
 * Which notification kinds each tab shows.
 *
 * "Mentions" covers replies as well as bare mentions: both are somebody writing
 * to you, and splitting them would put an answer to your note in a tab a reader
 * has no reason to open.
 */
const TAB_KINDS: Record<TabId, readonly NotificationKind[]> = {
  all: ["reply", "mention", "reaction", "repost", "zap"],
  mentions: ["reply", "mention"],
  reactions: ["reaction"],
  zaps: ["zap"],
  reposts: ["repost"],
};

const EMPTY_CATEGORY: Record<TabId, string> = {
  all: "No notifications yet",
  mentions: "Nobody has replied to or mentioned you yet",
  reactions: "No reactions yet",
  zaps: "No zaps yet",
  reposts: "No reposts yet",
};

/** How many rows get author metadata resolved. */
const METADATA_WINDOW = 40;

function isTabId(value: string): value is TabId {
  return (TAB_IDS as readonly string[]).includes(value);
}

/** Distinct actor pubkeys across a page of rows. */
function actorPubkeys(items: readonly NotificationItem[]): string[] {
  const set = new Set<string>();
  for (const item of items.slice(0, METADATA_WINDOW)) {
    for (const actor of item.actors) {
      if (actor.pubkey) set.add(actor.pubkey);
    }
  }
  return [...set];
}

function LoadingRows() {
  return (
    <div className="flex flex-col">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="border-b border-border/50 px-4 py-3">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="mt-2 h-3 w-56" />
        </div>
      ))}
    </div>
  );
}

export interface NotificationsScreenProps {
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}

export function NotificationsScreen({
  onOpenThread,
  onOpenProfile,
}: NotificationsScreenProps): React.JSX.Element {
  const { items, loading, signedIn } = useNotifications();
  const [tab, setTab] = useState<TabId>("all");
  const markRead = useMarkNotificationsRead();

  const visible = useMemo(
    () => filterByKind(items, TAB_KINDS[tab]),
    [items, tab],
  );

  const pubkeys = useMemo(() => actorPubkeys(visible), [visible]);
  const authors = useAuthors(pubkeys);

  // Marked read on view, through the newest row actually rendered rather than
  // through "now": the watermark should only cover notifications the reader could
  // have seen, and relays routinely deliver an event minutes after its
  // `created_at`.
  const newest = items[0]?.createdAt;
  useEffect(() => {
    if (!signedIn) return;
    markRead(newest);
  }, [signedIn, newest, markRead]);

  const body = (): React.JSX.Element => {
    if (!signedIn) {
      return (
        <EmptyState
          icon={<Bell className="size-6" />}
          title="Sign in to see your notifications"
          description="Notifications are events addressed to your public key, so there is nothing to fetch until this client knows which key that is."
        />
      );
    }
    if (loading && items.length === 0) return <LoadingRows />;
    if (items.length === 0) {
      return (
        <EmptyState
          icon={<Inbox className="size-6" />}
          title="Nothing addressed to you yet"
          description="Replies, mentions, reactions, reposts and zap receipts that tag your key will appear here. If this stays empty, the relays in settings may not carry them — this screen shows only what reached this client."
        />
      );
    }
    if (visible.length === 0) {
      return (
        <EmptyState
          title={EMPTY_CATEGORY[tab]}
          description="You have other notifications — try the All tab."
        />
      );
    }
    return (
      <div className="flex flex-col">
        {visible.map((item) => (
          <NotificationRow
            key={item.key}
            item={item}
            authors={authors}
            onOpenThread={onOpenThread}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContentHeader className="justify-start">
        <TabList
          tabs={TABS}
          value={tab}
          onChange={(id) => {
            if (isTabId(id)) setTab(id);
          }}
          label="Notification categories"
          idPrefix={ID_PREFIX}
        />
      </ContentHeader>

      <ScrollArea {...tabPanelProps(tab, ID_PREFIX)}>{body()}</ScrollArea>
    </div>
  );
}
