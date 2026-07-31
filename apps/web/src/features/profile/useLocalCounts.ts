/**
 * How much of an author we hold locally.
 *
 * These are counts of events in *our* store, and the UI must label them that
 * way. A global post count is not something a Nostr client can know: it would
 * require every relay in existence to be asked and to answer honestly, and the
 * closest available shortcut — NIP-45 `COUNT` — is the relay's own number, taken
 * on trust. Rendering either as "1,204 posts" turns a local cache size into a
 * fact about a person.
 *
 * So the number shown is deliberately small and deliberately captioned. It is
 * useful ("we have some of this author's history") and it is honest.
 */

import { Kind } from "@setu/protocol";
import { useEffect, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";

export interface LocalAuthorCounts {
  readonly notes: number;
  readonly replies: number;
  readonly reposts: number;
  readonly reads: number;
}

const EMPTY: LocalAuthorCounts = { notes: 0, replies: 0, reposts: 0, reads: 0 };

/** True when the event carries an `e` tag, i.e. answers something. */
function tagsAnEvent(tags: readonly (readonly string[])[]): boolean {
  for (const tag of tags) {
    if (tag[0] === "e" && tag[1]) return true;
  }
  return false;
}

/**
 * Counts of an author's events held locally.
 *
 * One store observer, no subscription: whatever the profile's feed tabs pull in
 * lands in the store and is counted here for free. Opening a second REQ just to
 * count would spend a subscription slot on data already arriving.
 */
export function useLocalCounts(pubkey: string): LocalAuthorCounts {
  const engine = useEngine();
  const [counts, setCounts] = useState<LocalAuthorCounts>(EMPTY);

  useEffect(() => {
    setCounts(EMPTY);
    if (pubkey.length === 0) return;

    return engine.store.observe(
      {
        kinds: [Kind.ShortTextNote, Kind.Repost, Kind.LongFormArticle],
        authors: [pubkey],
      },
      (events) => {
        let notes = 0;
        let replies = 0;
        let reposts = 0;
        let reads = 0;
        for (const { event } of events) {
          switch (event.kind) {
            case Kind.Repost:
              reposts += 1;
              break;
            case Kind.LongFormArticle:
              reads += 1;
              break;
            case Kind.ShortTextNote:
              if (tagsAnEvent(event.tags)) replies += 1;
              else notes += 1;
              break;
            default:
              break;
          }
        }
        setCounts({ notes, replies, reposts, reads });
      },
    );
  }, [engine, pubkey]);

  return counts;
}
