/**
 * NIP-88 polls (kind 1068) and poll responses (kind 1018).
 *
 * Parsing a poll is unremarkable; **counting one honestly is the hard part**, and
 * it is the same problem `countAggregate.ts` solves for relay COUNT answers. A
 * client sees the responses its own relays happened to carry, under a bounded
 * query, so a tally is a *lower bound over a sample* — never a result. There is no
 * way to compute the real figure without having read every relay the poll was
 * published to, which no client does.
 *
 * Two consequences are baked into the types here rather than left to the caller:
 *
 *  1. Every count is named {@link PollOptionTally.atLeast}, so a caller that
 *     formats it as "62% voted yes" looks wrong in review. The share of a *sample*
 *     is a real number about a real thing, and it is not the outcome of the poll.
 *  2. {@link PollTally.voters} counts **distinct pubkeys**, not events. One pubkey
 *     can publish any number of kind-1018s, and the obvious loop over events
 *     counts a voter who changed their mind twice — inflating the total *and* the
 *     option they abandoned. Only each voter's newest response is counted.
 *
 * Nothing here filters by author trust or checks signatures: the store has already
 * verified everything it hands back, and a tally over a set someone else chose is
 * the caller's problem to describe accurately.
 */

import { isHex32 } from "./hex";
import { Kind } from "./kinds";
import { getTagged, getTagValue, type HasTags } from "./tags";
import type { EventTemplate, Hex32, NostrEvent } from "./types";

/** How many options a poll may declare before we stop reading them. */
const MAX_OPTIONS = 64;

/** One choice a poll offers. */
export interface PollOption {
  /** The author's opaque option id, echoed back by a `response` tag. */
  readonly id: string;
  /**
   * The label to display.
   *
   * Falls back to the id when the author wrote no label — an option rendered as
   * an empty button is unvotable, and dropping the option instead would silently
   * change the poll being shown.
   */
  readonly label: string;
}

/**
 * Single- or multiple-choice.
 *
 * Anything unrecognised is treated as single choice, matching NIP-88's default.
 * Erring towards single choice is the safer default of the two: counting one
 * response per voter on a poll that meant to allow several undercounts, while the
 * reverse would let one voter's single response be counted several times.
 */
export type PollType = "singlechoice" | "multiplechoice";

/** A decoded kind-1068. */
export interface Poll {
  readonly id: Hex32;
  readonly author: Hex32;
  /** The question, from the event's content. */
  readonly question: string;
  readonly options: readonly PollOption[];
  readonly type: PollType;
  /** `endsAt`, when the author declared a usable one. Unix seconds. */
  readonly endsAt?: number;
  /** `relay` hints the author asked responses to be published to. Advisory. */
  readonly relays: readonly string[];
  readonly createdAt: number;
}

/** A decoded kind-1018. */
export interface PollResponse {
  /** The poll this answers. */
  readonly pollId: Hex32;
  readonly voter: Hex32;
  /** Option ids the voter picked, deduplicated, in tag order. */
  readonly optionIds: readonly string[];
  readonly createdAt: number;
  /** The response event's own id, used only to break `created_at` ties. */
  readonly id: string;
}

/**
 * The fields a poll is decoded from.
 *
 * Structural rather than `NostrEvent` so a caller holding a render model can parse
 * without fabricating a signature. A poll's identity, author and timestamp are all
 * load-bearing for the tally, so they are required — but `sig` is not read here and
 * demanding it would push callers into inventing one.
 */
export interface PollSource extends HasTags {
  readonly id: Hex32;
  readonly pubkey: Hex32;
  readonly kind: number;
  readonly content: string;
  readonly created_at: number;
}

/**
 * Decode a poll, or `undefined` when the event cannot be rendered as one.
 *
 * A poll with no options is rejected rather than shown empty: the only thing such
 * a card could offer is a question nobody can answer, and it is far more likely to
 * be an event of some other kind that happens to be numbered 1068 by a client we
 * do not know about.
 */
