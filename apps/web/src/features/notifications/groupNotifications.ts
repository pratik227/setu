/**
 * Turning events addressed to the viewer into notification rows.
 *
 * A pure module on purpose: grouping is where notifications get subtly wrong
 * (your own reactions shown back to you, five likes on one note shown as five
 * rows, a downvote rendered as a heart), and every one of those is a property of
 * a function over a list of events. Nothing here touches the store, the network,
 * or React, so all of it is asserted directly in `groupNotifications.test.ts`.
 *
 * Two rules the rest of the app depends on:
 *
 * 1. **Nothing is claimed that was not verified.** A row says "your note" only
 *    when we actually hold that note and its author is the viewer. When we do not
 *    hold it the row still renders — dropping it would silently hide a real
 *    notification — but it says the target is unavailable rather than asserting
 *    whose it was.
 * 2. **The viewer's own actions are never notifications.** Self-reactions and
 *    self-reposts leaking into this list is the classic bug, and for zaps the
 *    check has to be made against the *claimed sender* rather than the receipt's
 *    signer, which is never the viewer.
 */

import type { NostrEvent } from "@setu/protocol";
import { getTagValues, hasTag, Kind } from "@setu/protocol";
import { zapSenderClaim } from "../explore/useZapReceipts";
import { zapReceiptSats } from "../notes/bolt11";

/** Kinds that can be addressed to a viewer and become a notification. */
export const NOTIFICATION_KINDS: readonly number[] = [
  Kind.ShortTextNote,
  Kind.Repost,
  Kind.Reaction,
  Kind.Zap,
  Kind.Comment,
];

export type NotificationKind =
  | "reply"
  | "mention"
  | "reaction"
  | "repost"
  | "zap";

/**
 * How much this client knows about who performed an action.
 *
 * `"signed"` means the actor signed an event we verified locally. `"claimed"`
 * means a third party told us who it was: a zap receipt is signed by the
 * *recipient's* LNURL server, and the sender pubkey inside it is copied out of an
 * attacker-influenceable JSON blob. A UI must not present the two identically —
 * a claimed identity is a name we are relaying, not a name we checked.
 */
export type ActorAttribution = "signed" | "claimed";

export interface NotificationActor {
  /**
   * Undefined for an anonymous zap. NIP-57 explicitly permits a receipt that
   * names no sender, and inventing one would be worse than saying we do not know.
   */
  readonly pubkey?: string;
  /** Newest action by this actor in the row. */
  readonly createdAt: number;
  readonly attribution: ActorAttribution;
  /** The newest event by this actor that contributed to the row. */
  readonly eventId: string;
  /** kind-7 content verbatim, for the newest reaction by this actor. */
  readonly reactionContent?: string;
  /** Sats this actor paid across every receipt collapsed into the row. */
  readonly sats?: number;
}

export interface NotificationItem {
  /** Stable row identity. Safe as a React key. */
  readonly key: string;
  readonly kind: NotificationKind;
  /** The event the action points at, when it names one. */
  readonly targetId?: string;
  /** Opening text of the target, when we hold it. */
  readonly targetPreview?: string;
  /**
   * True when the action names a target we do not hold. The row still renders;
   * the target is shown as unavailable rather than described.
   */
  readonly targetUnavailable: boolean;
  /**
   * True only when we hold the target *and* its author is the viewer. Gates the
   * phrase "your note" — an actor controls the `p` tag that put this event in
   * front of you, so "addressed to you" is not proof the target is yours.
   */
  readonly targetIsMine: boolean;
  /** Distinct actors, newest action first. */
  readonly actors: readonly NotificationActor[];
  /** Newest action in the row; the row's sort key and unread comparison point. */
  readonly createdAt: number;
  /** Sum over every receipt collapsed into a zap row. */
  readonly totalSats?: number;
  /**
   * True when every reaction collapsed into the row is a plain like (`+` or an
   * empty content). Mixed emoji read as "reacted", not "liked".
   */
  readonly allLikes: boolean;
  /** For reply/mention rows, the opening text of what the actor wrote. */
  readonly bodyPreview?: string;
  /** Event a click on the row should open. */
  readonly openId?: string;
}

export interface GroupNotificationsInput {
  readonly viewerPubkey: string;
  /** Events whose `p` tags include the viewer, in any order. */
  readonly events: readonly NostrEvent[];
  /**
   * Events we hold, by id, for the ids these notifications reference.
   *
   * This is what makes reply-vs-mention and "your note" *verified* rather than
   * assumed. An id missing from this map is not an error — it is the normal first
   * frame, and the honest rendering is "not retrieved yet".
   */
  readonly known: ReadonlyMap<string, NostrEvent>;
}

const HEX32 = /^[0-9a-f]{64}$/;
const ANONYMOUS_ACTOR = "anonymous";
const PREVIEW_CHARS = 160;

