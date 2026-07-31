/**
 * Route model.
 *
 * A plain discriminated union rather than a router: the shell has one content
 * pane and one auxiliary pane, and every destination is describable in a few
 * fields. A URL-backed router lands with the desktop shell, when deep links
 * (`nostr:` handlers) need real addresses.
 */

export type Route =
  | { readonly name: "home" }
  | { readonly name: "explore" }
  | { readonly name: "reads" }
  | { readonly name: "messages" }
  | { readonly name: "articles" }
  | { readonly name: "notifications" }
  | { readonly name: "mentions" }
  | { readonly name: "bookmarks" }
  | { readonly name: "hashtag"; readonly tag: string }
  | { readonly name: "profile"; readonly pubkey: string }
  | { readonly name: "settings" };

export const ROUTE_TITLES: Record<Route["name"], string> = {
  home: "Home",
  explore: "Explore",
  reads: "Reads",
  messages: "Messages",
  articles: "Articles",
  notifications: "Notifications",
  mentions: "Mentions",
  bookmarks: "Bookmarks",
  hashtag: "Hashtag",
  profile: "Profile",
  settings: "Settings",
};

export function routeTitle(route: Route): string {
  if (route.name === "hashtag") return `#${route.tag}`;
  return ROUTE_TITLES[route.name];
}

/** True when two routes address the same destination, for nav highlighting. */
export function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === "hashtag" && b.name === "hashtag") return a.tag === b.tag;
  if (a.name === "profile" && b.name === "profile")
    return a.pubkey === b.pubkey;
  return true;
}
