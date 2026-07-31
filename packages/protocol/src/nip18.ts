/**
 * NIP-18 quote reposts.
 *
 * A quote repost is an ordinary kind-1 that embeds a `nostr:nevent…` reference in
 * its content *and* carries a `q` tag naming the same event. The inline reference
 * is what a renderer walks, so it is the primary signal; the `q` tag is what makes
 * quotes queryable, and it is the only signal when an author's client wrote the
 * tag without the reference.
 *
 * Kept separate from the NIP-10 helpers in `tags.ts` on purpose: a `q` tag is
 * explicitly *not* a thread edge. Treating it as one files every quote under the
 * note it quotes, which is how a quote of a stranger's post ends up in that
 * stranger's reply thread.
 */

import { isHex32 } from "./hex";
import { getTagged, type HasTags } from "./tags";
import type { Hex32 } from "./types";

/**
 * Event ids this note quotes, in tag order, deduplicated.
 *
 * A `q` value that is not a 32-byte event id is dropped rather than passed on: it
 * would become an id in a relay filter, and a filter carrying a malformed id is
 * one some relays reject outright — taking the whole batch of real ids with it.
 */
export function quotedEventIds(event: HasTags): Hex32[] {
  const seen = new Set<string>();
  for (const tag of getTagged(event, "q")) {
    const id = tag[1];
    if (id === undefined || !isHex32(id)) continue;
    seen.add(id);
  }
  return [...seen];
}
