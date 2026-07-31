import type { FeedDefinition } from "@setu/core";
import { ScrollArea, TabList, tabPanelProps } from "@setu/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { LiveFeed } from "../feed/LiveFeed";
import { useSession } from "../identity/SessionProvider";
import { useProfileDetails } from "../profiles/useProfileDetails";
import { ProfileHeader } from "./ProfileHeader";
import { findProfileTab, PROFILE_TABS, type ProfileTabId } from "./profileTabs";
import { useAuthorCounts } from "./useAuthorCounts";
import { useAuthorRelays } from "./useAuthorRelays";
import { useLocalCounts } from "./useLocalCounts";

const TAB_ITEMS = PROFILE_TABS.map((tab) => ({ id: tab.id, label: tab.label }));

export interface ProfileScreenProps {
  pubkey: string;
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
  /**
   * Whether the signed-in account already follows this pubkey. Undefined means
   * the app has not resolved a follow list — which is not the same as "no".
   */
  following?: boolean;
  /**
   * Follow/unfollow handler. The button is rendered but disabled while this is
   * absent: writing kind 3 safely means re-fetching the newest list and merging
   * into it, and that belongs with the identity layer rather than here.
   */
  onToggleFollow?(pubkey: string): void;
  /**
   * Why the last follow edit was refused. Shown verbatim: a refusal here is
   * usually "we could not safely read your list", which the reader needs to see
   * rather than a silent no-op.
   */
  followError?: string;
  /** True while a follow edit is in flight. */
  followBusy?: boolean;
}

/**
 * An author's profile.
 *
 * The header and the tabs are three independent live queries — kind 0, kind
 * 10002 (via the outbox router), and the selected tab's feed — because they
 * arrive at wildly different times. A profile that waits for all three before
 * painting shows a blank screen for as long as the slowest relay takes.
 *
 * The four tabs share one `LiveFeed`, and therefore one feed engine: reposts
 * coalesce, `until` pagination works, and new notes stage behind a chip on every
 * tab without any of that being written four times. What differs per tab is a
 * kind list and, where a relay filter cannot express the rule, a row predicate —
 * both declared in `profileTabs`.
 */
export function ProfileScreen({
  pubkey,
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
  following,
  onToggleFollow,
  followError,
  followBusy,
}: ProfileScreenProps) {
  const { session } = useSession();
  const isSelf = session?.pubkey === pubkey;
  const [tabId, setTabId] = useState<ProfileTabId>("notes");
  const tab = findProfileTab(tabId);

  const { details, loaded } = useProfileDetails(pubkey);
  const counts = useLocalCounts(pubkey);
  // Real totals where a relay implements NIP-45; the local sample otherwise.
  const relayCounts = useAuthorCounts(pubkey);
  // Outbox routing: an author's events live on the author's write relays. The
  // router resolves them from the cached kind-10002 and falls back to the
  // engine's read set, so this is never empty.
  const relays = useAuthorRelays(pubkey);

  // `authors` is what enables per-author routing inside the feed engine as well,
  // so the definition carries both the resolved relays and the author.
  const definition = useMemo<FeedDefinition>(
    () => ({ kinds: [...tab.kinds], authors: [pubkey], relays }),
    [tab.kinds, pubkey, relays],
  );

  // One scroller for the whole profile: the header scrolls away and the tabs
  // stick. Pinning the header above its own scroller instead leaves the timeline
  // whatever space the header does not want — on a profile with a banner and a
  // bio that measured ~325px of feed under ~575px of chrome, which is not a
  // timeline. The feed runs in `embedded` mode so there is exactly one scroll
  // container, and it is handed this element so paging observes the right one.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useEffect(() => setScroller(scrollerRef.current), []);

  return (
    <ScrollArea ref={scrollerRef} className="block">
      {/* Header and tabs are siblings, not nested. A `sticky` element is only
          sticky while its own containing block is in view, so wrapping the tabs
          together with the header makes them scroll away with it — the tabs must
          sit directly in the scroller's content flow to pin against its top. */}
      <ProfileHeader
        pubkey={pubkey}
        details={details}
        loaded={loaded}
        counts={counts}
        relayCounts={relayCounts}
        isSelf={isSelf}
        {...(followError ? { followError } : {})}
        {...(followBusy ? { followBusy } : {})}
        {...(following !== undefined ? { following } : {})}
        {...(onToggleFollow ? { onToggleFollow } : {})}
        {...(onOpenHashtag ? { onOpenHashtag } : {})}
      />

      {/* Sticky so the reader can switch tabs without scrolling back up. */}
      <div className="setu-chrome-surface sticky top-0 z-10 border-b border-border/60 px-2 py-1.5">
        <TabList
          tabs={TAB_ITEMS}
          value={tabId}
          onChange={(id) => setTabId(findProfileTab(id).id)}
          label="Profile sections"
          idPrefix="profile"
        />
      </div>

      <div {...tabPanelProps(tabId, "profile")}>
        <LiveFeed
          // Remounting per tab is deliberate: each tab is a different feed
          // definition, and carrying the previous tab's rows into the new one
          // would show notes the new tab excludes until the first snapshot
          // arrives.
          key={tabId}
          definition={definition}
          {...(tab.entryFilter ? { entryFilter: tab.entryFilter } : {})}
          emptyTitle={tab.emptyTitle}
          emptyDescription={tab.emptyDescription}
          {...(onOpenThread ? { onOpenThread } : {})}
          {...(onOpenProfile ? { onOpenProfile } : {})}
          {...(onOpenHashtag ? { onOpenHashtag } : {})}
          embedded
          scrollRoot={scroller}
        />
      </div>
    </ScrollArea>
  );
}
