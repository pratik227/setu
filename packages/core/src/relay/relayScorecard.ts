/**
 * What each relay has *actually delivered*, measured from stored provenance.
 *
 * NIP-11 (`relayInfo.ts`) is what a relay says about itself; this is what it did.
 * The distinction is the whole module. Relays specialise — one is purpose-built for
 * profiles, another carries long-form, a third is a general firehose — and almost
 * none of that is stated in any document. But every stored event already records
 * which relays served it (`provenance.relays`), so the specialisation is sitting in
 * the store as a measurable fact. This module aggregates it.
 *
 * ## Where the answer comes from, and what that makes it
 *
 * A count here is "of the newest N events of this class that this device holds, how
 * many did that relay deliver". It is a *local sample*, the same claim discipline as
 * everything else in this codebase: not "this relay carries 2% of the network's
 * long-form" (unknowable without an indexer) but "this relay delivered none of the
 * long-form you have" (measured, and exactly what a reader deciding whether to keep
 * the relay needs). Callers labelling these numbers must say they were measured on
 * this device.
 *
 * ## What the ordering is allowed to do
 *
 * `orderByDelivery` reorders; it never drops. A relay with no measured delivery may
 * be newly added, may serve a kind this device has not asked for yet, or the store
 * may simply be empty on first run — all three look identical to a counter, and
 * only one of them means the relay is useless. So proven deliverers move to the
 * front, everything else keeps its configured position behind them, and the
 * bootstrap case (no scorecard at all) degrades to exactly the configured order —
 * the behaviour that existed before this module did.
 *
 * That matters because of where the ordering is used: the outbox router's fallback
 * paths are capped (`maxRelaysPerAuthor`, typically 3), so *order decides which
 * relays are consulted at all* for an author with no published relay list. Before
 * this, that decision belonged to the order the user happened to type their relay
 * list in — a profile lookup could miss the one relay built for profiles because it
 * was fourth in a list of four.
 *
 * ## `exclusive` — the number that says what removal costs
 *
 * Total delivery overstates a relay's value: four relays all carrying the same
 * notes are interchangeable, and each shows a high total. `exclusive` counts the
 * rows *only* that relay served — the events that would not be on this device
 * without it. A relay with a large total and zero exclusives is redundant; one with
 * a modest total and many exclusives is load-bearing. The settings screen shows it
 * so "remove this relay" is an informed decision rather than a guess.
 *
 * Kind literals with comments, matching `retention.ts` and `muteIngest.ts`: this is
 * measurement policy, and measurement policy in this package does not depend on the
 * protocol package's kind table.
 */

import type { StoredEvent } from "../contracts";
import { normalizeRelayUrl } from "./normalize";

/** The content classes a relay's delivery is broken down into. */
export type ContentClass =
  | "profiles"
  | "relayLists"
  | "notes"
  | "longform"
  | "media"
  | "reactions"
  | "zapReceipts"
  | "privateWraps";

/** Kind → class. Anything unlisted is not scored rather than guessed at. */
const CLASS_OF_KIND: ReadonlyMap<number, ContentClass> = new Map([
  [0, "profiles"], // kind 0 metadata
  [10002, "relayLists"], // NIP-65
  [10050, "relayLists"], // NIP-17 DM inbox list
  [1, "notes"], // short text note
  [6, "notes"], // repost
  [16, "notes"], // generic repost
  [1111, "notes"], // NIP-22 comment
  [30023, "longform"], // NIP-23 article
  [20, "media"], // NIP-68 picture
  [21, "media"], // NIP-71 video
  [22, "media"], // NIP-71 short video
  [7, "reactions"], // NIP-25
  [9735, "zapReceipts"], // NIP-57
  [1059, "privateWraps"], // NIP-59 gift wrap
]);

/** The class a kind is scored under, or undefined when it is not scored. */
export function contentClassOf(kind: number): ContentClass | undefined {
  return CLASS_OF_KIND.get(kind);
}

/**
 * The classes a filter's kinds touch. Empty or absent kinds mean "everything":
 * a caller routing a kind-less filter is asking a general question, and ranking
 * it by any single class would bias it for no reason.
 */
export function classesForKinds(
  kinds: readonly number[] | undefined,
): ReadonlySet<ContentClass> {
  if (kinds === undefined || kinds.length === 0) {
    return new Set(CLASS_OF_KIND.values());
  }
  const classes = new Set<ContentClass>();
  for (const kind of kinds) {
    const cls = CLASS_OF_KIND.get(kind);
    if (cls !== undefined) classes.add(cls);
  }
  // A filter entirely of unscored kinds is also a general question — see above.
  return classes.size === 0 ? new Set(CLASS_OF_KIND.values()) : classes;
}

