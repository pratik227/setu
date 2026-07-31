import type { FeedDefinition } from "@setu/core";
import {
  AppShell,
  AuxiliaryPanel,
  Button,
  ContentHeader,
  ContentSurface,
  cn,
  EmptyState,
  SetuLogo,
  ShellBody,
  Tooltip,
  TopChrome,
  useTheme,
} from "@setu/ui";
import { ChevronLeft, ChevronRight, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_RELAYS } from "../engine/EngineProvider";
import { ArticlesScreen } from "../features/articles/ArticlesScreen";
import { ReadsScreen } from "../features/articles/ReadsScreen";
import { ChatScreen } from "../features/chat/ChatScreen";
import { ComposeDialog } from "../features/compose/ComposeDialog";
import { DiscoverPanel } from "../features/discover/DiscoverPanel";
import { ExploreScreen } from "../features/explore/ExploreScreen";
import { FeedPicker } from "../features/feed/FeedPicker";
import {
  type HomeFeedId,
  homeFeedDefinition,
  NOTE_KINDS,
} from "../features/feed/homeFeeds";
import { LiveFeed } from "../features/feed/LiveFeed";
import { LoginScreen, UnlockDialog } from "../features/identity/LoginScreen";
import { useSession } from "../features/identity/SessionProvider";
import { useFollowAction } from "../features/identity/useFollowAction";
import { useFollows } from "../features/identity/useFollows";
import { BookmarksScreen } from "../features/notes/BookmarksScreen";
import { MentionsScreen } from "../features/notifications/MentionsScreen";
import { NotificationsScreen } from "../features/notifications/NotificationsScreen";
import { useUnreadCount } from "../features/notifications/readState";
import { ProfileScreen } from "../features/profile/ProfileScreen";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import { type Route, routeTitle } from "../features/shell/routes";
import { SetuSidebar } from "../features/shell/SetuSidebar";
import { ThreadView } from "../features/thread/ThreadView";
import { useNavigation } from "./useNavigation";

function ThemeToggle() {
  const { isDark, setMode } = useTheme();
  return (
    <Tooltip
      label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      side="bottom"
    >
      <Button
        variant="chrome"
        size="icon"
        aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
        onClick={() => setMode(isDark ? "light" : "dark")}
        className="setu-no-drag"
      >
        {isDark ? <Sun /> : <Moon />}
      </Button>
    </Tooltip>
  );
}

/**
 * The Home timeline.
 *
 * The default is the follow feed, not the global one. Global used to be the
 * default on the reasoning that an empty "Following" tab is indistinguishable
 * from following nobody — true, but the fix for that is to say which one it is,
 * which the empty state now does, rather than to open the firehose for every
 * reader on every launch. A follow feed is author-scoped and outbox-routed; the
 * global feed is neither, and it was costing thousands of events a minute to show
 * a reader notes from strangers they never asked for.
 *
 * See `homeFeeds.ts` for what each option actually fetches.
 */
function HomeFeed({
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
}: {
  onOpenThread(id: string): void;
  onOpenProfile(pubkey: string): void;
  onOpenHashtag(tag: string): void;
}) {
  const follows = useFollows();
  const [feedId, setFeedId] = useState<HomeFeedId>("latest");

  // Pinned at mount. A `since` recomputed every render would change the filter
  // identity every render, tearing the subscription down and rebuilding it — the
  // exact churn the bounded feed exists to avoid.
  const mountedAt = useRef(Math.floor(Date.now() / 1000));

  const definition = useMemo(
    () =>
      homeFeedDefinition({
        id: feedId,
        followedAuthors: follows.authors,
        relays: DEFAULT_RELAYS,
        now: mountedAt.current,
      }),
    [feedId, follows.authors],
  );

  // `undefined` means a follow-scoped feed with no follows to scope to. Never
  // substitute the global feed here: the reader asked for their follows.
  const awaitingFollows = definition === undefined;

  return (
    <>
      <div className="setu-feed-column flex items-center border-b border-border/50 px-4 py-1">
        <FeedPicker value={feedId} onChange={setFeedId} />
      </div>
      {awaitingFollows ? (
        <EmptyState
          title={
            follows.loaded
              ? "You are not following anyone yet"
              : "Loading your follow list"
          }
          description={
            follows.loaded
              ? "Find people on Explore, and their notes will appear here. Global · 24h shows the wider network in the meantime."
              : "Fetching your follows from the relays."
          }
        />
      ) : (
        <LiveFeed
          definition={definition}
          onOpenThread={onOpenThread}
          onOpenProfile={onOpenProfile}
          onOpenHashtag={onOpenHashtag}
          emptyTitle="No notes yet"
        />
      )}
    </>
  );
}

