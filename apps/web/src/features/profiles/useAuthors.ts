import { encodeNpub, Kind, truncateNpub } from "@setu/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import type { AuthorView } from "../notes/types";
import { nip05DisplayName } from "./nip05";
import { parseProfileContent, preferredName } from "./profileContent";
import { type Nip05Candidate, useNip05Batch } from "./useNip05";

/** Placeholder author for a pubkey whose metadata has not arrived. */
export function fallbackAuthor(pubkey: string): AuthorView {
  const npub = encodeNpub(pubkey);
  return {
    pubkey,
    resolved: false,
    displayName: npub ? truncateNpub(npub, 8) : pubkey.slice(0, 12),
    handle: npub ? truncateNpub(npub, 10) : pubkey.slice(0, 16),
  };
}

function toAuthorView(pubkey: string, content: string): AuthorView {
  const details = parseProfileContent(content);
  const fallback = fallbackAuthor(pubkey);

  return {
    pubkey,
    // A kind-0 arrived, so this author is resolved even if some fields are empty.
    resolved: true,
    displayName: preferredName(details) ?? fallback.displayName,
    handle: details.nip05 ? nip05DisplayName(details.nip05) : fallback.handle,
    ...(details.picture ? { avatarUrl: details.picture } : {}),
    ...(details.nip05 ? { nip05: details.nip05 } : {}),
    // Presence decides whether a row may offer a zap; the value is validated at
    // the point of use, never here.
    ...(details.lightning ? { lightning: details.lightning } : {}),
    // Left false here on purpose. The claim is displayed; the badge is not
    // granted until `useNip05Batch` below completes a round trip to the
    // author's own domain, because a checkmark from an unchecked claim asserts
    // something this client has not verified.
    verified: false,
  };
}

/** A jump this large earns the short wait rather than the long one. */
const RESUBSCRIBE_THRESHOLD = 8;
/** How long to wait for a growing pubkey set to settle before re-subscribing. */
const SETTLE_MS = 400;
/**
 * The wait for a trickle — a handful of new authors, not a feed page.
 *
 * Longer than `SETTLE_MS` so a live feed does not reinstall its observer
 * constantly, but finite, which is the whole point. This used to be "never":
 * growth below the threshold returned early without scheduling anything, so the
 * observer's filter stayed pinned to the authors of the *first* batch. A thread
 * panel that gained two replies therefore never observed their authors, and
 * their names and avatars stayed blank until eight more accumulated — which in a
 * three-reply thread does not happen. The profile was fetched and stored the
 * whole time; nothing was listening for it.
 */
const TRICKLE_MS = 1200;

/**
 * Resolve many authors at once, with NIP-05 verification layered on.
 *
 * Two properties matter more than they look:
 *
 * 1. **The interest set only grows, and resolved authors accumulate.** A live
 *    feed's author list churns every time a note arrives, so keying an effect on
 *    it directly means tearing down the subscription before any kind-0 can come
 *    back — the feed then shows truncated npubs forever. Instead we keep a
 *    growing set of pubkeys we have ever wanted and a persistent map of what we
 *    have resolved.
 * 2. **Re-subscription is debounced and batched.** One store observer and one
 *    batched network request cover the whole set. Relays cap concurrent
 *    subscriptions, and per-avatar fetching is the first thing to hit that
 *    ceiling.
 *
 * Verification is a *separate* pass over the resolved map rather than part of
 * resolution, so a slow or unreachable NIP-05 domain can never delay a name or
 * an avatar reaching the screen.
 */
export function useAuthors(
  pubkeys: readonly string[],
): ReadonlyMap<string, AuthorView> {
  const engine = useEngine();
  const [resolved, setResolved] = useState<ReadonlyMap<string, AuthorView>>(
    new Map(),
  );

  // Caches are scoped to the engine: swapping engines (relay set or account
  // change) must discard everything resolved under the old one. Deriving them
  // from `engine` makes that automatic instead of a cleanup that has to remember.
  const caches = useMemo(
    () => ({
      wanted: new Set<string>(),
      resolved: new Map<string, AuthorView>(),
      subscribedCount: 0,
    }),
    [engine],
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unobserve = useRef<(() => void) | null>(null);

  useEffect(() => {
    const fresh: string[] = [];
    for (const pubkey of pubkeys) {
      if (!caches.wanted.has(pubkey)) {
        caches.wanted.add(pubkey);
        fresh.push(pubkey);
      }
    }
    if (fresh.length === 0) return;

    // Ask the batcher immediately — it coalesces and rate-limits internally.
    engine.profiles.request(fresh);

    // Schedule once and let it fire. Re-arming the timer on every new pubkey
    // looks like a debounce but is a livelock: on a busy feed authors arrive
    // faster than the delay, so the callback is pushed back forever and the
    // observer is never installed. A pending timer is left alone; whatever has
    // accumulated by the time it fires is what gets subscribed.
    if (timer.current !== null) return;

    // Every growth gets scheduled — the size only decides how long it waits.
    const grown = caches.wanted.size - caches.subscribedCount;
    const delay =
      caches.subscribedCount === 0 || grown >= RESUBSCRIBE_THRESHOLD
        ? SETTLE_MS
        : TRICKLE_MS;
    timer.current = setTimeout(() => {
      timer.current = null;
      const all = [...caches.wanted];
      caches.subscribedCount = all.length;

      unobserve.current?.();
      unobserve.current = engine.store.observe(
        { kinds: [Kind.Metadata], authors: all },
        (events) => {
          let changed = false;
          for (const { event } of events) {
            // The store already enforces replaceable last-write-wins, so the
            // first row per author is the newest one.
            if (!caches.resolved.has(event.pubkey)) {
              caches.resolved.set(
                event.pubkey,
                toAuthorView(event.pubkey, event.content),
              );
              changed = true;
            }
          }
          if (changed) setResolved(new Map(caches.resolved));
        },
      );
    }, delay);
  }, [engine, pubkeys, caches]);

  // Release the timer and the store observer on unmount. The caches need no
  // teardown: they are derived from `engine` above, so a new engine already gets
  // empty ones and the old set becomes garbage with it.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      unobserve.current?.();
      unobserve.current = null;
    },
    [],
  );

  // Only authors who actually claim an identifier are candidates. Keyed on the
  // resolved map's identity, which changes only when an author is added.
  const candidates = useMemo(() => {
    const out: Nip05Candidate[] = [];
    for (const [pubkey, author] of resolved) {
      if (author.nip05) out.push({ pubkey, identifier: author.nip05 });
    }
    return out;
  }, [resolved]);

  const verification = useNip05Batch(candidates);

  return useMemo(() => {
    if (verification.size === 0) return resolved;
    const out = new Map(resolved);
    for (const [pubkey, status] of verification) {
      const author = out.get(pubkey);
      if (author === undefined) continue;
      const verified = status === "verified";
      if (author.verified === verified) continue;
      out.set(pubkey, { ...author, verified });
    }
    return out;
  }, [resolved, verification]);
}