/** One relay's measured delivery. */
export interface RelayScore {
  readonly url: string;
  /** Rows this relay served, across every scored class. */
  readonly total: number;
  /** Rows *only* this relay served — what removing it would have cost. */
  readonly exclusive: number;
  readonly byClass: ReadonlyMap<ContentClass, number>;
}

export type RelayScorecard = ReadonlyMap<string, RelayScore>;

/**
 * Aggregate stored rows into per-relay scores.
 *
 * Pure, so the decision "what counts as delivery" is testable without a store: a
 * row counts once per relay in its provenance, and once for `exclusive` when the
 * provenance names exactly one relay. URLs are normalised so `wss://a.example` and
 * `wss://a.example/` are one relay, matching the pool's own normalisation —
 * without it a relay's score would silently split across two spellings.
 */
export function scoreRows(rows: readonly StoredEvent[]): RelayScorecard {
  const scores = new Map<
    string,
    { total: number; exclusive: number; byClass: Map<ContentClass, number> }
  >();
  for (const row of rows) {
    const cls = contentClassOf(row.event.kind);
    if (cls === undefined) continue;
    const relays = [
      ...new Set(row.provenance.relays.map((url) => normalizeRelayUrl(url))),
    ].filter((url) => url !== "");
    for (const url of relays) {
      let score = scores.get(url);
      if (score === undefined) {
        score = { total: 0, exclusive: 0, byClass: new Map() };
        scores.set(url, score);
      }
      score.total += 1;
      if (relays.length === 1) score.exclusive += 1;
      score.byClass.set(cls, (score.byClass.get(cls) ?? 0) + 1);
    }
  }
  const out = new Map<string, RelayScore>();
  for (const [url, score] of scores) {
    out.set(url, { url, ...score });
  }
  return out;
}

/** A relay's measured delivery for a set of classes. */
function deliveryFor(
  score: RelayScore | undefined,
  classes: ReadonlySet<ContentClass>,
): number {
  if (score === undefined) return 0;
  let sum = 0;
  for (const cls of classes) sum += score.byClass.get(cls) ?? 0;
  return sum;
}

/**
 * Order a relay set by measured delivery for the kinds being asked about.
 *
 * Proven deliverers first, most-delivering first; ties and everything unmeasured
 * keep their input order. Nothing is dropped — see the module doc for why a zero
 * is not evidence of uselessness. With no scorecard the input comes back
 * untouched, which is the bootstrap behaviour every caller must be safe under.
 */
export function orderByDelivery(
  urls: readonly string[],
  scorecard: RelayScorecard | undefined,
  kinds?: readonly number[],
): readonly string[] {
  if (scorecard === undefined || scorecard.size === 0) return urls;
  const classes = classesForKinds(kinds);
  const measured: { url: string; delivery: number; position: number }[] = [];
  const unmeasured: string[] = [];
  urls.forEach((url, position) => {
    const delivery = deliveryFor(
      scorecard.get(normalizeRelayUrl(url)),
      classes,
    );
    if (delivery > 0) measured.push({ url, delivery, position });
    else unmeasured.push(url);
  });
  // Stable by construction: sort compares position on equal delivery, and the
  // unmeasured tail preserves input order outright.
  measured.sort((a, b) =>
    b.delivery !== a.delivery
      ? b.delivery - a.delivery
      : a.position - b.position,
  );
  return [...measured.map((entry) => entry.url), ...unmeasured];
}

/** Every scored kind, for callers assembling the store queries. */
export const SCORED_KINDS: readonly number[] = [...CLASS_OF_KIND.keys()];

/**
 * How many newest rows per class a refresh samples.
 *
 * Per class rather than one shared cap, and that is load-bearing: a single
 * newest-N query across all kinds returns almost entirely kind-1 — notes dwarf
 * everything — so profiles and long-form would be crowded out of their own
 * measurement. Sampling newest-per-class also makes the score reflect *current*
 * relay behaviour rather than history: a relay that stopped carrying long-form
 * last month fades out of the sample as newer rows displace older ones.
 */
export const SCORECARD_SAMPLE_PER_CLASS = 1_000;

/** The queries a refresh runs, one per class. */
export function scorecardQueries(): readonly {
  readonly kinds: readonly number[];
  readonly limit: number;
}[] {
  const byClass = new Map<ContentClass, number[]>();
  for (const [kind, cls] of CLASS_OF_KIND) {
    const bucket = byClass.get(cls);
    if (bucket === undefined) byClass.set(cls, [kind]);
    else bucket.push(kind);
  }
  return [...byClass.values()].map((kinds) => ({
    kinds,
    limit: SCORECARD_SAMPLE_PER_CLASS,
  }));
}