export function parsePoll(event: PollSource): Poll | undefined {
  if (event.kind !== Kind.Poll) return undefined;

  const options: PollOption[] = [];
  const seen = new Set<string>();
  for (const tag of getTagged(event, "option")) {
    if (options.length >= MAX_OPTIONS) break;
    const id = tag[1];
    if (id === undefined || id === "") continue;
    // First declaration wins. A duplicated option id would give two buttons that
    // are the same vote, and the tally would attribute it to whichever came last.
    if (seen.has(id)) continue;
    seen.add(id);
    const label = tag[2];
    options.push({
      id,
      label: label !== undefined && label !== "" ? label : id,
    });
  }
  if (options.length === 0) return undefined;

  const rawEndsAt = getTagValue(event, "endsAt");
  const endsAt =
    rawEndsAt === undefined ? undefined : parseTimestamp(rawEndsAt);

  return {
    id: event.id,
    author: event.pubkey,
    question: event.content,
    options,
    type:
      getTagValue(event, "polltype") === "multiplechoice"
        ? "multiplechoice"
        : "singlechoice",
    ...(endsAt !== undefined ? { endsAt } : {}),
    relays: relayHints(event),
    createdAt: event.created_at,
  };
}

/**
 * Unix seconds from a tag value, or `undefined` when it is not a usable one.
 *
 * Strict on purpose. `endsAt` decides whether a poll is closed, and a `NaN` from
 * `Number("soon")` compares false against every timestamp — so a malformed value
 * would silently make an ended poll look open forever. `undefined` means "the
 * author declared no deadline", which is a state the UI already has to render.
 */
