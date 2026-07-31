/**
 * Which relays to read an author from.
 *
 * The outbox model, applied to one author: their notes live on the relays *they*
 * publish to, advertised in their kind-10002. Asking our own read set instead is
 * how a client shows an empty profile for someone who posts constantly to relays
 * we happen not to use.
 *
 * `OutboxRouter` answers the question, purely, from what the store already holds
 * — so the sequence is: ask the profile batcher for the relay list, watch the
 * store for it, and re-resolve when it lands. Until then the router's own
 * fallback (the configured read set) applies, which is why the first render is
 * useful rather than empty.
 */

import { Kind } from "@setu/protocol";
import { useEffect, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";

/** Compare by content so an unchanged answer keeps its array identity. */
function sameRelays(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The author's advertised write relays, falling back to the engine's read set.
 *
 * The returned array is reference-stable while its contents are unchanged, which
 * matters: it feeds a `FeedDefinition`, and a new identity per render would tear
 * down and rebuild the feed.
 */
export function useAuthorRelays(pubkey: string): readonly string[] {
  const engine = useEngine();
  const [relays, setRelays] = useState<readonly string[]>(engine.relays);

  useEffect(() => {
    let cancelled = false;

    const resolve = () => {
      void engine.outbox
        .readRelaysFor(pubkey)
        .then((resolved) => {
          if (cancelled) return;
          // `readRelaysFor` already falls back to the configured set, so an
          // empty answer would mean the fallback itself is empty — treat the
          // engine's list as the floor either way.
          const next = resolved.length > 0 ? resolved : engine.relays;
          setRelays((prev) => (sameRelays(prev, next) ? prev : next));
        })
        .catch(() => {
          if (!cancelled) setRelays(engine.relays);
        });
    };

    // Kicks off both kind 0 and kind 10002 for this author, batched.
    engine.profiles.request([pubkey]);
    resolve();

    // Re-resolve when the relay list arrives or is replaced by a newer one.
    const unobserve = engine.store.observe(
      { kinds: [Kind.RelayList], authors: [pubkey] },
      (events) => {
        if (events.length > 0) resolve();
      },
    );

    return () => {
      cancelled = true;
      unobserve();
    };
  }, [engine, pubkey]);

  return relays;
}
