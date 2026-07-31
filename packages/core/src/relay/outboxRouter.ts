/**
 * NIP-65 outbox routing.
 *
 * The outbox model in one sentence: to read an author's events, ask *that
 * author's write relays*, not your own. This module answers "which relays" and
 * nothing else — it is a pure function of what the store already holds (cached
 * kind-10002 events) plus configuration. It never opens a socket, which is what
 * makes it safe to call on every feed assembly and trivial to test.
 *
 * Two caps keep it from degenerating. `maxRelaysPerAuthor` stops one author with
 * a 30-relay list from dominating a query, and `maxRelaysPerQuery` bounds the
 * total socket count — relays advertise `max_subscriptions` for a reason, and
 * fanning one feed across forty relays is how a client gets rate-limited.
 */

import type {
  Filter,
  Hex32,
  NostrEvent,
  RelayBasedFilter,
  RelayUsage,
} from "@setu/protocol";
import type { EventStore } from "../contracts";
import { KIND_RELAY_LIST } from "../store/kinds";
import { normalizeRelayUrl, normalizeRelayUrls } from "./normalize";

/** Construction options for {@link OutboxRouter}. */
export interface OutboxRouterOptions {
  /** Source of cached kind-10002 events. Read-only. */
  readonly store: EventStore;
  /** Used when an author has no relay list, or as top-up when caps bite. */
  readonly fallbackRelays: readonly string[];
  /** Max relays taken from any single author's list. Default 3. */
  readonly maxRelaysPerAuthor?: number;
  /** Max distinct relays in a single routing result. Default 8. */
  readonly maxRelaysPerQuery?: number;
}

/**
 * Parses a kind-10002 relay list into usages.
 *
 * A bare `["r", url]` marker means both read and write, per NIP-65. Unknown
 * markers are treated as both rather than dropped, so a relay list with a typo
 * degrades to "usable" instead of "invisible".
 */
export function parseRelayList(event: NostrEvent): readonly RelayUsage[] {
  const out: RelayUsage[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "r") continue;
    const raw = tag[1];
    if (raw === undefined || raw === "") continue;
    const url = normalizeRelayUrl(raw);
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    const marker = tag[2];
    const read = marker !== "write";
    const write = marker !== "read";
    out.push({ url, read, write });
  }
  return out;
}

/** Routes reads and writes across relays using cached NIP-65 lists. */
export class OutboxRouter {
  private readonly maxPerAuthor: number;
  private readonly maxPerQuery: number;
  private readonly fallback: readonly string[];

  constructor(private readonly options: OutboxRouterOptions) {
    this.maxPerAuthor = Math.max(1, options.maxRelaysPerAuthor ?? 3);
    this.maxPerQuery = Math.max(1, options.maxRelaysPerQuery ?? 8);
    this.fallback = normalizeRelayUrls(options.fallbackRelays);
  }

  /** The configured fallback relay set, normalised. */
  get fallbackRelays(): readonly string[] {
    return this.fallback;
  }

  /** The cached relay list for a pubkey, or `undefined` if we hold none. */
  async relayListFor(
    pubkey: Hex32,
  ): Promise<readonly RelayUsage[] | undefined> {
    const rows = await this.options.store.query({
      kinds: [KIND_RELAY_LIST],
      authors: [pubkey],
      limit: 1,
    });
    const newest = rows[0];
    if (newest === undefined) return undefined;
    const parsed = parseRelayList(newest.event);
    return parsed.length === 0 ? undefined : parsed;
  }

  /**
   * Where to *read* an author's events: their advertised write relays, capped,
   * falling back to the configured set when they advertise nothing.
   */
  async readRelaysFor(pubkey: Hex32): Promise<readonly string[]> {
    const list = await this.relayListFor(pubkey);
    if (list === undefined) return this.fallback.slice(0, this.maxPerAuthor);
    const writes = list
      .filter((usage) => usage.write)
      .map((usage) => usage.url);
    if (writes.length === 0) return this.fallback.slice(0, this.maxPerAuthor);
    return writes.slice(0, this.maxPerAuthor);
  }