/** Collapse whitespace and cut to a single readable line. */
export function previewText(text: string, max = PREVIEW_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trimEnd()}…`;
}

/**
 * Event ids an addressed event points at.
 *
 * NIP-22 comments put the root in uppercase `E` and the parent in lowercase `e`,
 * so a comment on the viewer's note resolves through neither tag alone. Ids that
 * are not 32-byte lowercase hex are dropped rather than passed on to a store
 * query.
 */
export function referencedEventIds(event: NostrEvent): readonly string[] {
  const raw =
    event.kind === Kind.Comment
      ? [...getTagValues(event, "e"), ...getTagValues(event, "E")]
      : getTagValues(event, "e");
  const out: string[] = [];
  for (const id of raw) {
    const lowered = id.toLowerCase();
    if (HEX32.test(lowered) && !out.includes(lowered)) out.push(lowered);
  }
  return out;
}

/** NIP-25: an empty or `+` reaction is a like; anything else is its own thing. */
function isLike(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === "" || trimmed === "+";
}

/** The id a reaction reacted to: NIP-25 says the **last** `e` tag. */
function reactionTargetId(event: NostrEvent): string | undefined {
  const ids = referencedEventIds(event);
  return ids.length > 0 ? ids[ids.length - 1] : undefined;
}

interface Contribution {
  readonly kind: NotificationKind;
  readonly groupKey: string;
  readonly targetId?: string;
  readonly actor: NotificationActor;
  /** Body text for reply/mention rows. */
  readonly bodyPreview?: string;
  readonly openId?: string;
  /** Reaction content, kept so a row can decide "liked" vs "reacted". */
  readonly reactionContent?: string;
}

/**
 * Classify one addressed event, or reject it.
 *
 * Returns `undefined` for anything that must not become a notification: the
 * viewer's own action, a NIP-25 downvote, an unknown kind.
 */
function classify(
  event: NostrEvent,
  viewerPubkey: string,
  known: ReadonlyMap<string, NostrEvent>,
): Contribution | undefined {
  switch (event.kind) {
    case Kind.ShortTextNote:
    case Kind.Comment: {
      if (event.pubkey === viewerPubkey) return undefined;
      const mine = referencedEventIds(event).find(
        (id) => known.get(id)?.pubkey === viewerPubkey,
      );
      const actor: NotificationActor = {
        pubkey: event.pubkey,
        createdAt: event.created_at,
        attribution: "signed",
        eventId: event.id,
      };
      // A reply is only a reply when we can see the parent is the viewer's. An
      // event that references notes we do not hold lands under mentions, which
      // is the honest direction: NIP-10 asks a reply to `p`-tag every
      // participant, so "addressed to you" routinely means "you are in this
      // thread" rather than "this answers your note".
      if (mine !== undefined) {
        return {
          kind: "reply",
          // Replies never collapse: each carries distinct text, and merging two
          // answers to one note into "Alice and 1 other replied" throws away the
          // only part a reader came for. Collapsing is for fungible
          // acknowledgements — likes, reposts, zaps.
          groupKey: `reply:${event.id}`,
          targetId: mine,
          actor,
          bodyPreview: previewText(event.content),
          openId: event.id,
        };
      }
      return {
        kind: "mention",
        groupKey: `mention:${event.id}`,
        actor,
        bodyPreview: previewText(event.content),
        openId: event.id,
      };
    }

    case Kind.Repost: {
      if (event.pubkey === viewerPubkey) return undefined;
      const targetId = referencedEventIds(event)[0];
      return {
        kind: "repost",
        groupKey: `repost:${targetId ?? "unknown"}`,
        ...(targetId ? { targetId, openId: targetId } : {}),
        actor: {
          pubkey: event.pubkey,
          createdAt: event.created_at,
          attribution: "signed",
          eventId: event.id,
        },
      };
    }

    case Kind.Reaction: {
      if (event.pubkey === viewerPubkey) return undefined;
      // NIP-25 `-` is an explicit downvote. Counting it with the likes would
      // make the row assert the opposite of what happened.
      if (event.content.trim() === "-") return undefined;
      const targetId = reactionTargetId(event);
      return {
        kind: "reaction",
        groupKey: `reaction:${targetId ?? "unknown"}`,
        ...(targetId ? { targetId, openId: targetId } : {}),
        reactionContent: event.content,
        actor: {
          pubkey: event.pubkey,
          createdAt: event.created_at,
          attribution: "signed",
          eventId: event.id,
          reactionContent: event.content,
        },
      };
    }

    case Kind.Zap: {
      const claim = zapSenderClaim(event);
      // The receipt is signed by the recipient's LNURL server, so `event.pubkey`
      // is never the viewer and checking it would never exclude a self-zap. The
      // claimed sender is the only field that can say "you paid this", and it is
      // exactly that — a claim.
      if (claim.pubkey === viewerPubkey) return undefined;
      const targetId = referencedEventIds(event)[0];
      return {
        kind: "zap",
        groupKey: `zap:${targetId ?? "profile"}`,
        ...(targetId ? { targetId, openId: targetId } : {}),
        actor: {
          ...(claim.pubkey ? { pubkey: claim.pubkey } : {}),
          createdAt: event.created_at,
          attribution: "claimed",
          eventId: event.id,
          sats: zapReceiptSats(event.tags),
        },
      };
    }

    default:
      return undefined;
  }
}

interface Draft {
  kind: NotificationKind;
  key: string;
  targetId?: string;
  /** Keyed by pubkey, or one shared bucket for anonymous zaps. */
  actors: Map<string, NotificationActor>;
  reactionContents: string[];
  bodyPreview?: string;
  openId?: string;
}

/** Merge an actor into a draft, keeping the newest action and summing sats. */
function mergeActor(draft: Draft, actor: NotificationActor): void {
  const key = actor.pubkey ?? ANONYMOUS_ACTOR;
  const existing = draft.actors.get(key);
  if (!existing) {
    draft.actors.set(key, actor);
    return;
  }
  const sats =
    existing.sats === undefined && actor.sats === undefined
      ? undefined
      : (existing.sats ?? 0) + (actor.sats ?? 0);
  // Newest action wins for display; sats accumulate across every receipt.
  const newest = actor.createdAt >= existing.createdAt ? actor : existing;
  draft.actors.set(key, {
    ...newest,
    ...(sats === undefined ? {} : { sats }),
  });
}

/** Newest first, with a deterministic tiebreak so ties never reorder on re-render. */
function compareActors(a: NotificationActor, b: NotificationActor): number {
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
  return (a.pubkey ?? ANONYMOUS_ACTOR).localeCompare(
    b.pubkey ?? ANONYMOUS_ACTOR,
  );
}

/**
 * Group events addressed to the viewer into notification rows, newest first.
 *
 * Collapse is by (kind, target): five people liking one note is one row with five
 * actors. Replies and mentions are deliberately excluded from that — see
 * `classify`.
 */
export function groupNotifications(
  input: GroupNotificationsInput,
): readonly NotificationItem[] {
  const { viewerPubkey, events, known } = input;
  const drafts = new Map<string, Draft>();

  for (const event of events) {
    // Defensive: the caller's filter is `#p = viewer`, but a relay is not
    // trusted to honour it and a mis-addressed row would be a privacy leak.
    if (!hasTag(event, "p", viewerPubkey)) continue;

    const contribution = classify(event, viewerPubkey, known);
    if (!contribution) continue;

    let draft = drafts.get(contribution.groupKey);
    if (!draft) {
      draft = {
        kind: contribution.kind,
        key: contribution.groupKey,
        actors: new Map(),
        reactionContents: [],
        ...(contribution.targetId ? { targetId: contribution.targetId } : {}),
        ...(contribution.bodyPreview
          ? { bodyPreview: contribution.bodyPreview }
          : {}),
        ...(contribution.openId ? { openId: contribution.openId } : {}),
      };
      drafts.set(contribution.groupKey, draft);
    }
    mergeActor(draft, contribution.actor);
    if (contribution.reactionContent !== undefined) {
      draft.reactionContents.push(contribution.reactionContent);
    }
  }

  const items: NotificationItem[] = [];
  for (const draft of drafts.values()) {
    const actors = [...draft.actors.values()].sort(compareActors);
    const newest = actors[0];
    if (!newest) continue;

    const target = draft.targetId ? known.get(draft.targetId) : undefined;
    const totalSats = actors.reduce((sum, actor) => sum + (actor.sats ?? 0), 0);

    items.push({
      key: draft.key,
      kind: draft.kind,
      ...(draft.targetId ? { targetId: draft.targetId } : {}),
      ...(target ? { targetPreview: previewText(target.content) } : {}),
      targetUnavailable: draft.targetId !== undefined && target === undefined,
      targetIsMine: target?.pubkey === viewerPubkey,
      actors,
      createdAt: newest.createdAt,
      ...(draft.kind === "zap" ? { totalSats } : {}),
      allLikes:
        draft.kind === "reaction" && draft.reactionContents.every(isLike),
      ...(draft.bodyPreview ? { bodyPreview: draft.bodyPreview } : {}),
      ...(draft.openId ? { openId: draft.openId } : {}),
    });
  }

  // Newest first. The key tiebreak is what keeps two rows with identical
  // timestamps in a stable order instead of swapping between renders.
  return items.sort((a, b) =>
    b.createdAt !== a.createdAt
      ? b.createdAt - a.createdAt
      : a.key.localeCompare(b.key),
  );
}

/** Rows matching a notification category, in the order they were given. */
export function filterByKind(
  items: readonly NotificationItem[],
  kinds: readonly NotificationKind[],
): readonly NotificationItem[] {
  return items.filter((item) => kinds.includes(item.kind));
}
