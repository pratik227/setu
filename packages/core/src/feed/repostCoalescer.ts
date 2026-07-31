/**
 * Repost coalescing.
 *
 * Twelve people reposting the same note produces twelve events and should
 * produce one feed row reading "reposted by twelve people". Doing this in the
 * view means the view owns feed state; doing it here means the feed's row list is
 * already correct before anything renders.
 *
 * Grouping is per target id and bounded by a time window anchored on the *first*
 * repost in the group. A window rather than "forever" because a note reposted
 * again three months later is genuinely a new event in the reader's feed, not a
 * retroactive edit of an old row.
 */

import type { Hex32, NostrEvent, Timestamp } from "@setu/protocol";
import type { IsValidEventShapeFn } from "../internal/filterMatch";
import { isValidEventShape as defaultIsValidEventShape } from "../internal/filterMatch";
import { KIND_GENERIC_REPOST, KIND_REPOST } from "../store/kinds";
import type { FeedEntry } from "./feedTypes";

/** Default coalescing window: reposts within an hour collapse into one row. */
export const DEFAULT_REPOST_WINDOW_SECONDS = 3_600;

/** Options for {@link RepostCoalescer}. */
export interface RepostCoalescerOptions {
  /** Reposts within this many seconds of the group anchor collapse together. */
  readonly windowSeconds?: number;
  /** Injected validator for events embedded in a repost's `content`. */
  readonly isValidEventShape?: IsValidEventShapeFn;
}

/** True for kinds NIP-18 defines as reposts. */
export function isRepostKind(kind: number): boolean {
  return kind === KIND_REPOST || kind === KIND_GENERIC_REPOST;
}

/**
 * The reposted event's id: the last `e` tag, per NIP-18's marker-free convention
 * for reposts. Returns `undefined` when the repost names no target, in which case
 * it is treated as an ordinary note.
 */
export function repostTargetId(event: NostrEvent): Hex32 | undefined {
  let target: Hex32 | undefined;
  for (const tag of event.tags) {
    if (tag[0] !== "e") continue;
    const value = tag[1];
    if (value !== undefined && value !== "") target = value;
  }
  return target;
}

/** One reposter and when they reposted. */
interface RepostMember {
  readonly pubkey: Hex32;
  readonly at: Timestamp;
}

interface RepostGroup {
  readonly key: string;
  readonly targetId: Hex32;
  /** `created_at` of the oldest repost in the group, which anchors the window. */
  anchorAt: Timestamp;
  /** Reposters, in arrival order; sorted by timestamp when the row is built. */
  members: RepostMember[];
  repostIds: Hex32[];
  /** Newest repost in the group; drives the row's sort position. */
  newest: NostrEvent;
  target: NostrEvent | undefined;
}

/** Builds feed rows from events, collapsing reposts of the same target. */
export class RepostCoalescer {
  private readonly groups = new Map<Hex32, RepostGroup[]>();
  private readonly seenRepostIds = new Set<Hex32>();
  private readonly windowSeconds: number;
  private readonly isValidShape: IsValidEventShapeFn;

  constructor(options: RepostCoalescerOptions = {}) {
    this.windowSeconds = options.windowSeconds ?? DEFAULT_REPOST_WINDOW_SECONDS;
    this.isValidShape = options.isValidEventShape ?? defaultIsValidEventShape;
  }

  /**
   * Turns an event into the row it belongs to.
   *
   * Returns `undefined` only for a repost already absorbed, so callers can treat
   * "no row" as "nothing changed".
   */
  absorb(event: NostrEvent): FeedEntry | undefined {
    if (!isRepostKind(event.kind)) return noteEntry(event);
    const targetId = repostTargetId(event);
    if (targetId === undefined) return noteEntry(event);
    if (this.seenRepostIds.has(event.id)) return undefined;
    this.seenRepostIds.add(event.id);

    const embedded = this.embeddedTarget(event);
    const buckets = this.groups.get(targetId) ?? [];
    const group = buckets.find(
      (candidate) =>
        Math.abs(event.created_at - candidate.anchorAt) <= this.windowSeconds,
    );

    if (group === undefined) {
      const created: RepostGroup = {
        key: `repost:${targetId}:${event.created_at}`,
        targetId,
        anchorAt: event.created_at,
        members: [{ pubkey: event.pubkey, at: event.created_at }],
        repostIds: [event.id],
        newest: event,
        target: embedded,
      };
      buckets.push(created);
      this.groups.set(targetId, buckets);
      return groupEntry(created);
    }

    if (!group.members.some((member) => member.pubkey === event.pubkey)) {
      group.members.push({ pubkey: event.pubkey, at: event.created_at });
    }
    group.repostIds.push(event.id);
    // The window is anchored on the *oldest* repost in the group, not the first
    // one we happened to receive, so membership is independent of arrival order.
    if (event.created_at < group.anchorAt) group.anchorAt = event.created_at;
    if (event.created_at > group.newest.created_at) group.newest = event;
    if (group.target === undefined && embedded !== undefined) {
      group.target = embedded;
    }
    return groupEntry(group);
  }

  /**
   * Supplies the reposted event once it is known, so rows built from a repost
   * that did not embed its target can render. Returns the affected rows.
   */
  resolveTarget(target: NostrEvent): readonly FeedEntry[] {
    const buckets = this.groups.get(target.id);
    if (buckets === undefined) return [];
    const updated: FeedEntry[] = [];
    for (const group of buckets) {
      group.target = target;
      updated.push(groupEntry(group));
    }
    return updated;
  }

  /** Target ids that have rows but no resolved target event yet. */
  unresolvedTargetIds(): readonly Hex32[] {
    const out: Hex32[] = [];
    for (const [targetId, buckets] of this.groups) {
      if (buckets.some((group) => group.target === undefined)) {
        out.push(targetId);
      }
    }
    return out;
  }

  /** Drops all grouping state. */
  reset(): void {
    this.groups.clear();
    this.seenRepostIds.clear();
  }

  /**
   * NIP-18 allows a repost to carry the target's JSON in `content`. Using it
   * saves a round trip; a malformed or unverifiable payload is ignored.
   *
   * Note the embedded event is *not* trusted as verified — callers that store it
   * must put it through the verifier like anything else off the wire.
   */
  private embeddedTarget(event: NostrEvent): NostrEvent | undefined {
    if (event.content === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.content);
    } catch {
      return undefined;
    }
    if (!this.isValidShape(parsed)) return undefined;
    return parsed;
  }
}

function noteEntry(event: NostrEvent): FeedEntry {
  return {
    key: `note:${event.id}`,
    kind: "note",
    event,
    createdAt: event.created_at,
    reposters: [],
    repostIds: [],
  };
}

function groupEntry(group: RepostGroup): FeedEntry {
  const entry: {
    key: string;
    kind: "repost";
    event: NostrEvent;
    createdAt: Timestamp;
    reposters: readonly Hex32[];
    repostIds: readonly Hex32[];
    targetId: Hex32;
    target?: NostrEvent;
  } = {
    key: group.key,
    kind: "repost",
    event: group.newest,
    createdAt: group.newest.created_at,
    // Sorted by repost time so the row is identical however the events arrived.
    reposters: [...group.members]
      .sort((a, b) => a.at - b.at || (a.pubkey < b.pubkey ? -1 : 1))
      .map((member) => member.pubkey),
    repostIds: [...group.repostIds],
    targetId: group.targetId,
  };
  if (group.target !== undefined) entry.target = group.target;
  return entry;
}