  /**
   * Where to *reach* an author: their advertised read (inbox) relays. Use this
   * when publishing something addressed to them, e.g. a mention or a DM.
   */
  async inboxRelaysFor(pubkey: Hex32): Promise<readonly string[]> {
    const list = await this.relayListFor(pubkey);
    if (list === undefined) return this.fallback.slice(0, this.maxPerAuthor);
    const reads = list.filter((usage) => usage.read).map((usage) => usage.url);
    if (reads.length === 0) return this.fallback.slice(0, this.maxPerAuthor);
    return reads.slice(0, this.maxPerAuthor);
  }

  /** Our own write relays, for publishing. Falls back to the configured set. */
  async writeRelays(ownPubkey: Hex32): Promise<readonly string[]> {
    return this.readRelaysFor(ownPubkey);
  }

  /** Per-author read relays for a batch of pubkeys, uncapped by query. */
  async relaysForAuthors(
    pubkeys: readonly Hex32[],
  ): Promise<ReadonlyMap<Hex32, readonly string[]>> {
    const out = new Map<Hex32, readonly string[]>();
    for (const pubkey of dedupe(pubkeys)) {
      out.set(pubkey, await this.readRelaysFor(pubkey));
    }
    return out;
  }

  /**
   * Builds relay-bound filters for a set of authors.
   *
   * Relay selection is a greedy set cover over the authors, capped at
   * `maxRelaysPerQuery`: pick the relay that serves the most not-yet-covered
   * authors, repeat. That gives near-minimal socket count for full coverage. If
   * the cap is hit before everyone is covered, the fallback relays are used to
   * mop up rather than dropping those authors from the feed silently.
   *
   * `template` supplies everything except `authors`, which this fills in per
   * relay.
   */
  async route(
    pubkeys: readonly Hex32[],
    template: Filter = {},
  ): Promise<readonly RelayBasedFilter[]> {
    const authors = dedupe(pubkeys);
    if (authors.length === 0) {
      return this.fallback
        .slice(0, this.maxPerQuery)
        .map((relay) => ({ relay, filter: { ...template } }));
    }

    const perAuthor = await this.relaysForAuthors(authors);
    const relayToAuthors = new Map<string, Set<Hex32>>();
    for (const [pubkey, relays] of perAuthor) {
      for (const relay of relays) {
        const bucket = relayToAuthors.get(relay);
        if (bucket === undefined) relayToAuthors.set(relay, new Set([pubkey]));
        else bucket.add(pubkey);
      }
    }

    const selected = this.greedyCover(relayToAuthors, authors);

    const filters: RelayBasedFilter[] = [];
    for (const relay of selected) {
      const covered = relayToAuthors.get(relay);
      const relayAuthors =
        covered === undefined ? authors : authors.filter((a) => covered.has(a));
      if (relayAuthors.length === 0) continue;
      filters.push({
        relay,
        filter: { ...template, authors: [...relayAuthors] },
      });
    }
    return filters;
  }

  /**
   * Selects at most `maxRelaysPerQuery` relays covering as many authors as
   * possible, topping up with fallbacks for anyone left uncovered.
   */
  private greedyCover(
    relayToAuthors: ReadonlyMap<string, Set<Hex32>>,
    authors: readonly Hex32[],
  ): readonly string[] {
    const uncovered = new Set(authors);
    const selected: string[] = [];

    while (uncovered.size > 0 && selected.length < this.maxPerQuery) {
      let best: string | undefined;
      let bestGain = 0;
      for (const [relay, covered] of relayToAuthors) {
        if (selected.includes(relay)) continue;
        let gain = 0;
        for (const pubkey of covered) if (uncovered.has(pubkey)) gain += 1;
        if (gain > bestGain) {
          bestGain = gain;
          best = relay;
        }
      }
      if (best === undefined || bestGain === 0) break;
      selected.push(best);
      for (const pubkey of relayToAuthors.get(best) ?? []) {
        uncovered.delete(pubkey);
      }
    }

    if (uncovered.size > 0) {
      for (const relay of this.fallback) {
        if (selected.length >= this.maxPerQuery) break;
        if (selected.includes(relay)) continue;
        selected.push(relay);
        const bucket = relayToAuthors.get(relay) ?? new Set<Hex32>();
        for (const pubkey of uncovered) bucket.add(pubkey);
        (relayToAuthors as Map<string, Set<Hex32>>).set(relay, bucket);
        uncovered.clear();
        break;
      }
    }
    return selected;
  }
}

function dedupe(values: readonly Hex32[]): readonly Hex32[] {
  const seen = new Set<Hex32>();
  const out: Hex32[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
