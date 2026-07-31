/**
 * Routing a NIP-50 search to the relays that can actually answer one.
 *
 * NIP-50 puts a `search` field in an otherwise ordinary REQ filter, and that is
 * the whole problem: NIP-01 tells a relay to ignore filter fields it does not
 * understand. So a relay without NIP-50 does not reject the query and does not
 * error — it drops the `search` field and answers what is left. Send
 * `{ kinds: [0, 1], search: "gardening", limit: 60 }` to such a relay and you get
 * the newest sixty events it holds, about anything, which the UI then presents as
 * search results. That is worse than an empty list by a wide margin: an empty list
 * is a fact the reader can act on, and sixty unrelated notes labelled "results for
 * gardening" is the client lying with a straight face.
 *
 * Hence the one rule here: **only relays whose NIP-11 document lists NIP-50 are
 * queried.** This is deliberately stricter than {@link relaysFor}, which keeps
 * relays we know nothing about on the reasoning that a missing document is common
 * and treating silence as refusal shrinks the usable set. That reasoning is right
 * for a normal read, where an incapable relay simply contributes nothing, and
 * wrong here, where an incapable relay contributes garbage.
 *
 * The second job is accounting for the relays that were *not* asked, and why.
 * "Nothing matched" and "none of your relays can search" are different facts with
 * different remedies, and only one of them is the reader's problem to solve. The
 * plan therefore keeps the excluded relays in three separate buckets rather than
 * one, because they mean three different things — see {@link SearchRouting}.
 *
 * Pure: parsing and policy over documents relays volunteered. Fetching lives in
 * `relayInfoCache.ts`.
 */

import type { Filter, RelayBasedFilter } from "@setu/protocol";
import {
  clampLimit,
  NIP,
  type RelayGate,
  type RelayInfo,
  relayGate,
  supports,
} from "./relayInfo";

/**
 * Events one relay may return for one search.
 *
 * A search filter needs a bound for the same reason every other filter in this
 * codebase does: a relay may answer an unbounded filter literally, and a common
 * word matches a large fraction of its corpus. Sixty is chosen against what a
 * palette can show rather than what a relay can send — nobody arrows through the
 * six hundredth hit, and every event past the visible set still costs a signature
 * verification and a store row.
 */
export const SEARCH_LIMIT = 60;

/**
 * Shortest query worth sending to a relay.
 *
 * One or two characters match most of any relay's corpus, so the relay answers
 * with `limit` events chosen by *its* ordering, not by relevance. The result looks
 * exactly like a search that worked and is indistinguishable from a firehose
 * sample, so this refuses to ask rather than showing one.
 */
export const MIN_SEARCH_QUERY_LENGTH = 3;

/** A relay that advertises NIP-50, with the reason it might still say nothing. */
export interface SearchRelay {
  readonly url: string;
  readonly info: RelayInfo;
  /**
   * `payment-required` or `auth-required` when this relay will answer with
   * silence until that is satisfied.
   *
   * Kept on the relay rather than filtering it out: a paid relay the account has
   * actually paid for is the best search relay on the network, and dropping it
   * would make the feature unavailable to the people who bought it. The caller
   * shows the gate so an empty result is not read as "nothing matched".
   */
  readonly gate: RelayGate;
}

/**
 * Which relays a search can go to, and what happened to the rest.
 *
 * The three exclusion buckets are not cosmetic. `unsupported` is a settled no —
 * the relay published a document and NIP-50 is not in it, and no amount of waiting
 * changes that. `silent` is also settled but for a different reason: the relay
 * never published a document at all, so it may well support search and we have no
 * way to find out, and asking anyway is the firehose case this module exists to
 * prevent. `pending` is the only bucket that will change on its own, and it is the
 * one that must stop the UI from claiming search is unavailable — saying so while
 * the capability fetch is still in flight is a claim the client cannot back up yet.
 */
export interface SearchRouting {
  /** Relays that advertise NIP-50. Ungated first, then by URL for determinism. */
  readonly usable: readonly SearchRelay[];
  /** Published a document; NIP-50 is not in it. */
  readonly unsupported: readonly string[];
  /** Asked, published no usable document. Capability unknowable, so not asked. */
  readonly silent: readonly string[];
  /** Not yet asked, or the request is still in flight. */
  readonly pending: readonly string[];
}

