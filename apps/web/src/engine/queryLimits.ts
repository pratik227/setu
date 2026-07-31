/**
 * The bounds this app puts on relay queries.
 *
 * Every filter that goes to a relay carries a `limit`. This is not tidiness: a
 * filter without one asks each relay for *everything* matching, and NIP-01 lets a
 * relay answer that literally. The failure is not gradual — one popular note in
 * the visible set turns a counts query into tens of thousands of events, which
 * fills the store, saturates signature verification and freezes the tab.
 *
 * The values live here rather than at each call site so the reasoning is
 * comparable: a bound is only defensible relative to how many events *can*
 * legitimately match, and that differs by three orders of magnitude between a
 * replaceable list and a reaction query.
 */

/**
 * Copies of one replaceable list (kind 3, kind 10003) to ask each relay for.
 *
 * Only one event can be current, and the store enforces newest-wins, so `1` is the
 * theoretically correct answer. It is deliberately a little larger: newest-wins is
 * decided *locally*, and a relay that answers a `limit: 1` query with a stale copy
 * of a follow or bookmark list would strand the account on an old list — and for
 * these two kinds, publishing an edit built from an old list deletes everything
 * missing from it. A handful of events is free; being wrong about which one is
 * newest is not.
 */
export const REPLACEABLE_LIST_LIMIT = 4;

/**
 * The bound for a filter that names event ids.
 *
 * Ids are unique, so *n* ids can match at most *n* events: this is an exact bound
 * rather than a guess, and it costs a relay nothing to honour.
 */
export function idLookupLimit(idCount: number): number {
  return Math.max(1, idCount);
}
