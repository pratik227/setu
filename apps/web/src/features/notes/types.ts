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
  /**
   * Intrinsic pixel size the author declared in a NIP-92 `imeta` tag.
   *
   * Present only when the declared `dim` parsed as a usable pair — see
   * `parseDim`. It exists so the row can reserve the box *before* the image
   * loads: with no reservation every row below an image moves down the moment it
   * decodes, once per image, and a timeline being read jumps under the reader.
   *
   * Still untrusted. These are the numbers the author typed, not measurements, so
   * the renderer clamps the ratio it builds from them rather than trusting the
   * shape (`reservedAspectRatio` in `noteMediaViews.ts`).
   */
  readonly width?: number;
  readonly height?: number;
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
  /**
   * The displayed event's kind.
   *
   * Carried because several rendering rules are decided by it and cannot be
   * derived from anything else on this object: a NIP-68 picture and a NIP-71 video
   * put their media *before* the text rather than after it, and a NIP-88 poll
   * renders a ballot instead of a body. A scalar, so it costs the row's
   * memoisation nothing.
   */
  readonly kind: number;
  /**
   * The displayed event's tags, exactly as it carried them.
   *
   * The row needs them, and passing them is the fix for two visible bugs: without
   * tags the tokenizer cannot resolve a deprecated NIP-08 `#[2]` mention, so old
   * notes render the literal characters `#[2]`, and a quote repost that carries
   * only a `q` tag has nothing to render at all.
   *
   * **This is the event's own array, never a copy.** Events are immutable, so the
   * same note always hands back the same array — which is what lets `sameView`
   * compare it by reference. Building a fresh array here (`[...source.tags]`)
   * would mark every row changed on every store tick and destroy the row
   * memoisation for the entire feed.
   */
  readonly tags: readonly (readonly string[])[];
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
  /**
   * How many interactions the reader's own mute list removed from the counts above.
   *
   * Absent rather than `0` when nothing was removed. Carried because a count that
   * quietly got smaller is indistinguishable from a bug: a note with three visible
   * answers showing "3 replies" when the reader remembers twelve reads as lost data,
   * while the same number with "9 not counted — your mute list" reads as the rule
   * working. One figure across replies, reposts and reactions together; a per-kind
   * breakdown would be a list of who the reader muted, which they did not ask for.
   */
  readonly countsMutedOut?: number;
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