function parseTimestamp(raw: string): number | undefined {
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

/** `relay` hints, deduplicated, in tag order. */
function relayHints(event: HasTags): readonly string[] {
  const out: string[] = [];
  for (const tag of getTagged(event, "relay")) {
    const url = tag[1];
    if (url === undefined || url === "" || out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

/**
 * Decode a poll response, or `undefined` when it names no poll.
 *
 * The `e` value is checked for shape before it is returned, because callers put it
 * straight into a relay filter: a malformed id in `#e` is one some relays reject
 * outright, taking every real id in the batch with it.
 */
export function parsePollResponse(event: NostrEvent): PollResponse | undefined {
  if (event.kind !== Kind.PollResponse) return undefined;
  const pollId = getTagValue(event, "e");
  if (pollId === undefined || !isHex32(pollId)) return undefined;

  const optionIds: string[] = [];
  for (const tag of getTagged(event, "response")) {
    const id = tag[1];
    if (id === undefined || id === "" || optionIds.includes(id)) continue;
    optionIds.push(id);
  }

  return {
    pollId,
    voter: event.pubkey,
    optionIds,
    createdAt: event.created_at,
    id: event.id,
  };
}

/** What we hold for one option. */
export interface PollOptionTally {
  readonly optionId: string;
  /**
   * Voters we counted for this option — a floor, never a total.
   *
   * Named for what it is, following `AggregatedCount.atLeast`: the responses we
   * were served are a subset of the responses that exist, so this number can only
   * be too low.
   */
  readonly atLeast: number;
}

/** The result of counting what we hold for a poll. */
export interface PollTally {
  /** One entry per declared option, in the poll's own option order. */
  readonly options: readonly PollOptionTally[];
  /**
   * Distinct pubkeys whose newest response we counted.
   *
   * The denominator for a share *of this sample*. It is not the poll's turnout,
   * and a UI that labels it as one is making a claim it cannot support.
   */
  readonly voters: number;
  /** Response events considered, before newest-per-voter collapsing. */
  readonly responses: number;
  /**
   * Voters who had more than one response, so an older one was discarded.
   *
   * Surfaced because it is the evidence that the collapsing happened: a tally
   * where this is non-zero would have been inflated by exactly this much had every
   * event been counted.
   */
  readonly revisedVoters: number;
  /** Responses dropped because they arrived after the poll's `endsAt`. */
  readonly lateResponses: number;
}

export const EMPTY_TALLY: PollTally = {
  options: [],
  voters: 0,
  responses: 0,
  revisedVoters: 0,
  lateResponses: 0,
};

/**
 * Is this response the one that should count for its voter?
 *
 * Newest wins, and an `id` comparison breaks a `created_at` tie. The tie is not
 * hypothetical: a client publishing two responses in the same second produces
 * two events with the same timestamp, and without a deterministic rule the tally
 * would depend on the order relays happened to deliver them — so the same poll
 * would show different numbers on a reload.
 */
function supersedes(candidate: PollResponse, current: PollResponse): boolean {
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt > current.createdAt;
  }
  return candidate.id > current.id;
}

/**
 * Count the responses we hold for one poll.
 *
 * The rules, each of which the naive loop over events gets wrong:
 *
 *  - **One vote per pubkey**, the newest. Anyone can publish any number of
 *    kind-1018s, so counting events counts a changed mind twice — once for the
 *    option they left and once for the option they moved to.
 *  - **Responses after `endsAt` are dropped.** NIP-88 says a closed poll's later
 *    responses do not count, and a client that includes them lets a poll be
 *    swung after it closed.
 *  - **Undeclared option ids are dropped.** A `response` naming an option the poll
 *    never offered is either a different poll's option or noise; either way there
 *    is no row it belongs to.
 *  - **A single-choice poll counts one option per voter**, the first one the
 *    response declared. Honouring several would let one voter fill every bar.
 */
export function tallyPoll(
  poll: Poll,
  responses: readonly PollResponse[],
): PollTally {
  const declared = new Set(poll.options.map((option) => option.id));
  const newestByVoter = new Map<string, PollResponse>();
  /** Voters seen more than once, so the figure is voters and not extra events. */
  const revised = new Set<string>();
  let considered = 0;
  let lateResponses = 0;

  for (const response of responses) {
    if (response.pollId !== poll.id) continue;
    if (poll.endsAt !== undefined && response.createdAt > poll.endsAt) {
      lateResponses += 1;
      continue;
    }
    considered += 1;
    const current = newestByVoter.get(response.voter);
    if (current === undefined) {
      newestByVoter.set(response.voter, response);
      continue;
    }
    revised.add(response.voter);
    if (supersedes(response, current)) {
      newestByVoter.set(response.voter, response);
    }
  }

  const counts = new Map<string, number>();
  let voters = 0;
  for (const response of newestByVoter.values()) {
    const picks = response.optionIds.filter((id) => declared.has(id));
    const counted = poll.type === "singlechoice" ? picks.slice(0, 1) : picks;
    // A response naming only undeclared options is not a voter: counting it in the
    // denominator would shrink every option's share for a vote nobody cast.
    if (counted.length === 0) continue;
    voters += 1;
    for (const id of counted) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return {
    options: poll.options.map((option) => ({
      optionId: option.id,
      atLeast: counts.get(option.id) ?? 0,
    })),
    voters,
    responses: considered,
    revisedVoters: revised.size,
    lateResponses,
  };
}

/**
 * A response event, ready to sign.
 *
 * `optionIds` is trimmed to the poll's own declared options and, on a single-choice
 * poll, to one — enforced here rather than in the UI because a response naming two
 * options on a single-choice poll is one no tally will count the way its author
 * expected, and building it at all is the bug.
 *
 * The poll's `relay` hints are deliberately *not* turned into publish targets here:
 * choosing relays is the publisher's job (`usePublish` uses the author's own NIP-65
 * write list), and a template cannot express a destination anyway. The hints are on
 * {@link Poll.relays} for a caller that wants to honour them.
 */
export function buildPollResponse(
  poll: Poll,
  optionIds: readonly string[],
): EventTemplate {
  const declared = new Set(poll.options.map((option) => option.id));
  const picks = optionIds.filter((id) => declared.has(id));
  const counted = poll.type === "singlechoice" ? picks.slice(0, 1) : picks;
  return {
    kind: Kind.PollResponse,
    content: "",
    tags: [["e", poll.id], ...counted.map((id) => ["response", id])],
  };
}

/**
 * Has the poll closed?
 *
 * `false` when the author declared no deadline, which is the common case — an
 * open-ended poll is open, not expired.
 */
export function pollHasEnded(poll: Poll, nowSeconds: number): boolean {
  return poll.endsAt !== undefined && nowSeconds > poll.endsAt;
}