export interface SearchRoutingInput {
  readonly urls: readonly string[];
  readonly infos: ReadonlyMap<string, RelayInfo>;
  /**
   * Relays whose capability fetch has finished, document or not.
   *
   * Optional because the distinction only exists in a live cache. Omitted, a
   * relay with a document counts as resolved and one without counts as pending,
   * which is the right default for a caller that has no better information: it
   * errs towards "we do not know yet" rather than towards a premature "search is
   * unavailable".
   */
  readonly resolved?: ReadonlySet<string>;
}

/** Split the configured relays by what they can do with a `search` filter. */
export function planRelaySearch(input: SearchRoutingInput): SearchRouting {
  const usable: SearchRelay[] = [];
  const unsupported: string[] = [];
  const silent: string[] = [];
  const pending: string[] = [];

  for (const url of input.urls) {
    const info = input.infos.get(url);
    if (info === undefined) {
      const settled = input.resolved?.has(url) ?? false;
      (settled ? silent : pending).push(url);
      continue;
    }
    if (supports(info, NIP.Search)) {
      usable.push({ url, info, gate: relayGate(info) });
    } else {
      unsupported.push(url);
    }
  }

  // Ungated first: when several relays can search, the one that will answer
  // without a payment or an AUTH round trip is the one whose results arrive.
  usable.sort((a, b) => {
    const gap = Number(a.gate !== "none") - Number(b.gate !== "none");
    return gap !== 0 ? gap : a.url.localeCompare(b.url);
  });

  return { usable, unsupported, silent, pending };
}

/**
 * What the client can honestly say about relay search right now.
 *
 * `unknown` outranks `unavailable` while anything is pending, because the two
 * read identically to a user and only one of them is true: telling someone no
 * relay of theirs supports search, half a second before a document arrives saying
 * one does, is the kind of confidently wrong empty state this codebase treats as a
 * bug rather than a cosmetic issue.
 */
export type SearchReach =
  /** At least one relay advertises NIP-50 and needs nothing first. */
  | "ready"
  /** The only NIP-50 relays want payment or AUTH, so silence is expected. */
  | "gated"
  /** Every relay has answered and none of them can search. */
  | "unavailable"
  /** Capabilities are still being fetched; no claim is available yet. */
  | "unknown";

export function searchReach(routing: SearchRouting): SearchReach {
  if (routing.usable.some((relay) => relay.gate === "none")) return "ready";
  if (routing.usable.length > 0) return "gated";
  if (routing.pending.length > 0) return "unknown";
  return "unavailable";
}

export interface SearchFilterOptions {
  readonly routing: SearchRouting;
  /** Raw query text. Trimmed here; short and empty queries produce no filters. */
  readonly query: string;
  readonly kinds: readonly number[];
  readonly limit?: number;
}

/**
 * The per-relay filters for one search, or nothing when there is nothing to ask.
 *
 * Returning an empty array for a short query is the same decision as returning one
 * for a routing with no usable relays: in both cases there is no query we could
 * send that would produce an answer worth showing, and building one anyway would
 * spend a subscription slot to fill the store with an arbitrary sample.
 *
 * The limit is clamped per relay against its advertised `max_limit`. A relay that
 * caps silently returns a truncated set with no indication it was truncated, so
 * asking for exactly what it will give is the only way a short answer means "that
 * is all there is".
 */
export function searchFilters(
  options: SearchFilterOptions,
): readonly RelayBasedFilter[] {
  const query = options.query.trim();
  if (query.length < MIN_SEARCH_QUERY_LENGTH) return [];
  if (options.kinds.length === 0) return [];

  const requested = options.limit ?? SEARCH_LIMIT;
  return options.routing.usable.map((relay) => {
    const filter: Filter = {
      kinds: [...options.kinds],
      search: query,
      limit: clampLimit(requested, relay.info),
    };
    return { relay: relay.url, filter };
  });
}