/** Routes whose screen owns the whole surface rather than a reading column. */
const FULL_WIDTH_ROUTES = new Set<Route["name"]>(["messages", "articles"]);

export function App() {
  const { session, locked } = useSession();
  const follows = useFollows();
  const followAction = useFollowAction();
  const unread = useUnreadCount();
  const nav = useNavigation();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  /*
   * Raise the unlock dialog when an identity is locked.
   *
   * Keyed on `locked` so re-locking (a signer that stopped answering) raises it
   * again, while dismissing it stays dismissed — the effect does not re-fire
   * until the lock state itself changes. Reading works throughout; this is only
   * about being able to sign.
   */
  useEffect(() => {
    if (locked) setUnlocking(true);
  }, [locked]);
  const [customFeed, setCustomFeed] = useState<
    { definition: FeedDefinition; label: string } | undefined
  >();

  const { route } = nav;

  const openThread = useCallback((id: string) => setThreadId(id), []);

  /*
   * A thread closes when you navigate away from the surface you opened it on.
   *
   * Hiding it on one route was not enough. The thread is context for a specific
   * note in a specific feed, so leaving it mounted meant going Home → Profile →
   * Home brought back a thread from ten minutes ago, and going to Messages left
   * a feed thread sitting beside a private conversation until you noticed and
   * closed it by hand. Closing is what "I went somewhere else" means.
   */
  const routeKey = `${route.name}:${
    route.name === "profile"
      ? route.pubkey
      : route.name === "hashtag"
        ? route.tag
        : ""
  }`;
  const lastRoute = useRef(routeKey);
  useEffect(() => {
    if (lastRoute.current === routeKey) return;
    lastRoute.current = routeKey;
    setThreadId(null);
  }, [routeKey]);
  const openProfile = useCallback(
    (pubkey: string) => nav.go({ name: "profile", pubkey }),
    [nav],
  );
  const openHashtag = useCallback(
    (tag: string) => nav.go({ name: "hashtag", tag }),
    [nav],
  );

  return (
    <AppShell>
      <TopChrome>
        <div className="setu-no-drag flex items-center gap-0.5">
          <Tooltip label="Back" side="bottom">
            <Button
              variant="chrome"
              size="icon-xs"
              aria-label="Back"
              disabled={!nav.canGoBack}
              onClick={nav.back}
            >
              <ChevronLeft />
            </Button>
          </Tooltip>
          <Tooltip label="Forward" side="bottom">
            <Button
              variant="chrome"
              size="icon-xs"
              aria-label="Forward"
              disabled={!nav.canGoForward}
              onClick={nav.forward}
            >
              <ChevronRight />
            </Button>
          </Tooltip>
        </div>
        <SetuLogo />
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </TopChrome>

      <ShellBody>
        <SetuSidebar
          route={route}
          onNavigate={nav.go}
          onOpenSearch={() => nav.go({ name: "explore" })}
          // Locked means the composer cannot publish. Sending the reader to the
          // unlock dialog is the honest response to "I want to post"; opening a
          // composer that will fail at the last step is not.
          onCompose={() => (locked ? setUnlocking(true) : setComposing(true))}
          unreadNotifications={unread}
          pinnedHashtags={nav.pinnedHashtags}
          onUnpinHashtag={nav.unpinHashtag}
        />

        <ContentSurface>
          {!session ? (
            <LoginScreen />
          ) : (
            <>
              {/* `setu-feed-column` centres the title over a 46rem measure,
                  which is right above a timeline and wrong above a full-width
                  surface — on Messages it floated the word into the middle of
                  the screen, detached from the panes below it. */}
              <ContentHeader>
                <div
                  className={cn(
                    "flex items-center gap-2",
                    FULL_WIDTH_ROUTES.has(route.name)
                      ? "w-full px-4"
                      : "setu-feed-column",
                  )}
                >
                  <h1 className="text-sm font-semibold">{routeTitle(route)}</h1>
                </div>
              </ContentHeader>

              {route.name === "notifications" ? (
                <NotificationsScreen
                  onOpenThread={openThread}
                  onOpenProfile={openProfile}
                  onOpenHashtag={openHashtag}
                />
              ) : route.name === "mentions" ? (
                <MentionsScreen
                  onOpenThread={openThread}
                  onOpenProfile={openProfile}
                  onOpenHashtag={openHashtag}
                />
              ) : route.name === "articles" ? (
                <ArticlesScreen
                  onOpenProfile={openProfile}
                  onOpenHashtag={openHashtag}
                />
              ) : route.name === "explore" ? (
                <ExploreScreen
                  onOpenThread={openThread}
                  onOpenProfile={openProfile}
                  onOpenHashtag={openHashtag}
                  onOpenFeed={(definition, label) => {
                    setCustomFeed({ definition, label });
                    nav.go({ name: "home" });
                  }}
                />
              ) : route.name === "home" && customFeed ? (
                <>
                  <div className="setu-feed-column flex items-center gap-2 border-b border-border/50 px-4 py-2">
                    <span className="text-sm font-semibold">
                      {customFeed.label}
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="ml-auto"
                      onClick={() => setCustomFeed(undefined)}
                    >
                      Back to Home
                    </Button>
                  </div>
                  <LiveFeed
                    definition={customFeed.definition}
                    onOpenThread={openThread}
                    onOpenProfile={openProfile}
                    onOpenHashtag={openHashtag}
                    emptyTitle={`Nothing in ${customFeed.label} yet`}
                  />
                </>
              ) : route.name === "home" ? (
                <HomeFeed
                  onOpenThread={openThread}
                  onOpenProfile={openProfile}
                  onOpenHashtag={openHashtag}
                />
              ) : route.name === "hashtag" ? (
                <LiveFeed
                  definition={{
                    kinds: NOTE_KINDS,
                    hashtags: [route.tag],
                    relays: DEFAULT_RELAYS,
                  }}
                  onOpenThread={openThread}
                  onOpenProfile={openProfile}
                  onOpenHashtag={openHashtag}
                  emptyTitle={`Nothing tagged #${route.tag}`}
                />
              ) : route.name === "profile" ? (
                <ProfileScreen
                  pubkey={route.pubkey}
                  onOpenThread={openThread}
                  onOpenProfile={openProfile}
                  onOpenHashtag={openHashtag}
                  following={
                    follows.loaded
                      ? follows.authors.includes(route.pubkey)
                      : undefined
                  }
                  {...(session.canSign
                    ? {
                        onToggleFollow: (pubkey: string) => {
                          void followAction.toggle(
                            pubkey,
                            follows.authors.includes(pubkey),
                          );
                        },
                      }
                    : {})}
                  {...(followAction.state.status === "error"
                    ? { followError: followAction.state.message }
                    : {})}
                  followBusy={followAction.state.status === "working"}
                />
              ) : route.name === "settings" ? (
                <SettingsScreen />
              ) : route.name === "messages" ? (
                <ChatScreen onOpenProfile={openProfile} />
              ) : route.name === "bookmarks" ? (
                <BookmarksScreen
                  onOpenThread={openThread}
                  onOpenProfile={openProfile}
                  onOpenHashtag={openHashtag}
                />
              ) : route.name === "reads" ? (
                <ReadsScreen
                  relays={DEFAULT_RELAYS}
                  onOpenProfile={openProfile}
                  onOpenHashtag={openHashtag}
                />
              ) : (
                <EmptyState
                  title={`${routeTitle(route)} is not built yet`}
                  description="The shell, identity and publishing are in place; this surface is next."
                />
              )}
            </>
          )}
        </ContentSurface>

        {/* Rendered only when it has something to hold. An always-mounted panel
            shows its border and left rule around empty space, which reads as a
            column that failed to load. */}
        {/* Chat and Settings are full-width surfaces that own their own layout,
            so no third column beside them. Threads close on navigation anyway
            (see `openThread`); this is about the discover panel, which would
            otherwise squeeze the conversation list into a sliver. */}
        <AuxiliaryPanel>
          {FULL_WIDTH_ROUTES.has(route.name) ? null : threadId ? (
            <ThreadView
              noteId={threadId}
              onClose={() => setThreadId(null)}
              onOpenProfile={openProfile}
              onOpenHashtag={openHashtag}
              onOpenThread={openThread}
            />
          ) : session ? (
            <DiscoverPanel
              onOpenProfile={openProfile}
              onOpenHashtag={openHashtag}
            />
          ) : null}
        </AuxiliaryPanel>
      </ShellBody>

      {/* One dialog for the whole app rather than one per surface: the composer
          holds a draft, and two of them means two drafts that can disagree. */}
      <ComposeDialog open={composing} onOpenChange={setComposing} />
      <UnlockDialog open={unlocking} onOpenChange={setUnlocking} />
    </AppShell>
  );
}
