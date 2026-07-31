/**
 * View models for rendering.
 *
 * These are deliberately *not* Nostr events. The renderer takes flat, resolved
 * data — display name already picked, timestamp already a number, media already
 * extracted — so a note row never reaches back into a cache or a relay while
 * rendering. The alternative — a mutable graph node with reply/zap/boost sets
 * hanging off it — makes every render a potential mutation point, and a row's
 * output dependent on when it happened to be read.
 */

export interface AuthorView {
  readonly pubkey: string;
  readonly displayName: string;
  /**
   * False while this is a placeholder built from the pubkey alone.
   *
   * Rows must not present an unresolved author as if it were resolved: showing a
   * truncated npub and then replacing it with a real name a second later reads
   * as the client having got it wrong, and it makes every avatar row flicker on
   * load. A row with `resolved: false` should render a placeholder for the name
   * instead of the npub.
   */
  readonly resolved: boolean;
  /** NIP-05 identifier, or a truncated npub when there is none. */
  readonly handle: string;
  readonly avatarUrl?: string;
  /**
   * The raw NIP-05 identifier as published, when there is one. Kept separate
   * from `handle` because `handle` falls back to a truncated npub, and a
   * verifier must be able to tell a claim from a placeholder.
   */
  readonly nip05?: string;
  /**
   * True only after `/.well-known/nostr.json` on the author's own domain mapped
   * `nip05` back to `pubkey`. Never set from the profile's own claim — that
   * would make the badge mean "this author typed a domain name".
   */
  readonly verified?: boolean;
  /**
   * The `lud16`/`lud06` field as published, when there is one.
   *
   * Carried on the author rather than resolved here because its *presence* is
   * what decides whether a row may offer a zap at all: a zap control on an author
   * who published no lightning address is a button that can only ever fail, and
   * the row needs to know that before it renders. The value is still untrusted —
   * `lnurl.ts` validates it before any request is made.
   */
  readonly lightning?: string;
}

export interface MediaView {
  readonly url: string;
  readonly kind: "image" | "video";
  /** Blurhash or thumbnail data URI, so layout does not jump on load. */
  readonly placeholder?: string;
  readonly alt?: string;
}

export interface NoteView {
  readonly id: string;
  /**
   * Stable identity for this *row*, distinct from the note's id.
   *
   * They differ, and conflating them is a real bug rather than a nicety. A note
   * can legitimately occupy two rows at once — once on its own, and once as the
   * target of someone's repost — and both rows carry the same `id` because `id`
   * identifies the note being displayed. Keying React on `id` therefore renders
   * two siblings with the same key, which React responds to by dropping or
   * duplicating one of them.
   *
   * The feed engine already computes the right value (`FeedEntry.key`:
   * `note:<id>` versus `repost:<target>:<anchor>`); this carries it through to
   * the view so the row keeps its identity across updates.
   */
  readonly rowKey: string;
  readonly author: AuthorView;
  readonly createdAt: number;
  readonly content: string;
  readonly media?: readonly MediaView[];
  readonly replyCount: number;
  readonly repostCount: number;
  readonly reactionCount: number;
  readonly zapSats: number;
  /**
   * True when the counts above are floors rather than totals.
   *
   * Relay queries for interactions are bounded, so a heavily discussed note can
   * have more than we were served. A row must render such a count as "500+" — a
   * number presented as exact when it is not is worse than an obviously
   * approximate one.
   */
  readonly countsApproximate?: boolean;
  /** Set when the viewer has already acted, so the button renders active. */
  readonly viewerReacted?: boolean;
  readonly viewerReposted?: boolean;
  /**
   * Populated when several reposts of one note collapse into a single row —
   * N reposts of the same target should not be N rows in the timeline.
   */
  readonly repostedBy?: readonly AuthorView[];
  /** NIP-36 reason. Presence means the body renders blurred until revealed. */
  readonly contentWarning?: string;
  /** Author + id of the note this one replies to, for the context line. */
  readonly replyingTo?: { readonly id: string; readonly author: string };
  /** Arrived after first paint — triggers the blur-in arrival motion once. */
  readonly justArrived?: boolean;
}
