import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  CountBadge,
  cn,
  ScrollArea,
  Sidebar,
  SidebarRow,
  SidebarSearchButton,
  SidebarSection,
  Tooltip,
} from "@setu/ui";
import {
  AtSign,
  Bell,
  Bookmark,
  BookOpen,
  Compass,
  Hash,
  Home,
  Image as ImageIcon,
  Info,
  Layers,
  MessageCircle,
  PenLine,
  PenSquare,
  Search,
  Settings,
  User,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { AccountMenu } from "../identity/AccountSwitcher";
import { useSession } from "../identity/SessionProvider";
import { useAuthors } from "../profiles/useAuthors";
import { type Route, sameRoute } from "./routes";

/**
 * Explore's tabs, mirrored into the sidebar.
 *
 * Kept in step with `ExploreScreen`'s `TAB_IDS` by hand rather than imported: the
 * sidebar lives in the shell and importing a screen's internals to render a nav
 * would make the shell depend on the surface it navigates to. A tab added there
 * and forgotten here is simply not listed — a missing shortcut, not a broken one.
 */
const EXPLORE_TABS: readonly {
  id: string;
  label: string;
  icon: ReactNode;
}[] = [
  { id: "feeds", label: "Feeds", icon: <Layers /> },
  { id: "people", label: "People", icon: <Users /> },
  { id: "packs", label: "Packs", icon: <UserPlus /> },
  { id: "communities", label: "Discover communities", icon: <UsersRound /> },
  { id: "zaps", label: "Zaps", icon: <Zap /> },
  { id: "media", label: "Media", icon: <ImageIcon /> },
  { id: "topics", label: "Topics", icon: <Hash /> },
];

export interface SetuSidebarProps {
  route: Route;
  onNavigate(route: Route): void;
  onOpenSearch(): void;
  onCompose(): void;
  unreadNotifications: number;
  /**
   * Conversations with an unread message.
   *
   * A real count, not a dot: the inbox is decrypted at the app root, so this is the
   * same number the conversation list marks bold rather than a guess made from the
   * gift wraps. See `unreadConversations.ts` for why nothing cheaper would be true.
   */
  unreadMessages: number;
  pinnedHashtags: readonly string[];
  onUnpinHashtag?(tag: string): void;
}

export function SetuSidebar({
  route,
  onNavigate,
  onOpenSearch,
  onCompose,
  unreadNotifications,
  unreadMessages,
  pinnedHashtags,
  onUnpinHashtag,
}: SetuSidebarProps) {
  const { session } = useSession();
  const [tagsOpen, setTagsOpen] = useState(true);
  const [exploreOpen, setExploreOpen] = useState(true);

  const authors = useAuthors(session ? [session.pubkey] : []);
  const me = session ? authors.get(session.pubkey) : undefined;

  return (
    <Sidebar>
      <div className="px-2 pt-1 pb-2">
        <SidebarSearchButton onClick={onOpenSearch}>
          <Search />
          <span>Search</span>
        </SidebarSearchButton>
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        <SidebarRow
          icon={<Home />}
          size="lg"
          active={sameRoute(route, { name: "home" })}
          onClick={() => onNavigate({ name: "home" })}
        >
          Home
        </SidebarRow>
        <SidebarRow
          icon={<Compass />}
          size="lg"
          active={sameRoute(route, { name: "explore" })}
          onClick={() => onNavigate({ name: "explore" })}
        >
          Explore
        </SidebarRow>
        <SidebarRow
          icon={<BookOpen />}
          size="lg"
          active={sameRoute(route, { name: "reads" })}
          onClick={() => onNavigate({ name: "reads" })}
        >
          Reads
        </SidebarRow>
        <SidebarRow
          icon={<PenLine />}
          size="lg"
          active={sameRoute(route, { name: "articles" })}
          onClick={() => onNavigate({ name: "articles" })}
        >
          Articles
        </SidebarRow>
        <SidebarRow
          icon={<MessageCircle />}
          size="lg"
          active={sameRoute(route, { name: "messages" })}
          onClick={() => onNavigate({ name: "messages" })}
          trailing={<CountBadge count={unreadMessages} />}
        >
          Messages
        </SidebarRow>
        <SidebarRow
          icon={<Bell />}
          size="lg"
          active={sameRoute(route, { name: "notifications" })}
          onClick={() => onNavigate({ name: "notifications" })}
          trailing={<CountBadge count={unreadNotifications} />}
        >
          Notifications
        </SidebarRow>
        <SidebarRow
          icon={<AtSign />}
          size="lg"
          active={sameRoute(route, { name: "mentions" })}
          onClick={() => onNavigate({ name: "mentions" })}
        >
          Mentions
        </SidebarRow>
        <SidebarRow
          icon={<Bookmark />}
          size="lg"
          active={sameRoute(route, { name: "bookmarks" })}
          onClick={() => onNavigate({ name: "bookmarks" })}
        >
          Bookmarks
        </SidebarRow>
        {/* The communities you are in. Discovery lives under Explore; this row is
            the ones you joined — the same split Wallet has, and the reason it is
            not a second door to the browse list. */}
        <SidebarRow
          icon={<UsersRound />}
          size="lg"
          active={sameRoute(route, { name: "communities" })}
          onClick={() => onNavigate({ name: "communities" })}
        >
          Communities
        </SidebarRow>
        {/* A destination of its own rather than a panel inside Settings. A wallet is
            something you check, not something you configure once — and a balance
            buried three scrolls into a settings page is a balance nobody looks at. */}
        <SidebarRow
          icon={<Wallet />}
          size="lg"
          active={sameRoute(route, { name: "wallet" })}
          onClick={() => onNavigate({ name: "wallet" })}
        >
          Wallet
        </SidebarRow>
        {session ? (
          <SidebarRow
            icon={<User />}
            size="lg"
            active={sameRoute(route, {
              name: "profile",
              pubkey: session.pubkey,
            })}
            onClick={() =>
              onNavigate({ name: "profile", pubkey: session.pubkey })
            }
          >
            Profile
          </SidebarRow>
        ) : null}
      </nav>

      {/* The primary action gets its own block so it never scrolls out of reach. */}
      <div className="px-2 py-3">
        {/* A filled primary button at reduced opacity still reads as available.
            When the session cannot sign, drop to `outline` so the affordance
            looks unavailable rather than merely dimmed. */}
        <Button
          variant={session?.canSign ? "default" : "outline"}
          size="default"
          className="w-full font-semibold"
          onClick={onCompose}
          disabled={!session?.canSign}
          title={
            session?.canSign
              ? undefined
              : "This session cannot sign. Sign in with a key to post."
          }
        >
          <PenSquare />
          New note
        </Button>
      </div>

      <ScrollArea className="px-2">
        {/*
         * Explore's tabs, listed.
         *
         * Seven discovery surfaces used to sit behind one nav row with nothing to
         * say they existed — a reader had to open Explore and notice a tab strip.
         * Listing them here costs one collapsible section and makes them
         * findable; each entry deep-links straight to its tab rather than
         * dropping the reader on Feeds to hunt for it.
         */}
        <SidebarSection
          label="Explore"
          open={exploreOpen}
          onToggle={() => setExploreOpen((v) => !v)}
        >
          {EXPLORE_TABS.map((entry) => (
            <SidebarRow
              key={entry.id}
              icon={entry.icon}
              active={sameRoute(route, { name: "explore", tab: entry.id })}
              onClick={() => onNavigate({ name: "explore", tab: entry.id })}
            >
              {entry.label}
            </SidebarRow>
          ))}
        </SidebarSection>

        {pinnedHashtags.length > 0 ? (
          <SidebarSection
            label="Hashtags"
            open={tagsOpen}
            onToggle={() => setTagsOpen((v) => !v)}
          >
            {pinnedHashtags.map((tag) => (
              // The unpin control is a *sibling* of the row, not a child: a
              // button inside a button is invalid HTML, and browsers resolve it
              // by dropping one of the two click targets.
              <div key={tag} className="group/pin relative">
                <SidebarRow
                  icon={<Hash />}
                  active={sameRoute(route, { name: "hashtag", tag })}
                  onClick={() => onNavigate({ name: "hashtag", tag })}
                  className={onUnpinHashtag ? "pr-7" : undefined}
                >
                  {tag}
                </SidebarRow>
                {onUnpinHashtag ? (
                  <button
                    type="button"
                    aria-label={`Unpin #${tag}`}
                    onClick={() => onUnpinHashtag(tag)}
                    className={cn(
                      "absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5",
                      "text-muted-foreground opacity-0 transition-opacity",
                      "group-hover/pin:opacity-100 focus-visible:opacity-100",
                      "hover:text-foreground focus-visible:outline-hidden",
                    )}
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </div>
            ))}
          </SidebarSection>
        ) : null}
      </ScrollArea>

      <div className="mt-auto flex items-center gap-2 px-3 py-2">
        {session ? (
          <>
            <button
              type="button"
              aria-label="Open your profile"
              onClick={() =>
                onNavigate({ name: "profile", pubkey: session.pubkey })
              }
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <Avatar className="size-7 shrink-0">
                {me?.avatarUrl ? (
                  <AvatarImage src={me.avatarUrl} alt="" />
                ) : null}
                <AvatarFallback>
                  {(me?.displayName ?? "?").slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {me?.displayName ?? "you"}
                </span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {session.canSign ? me?.handle : "read-only"}
                </span>
              </span>
            </button>
            {/* The account menu replaced a bare sign-out button. A single
                sign-out control was the only way to leave an account, and it
                erases that account's cached notes and read state — so "I want to
                use my other identity for a minute" and "remove me from this
                computer" were the same click. They are now separate items with
                separate wording, and switching is the cheap one. */}
            <AccountMenu />
          </>
        ) : (
          <span className="flex-1 text-xs text-muted-foreground">
            Not signed in
          </span>
        )}
        {/* Beside Settings rather than inside it. Who made this, and how to support
            it, is not a preference — and at the bottom of a settings page it was
            reachable only by someone already scrolling for something else. */}
        <Tooltip label="About Setu">
          <Button
            variant="chrome"
            size="icon-xs"
            aria-label="About Setu"
            onClick={() => onNavigate({ name: "about" })}
          >
            <Info />
          </Button>
        </Tooltip>
        <Tooltip label="Settings">
          <Button
            variant="chrome"
            size="icon-xs"
            aria-label="Settings"
            onClick={() => onNavigate({ name: "settings" })}
          >
            <Settings />
          </Button>
        </Tooltip>
      </div>
    </Sidebar>
  );
}
