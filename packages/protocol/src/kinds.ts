/**
 * Named event kinds and range predicates.
 *
 * Kinds are grouped in one frozen object rather than scattered magic numbers:
 * every studied client eventually grew a `Kind` table, and the ones that did it
 * late had raw integers baked into UI code. The range predicates encode NIP-01
 * §"Kinds" so storage and cache policy never has to re-derive them.
 */

/** Well-known Nostr event kinds used by Setu. */
export const Kind = {
  /** NIP-01 profile metadata (replaceable). */
  Metadata: 0,
  /** NIP-01 short text note. */
  ShortTextNote: 1,
  /** NIP-01 relay recommendation (deprecated but still seen). */
  RecommendRelay: 2,
  /** NIP-02 follow list (replaceable). */
  Contacts: 3,
  /** NIP-09 event deletion request. */
  EventDeletion: 5,
  /**
   * NIP-59 seal: the sender's real signature over an encrypted rumor.
   *
   * Never published on its own — it only ever appears inside a gift wrap. The
   * seal is what proves who wrote a private message, so its signature is the one
   * check a reader must not skip.
   */
  Seal: 13,
  /** NIP-17 private chat message. Exists only as a rumor inside a seal. */
  ChatMessage: 14,
  /** NIP-17 private file message. Exists only as a rumor inside a seal. */
  ChatFile: 15,
  /** NIP-18 repost of a kind-1 note. */
  Repost: 6,
  /** NIP-25 reaction. */
  Reaction: 7,
  /** NIP-18 repost of a non-kind-1 event. */
  GenericRepost: 16,
  /**
   * NIP-68 picture-first post.
   *
   * Two digits, not five: 20 is a *regular* kind, well below the 20000–29999
   * ephemeral band. Reading it as ephemeral would mean never storing a picture
   * post, so `isEphemeral` is the thing to check when that suspicion arises.
   */
  Picture: 20,
  /** NIP-71 video event, normal (landscape) orientation. */
  Video: 21,
  /** NIP-71 short-form portrait video. */
  ShortVideo: 22,
  /** NIP-28 public channel message. */
  ChannelMessage: 42,
  /**
   * NIP-88 poll response.
   *
   * Numbered below the poll it answers (1068), which is only worth noting because
   * the pair is easy to transpose — and a filter asking for 1068 when it wanted
   * 1018 returns polls instead of votes and tallies every poll as unanswered.
   */
  PollResponse: 1018,
  /** NIP-88 poll. */
  Poll: 1068,
  /** NIP-22 comment. */
  Comment: 1111,
  /** NIP-94 file metadata. */
  FileMetadata: 1063,
  /** NIP-56 report. */
  Report: 1984,
  /**
   * NIP-42 client authentication.
   *
   * Never published to a relay in the normal sense — it is sent as an `AUTH`
   * frame answering one challenge from one relay, and is a bearer proof of
   * identity for exactly that pair.
   */
  ClientAuth: 22242,
  /** NIP-57 zap request (never published to relays by the sender). */
  ZapRequest: 9734,
  /** NIP-57 zap receipt, published by the LNURL server. */
  Zap: 9735,
  /** NIP-84 highlight. */
  Highlight: 9802,
  /**
   * NIP-59 gift wrap: the only part of a private message that touches a relay.
   *
   * Signed by a throwaway key, so the `pubkey` on the wire belongs to nobody and
   * the sender is not visible. The single `p` tag names the recipient, which is
   * unavoidable — a relay has to know who to deliver it to.
   */
  GiftWrap: 1059,
  /** NIP-51 mute list (replaceable). */
  MuteList: 10000,
  /** NIP-65 relay list metadata (replaceable). */
  RelayList: 10002,
  /**
   * NIP-17 DM relay list (replaceable).
   *
   * Deliberately separate from kind 10002. Where you read public notes and where
   * you want private messages delivered are different questions, and a client
   * that conflates them sends someone's DMs to every relay they happen to read.
   */
  DirectMessageRelays: 10050,
  /** NIP-51 bookmarks (replaceable). */
  Bookmarks: 10003,
  /** NIP-51 community list — the NIP-72 communities you follow (replaceable). */
  CommunityList: 10004,
  /** BUD-03 Blossom server list (replaceable). */
  BlossomServerList: 10063,
  /** NIP-51 follow sets (addressable). */
  FollowSets: 30000,
  /** NIP-58 profile badges (addressable). */
  ProfileBadges: 30008,
  /** NIP-23 long-form article (addressable). */
  LongFormArticle: 30023,
  /** NIP-38 user status (addressable, `d` names the kind of status). */
  UserStatus: 30315,
  /** NIP-89 application handler (addressable). */
  AppHandler: 31990,
  /** NIP-51 follow pack (addressable). */
  FollowPack: 39089,
} as const;

/** Union of the named kind keys, e.g. `"ShortTextNote"`. */
export type KindName = keyof typeof Kind;

/** Union of the named kind values, e.g. `1`. */
export type KnownKind = (typeof Kind)[KindName];

/**
 * True for kinds where a relay keeps only the newest event per
 * `(pubkey, kind)`: metadata, contacts, and the 10000–19999 range.
 */
export function isReplaceable(kind: number): boolean {
  return (
    kind === Kind.Metadata ||
    kind === Kind.Contacts ||
    (kind >= 10000 && kind <= 19999)
  );
}

/**
 * True for parameterized-replaceable ("addressable") kinds, where the newest
 * event per `(pubkey, kind, d-tag)` wins: 30000–39999.
 */
export function isAddressable(kind: number): boolean {
  return kind >= 30000 && kind <= 39999;
}

/**
 * True for ephemeral kinds (20000–29999), which relays are not expected to
 * store — they must never be written to the local store either.
 */
export function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind <= 29999;
}

/** True for regular kinds: everything that is not replaceable/addressable/ephemeral. */
export function isRegular(kind: number): boolean {
  return !isReplaceable(kind) && !isAddressable(kind) && !isEphemeral(kind);
}
