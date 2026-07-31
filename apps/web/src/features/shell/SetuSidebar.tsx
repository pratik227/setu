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
  MessageCircle,
  PenLine,
  PenSquare,
  Search,
  Settings,
  User,
  X,
} from "lucide-react";
import { useState } from "react";
import { AccountMenu } from "../identity/AccountSwitcher";
import { useSession } from "../identity/SessionProvider";
import { useAuthors } from "../profiles/useAuthors";
import { type Route, sameRoute } from "./routes";

export interface SetuSidebarProps {
  route: Route;
  onNavigate(route: Route): void;
  onOpenSearch(): void;
  onCompose(): void;
  unreadNotifications: number;
  pinnedHashtags: readonly string[];
  onUnpinHashtag?(tag: string): void;
}

export function SetuSidebar({
  route,
  onNavigate,
  onOpenSearch,
  onCompose,
  unreadNotifications,
  pinnedHashtags,
  onUnpinHashtag,
}: SetuSidebarProps) {
  const { session } = useSession();
  const [tagsOpen, setTagsOpen] = useState(true);

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
