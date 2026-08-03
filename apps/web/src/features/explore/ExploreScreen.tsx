import type { FeedDefinition } from "@setu/core";
import {
  ContentHeader,
  ScrollArea,
  type TabDefinition,
  TabList,
  tabPanelProps,
} from "@setu/ui";
import {
  Hash,
  Image as ImageIcon,
  Layers,
  UserPlus,
  Users,
  UsersRound,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { CommunitiesTab } from "./CommunitiesTab";
import { FeedsTab } from "./FeedsTab";
import { MediaTab } from "./MediaTab";
import { PacksTab } from "./PacksTab";
import { PeopleTab } from "./PeopleTab";
import { TopicsTab } from "./TopicsTab";
import { ZapsTab } from "./ZapsTab";

/**
 * Explore.
 *
 * The one rule this screen is built around: **no number on it may be invented.**
 * Every count comes from `EventStore.count` or from a relay's own response, and
 * every heading names the scope it applies to — "your local index", "in your
 * feed". There is no global "N users" or "N zaps" figure anywhere, because Setu
 * runs no indexer and a relay can only speak for its own contents. Displaying a
 * network-wide counter would mean either trusting a third party for it or making
 * it up, and both are worse than not showing it.
 *
 * Consequently each tab is a projection of the local store, and each empty state
 * distinguishes "nothing indexed yet" from "nothing matched what we hold" — a
 * reader has to be able to tell a broken client from a quiet one.
 */

const TAB_IDS = [
  "feeds",
  "people",
  "packs",
  "communities",
  "zaps",
  "media",
  "topics",
] as const;
type TabId = (typeof TAB_IDS)[number];

const TABS: readonly TabDefinition[] = [
  { id: "feeds", label: "Feeds", icon: <Layers /> },
  { id: "people", label: "People", icon: <Users /> },
  // First after Feeds among the people-finding tabs: it is the only one that
  // turns an empty follow list into a populated feed in a single action.
  { id: "packs", label: "Packs", icon: <UserPlus /> },
  { id: "communities", label: "Communities", icon: <UsersRound /> },
  { id: "zaps", label: "Zaps", icon: <Zap /> },
  { id: "media", label: "Media", icon: <ImageIcon /> },
  { id: "topics", label: "Topics", icon: <Hash /> },
];

const ID_PREFIX = "explore";

function isTabId(value: string): value is TabId {
  return (TAB_IDS as readonly string[]).includes(value);
}

export interface ExploreScreenProps {
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
  onOpenCommunity?(address: string): void;
  onOpenFeed?(definition: FeedDefinition, label: string): void;
}

export function ExploreScreen({
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
  onOpenFeed,
  onOpenCommunity,
}: ExploreScreenProps) {
  const engine = useEngine();
  const [tab, setTab] = useState<TabId>("feeds");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContentHeader className="justify-start">
        <TabList
          tabs={TABS}
          value={tab}
          onChange={(id) => {
            if (isTabId(id)) setTab(id);
          }}
          label="Explore sections"
          idPrefix={ID_PREFIX}
        />
      </ContentHeader>

      {/* One panel mounted at a time. Each tab owns a live store observer and,
          on Explore, a relay subscription; keeping five alive would spend five
          subscription slots on four screens nobody is reading. */}
      <ScrollArea {...tabPanelProps(tab, ID_PREFIX)}>
        {tab === "feeds" ? (
          <FeedsTab relays={engine.relays} onOpenFeed={onOpenFeed} />
        ) : null}
        {tab === "people" ? <PeopleTab onOpenProfile={onOpenProfile} /> : null}
        {tab === "packs" ? <PacksTab onOpenProfile={onOpenProfile} /> : null}
        {tab === "communities" && onOpenCommunity ? (
          <CommunitiesTab onOpenCommunity={onOpenCommunity} />
        ) : null}
        {tab === "zaps" ? (
          <ZapsTab onOpenThread={onOpenThread} onOpenProfile={onOpenProfile} />
        ) : null}
        {tab === "media" ? <MediaTab onOpenThread={onOpenThread} /> : null}
        {tab === "topics" ? <TopicsTab onOpenHashtag={onOpenHashtag} /> : null}
      </ScrollArea>
    </div>
  );
}
