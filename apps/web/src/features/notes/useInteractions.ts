/**
 * Interaction counts for the notes on screen — one subscription for the whole app.
 *
 * Reactions, reposts, replies and zap receipts are the highest-volume kinds on the
 * network, and the naive shapes of this query are the two worst subscriptions a
 * client can make:
 *
 *  1. **Per note.** Forty rows, forty REQs, and the relay's subscription cap is
 *     gone before the avatars have loaded.
 *  2. **Per surface, replaced whenever the id set changes.** A live feed's id set
 *     changes several times a second, so the REQ is cancelled and reopened before
 *     any relay answers — measured at five to seven re-subscribes per relay in
 *     fourteen seconds, with the feed and the thread panel each doing it.
 *
 * So there is one tracker per (engine, viewer) for the entire app. Every surface
 * registers the ids it cares about; the tracker keeps a **grow-only union** of them
 * and republishes on the policy in `InterestSet` — enough new ids to be worth a
 * round trip, and enough elapsed time since the last one. A thread panel opening
 * beside a feed therefore adds ids to an existing subscription instead of opening
 * a second one.
 *
 * The network filter carries a `limit`; the local read deliberately does not. A
 * relay serves the newest N matching events, so a bound is what stops one popular
 * note from flooding the store — but the same bound applied to the *local* query
 * would make counts fall as newer interactions pushed older ones out of the
 * window, and a like count that goes down is worse than one that is merely a
 * floor. Notes that reach the bound are marked `approximate` and rendered as
 * "500+" rather than as a total (see `interactionCounts.ts`).
 *
 * Counts come from events we hold and verified. A NIP-45 `COUNT` would be one
 * round trip for the same numbers, and is refused: it asks the relay to be
 * authoritative for a figure we cannot check.
 *
 * The reader's mute list is applied to the tally, not to the query. Asking relays
 * for "interactions except these authors" is not expressible in NIP-01 — filters
 * have no negation — and asking per-author would multiply the one subscription this
 * whole module exists to keep singular. So the events arrive and the mute rules are
 * applied in `countInteractions`, which also means an un-mute restores the real
 * number immediately from events already held, with no round trip at all.
 */

import type { Engine, MuteRules } from "@setu/core";
import { NO_MUTES } from "@setu/core";
import type { Filter, NostrEvent } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { InterestSet } from "../../engine/interestSet";
import {
  acquireSharedSubscription,
  filtersContentKey,
} from "../../engine/sharedSubscription";
import { useMuteRules } from "../moderation/useMuteList";
import {
  countInteractions,
  INTERACTION_KINDS,
  type NoteInteractions,
} from "./interactionCounts";

/**
 * Notes tracked at once.
 *
 * The union is capped because note ids, unlike author pubkeys, never repeat: an
 * uncapped union would eventually put a thousand `#e` values in one filter, which
 * relays either reject or answer slowly. Four screens' worth of rows fits, and the
 * least recently wanted ids are dropped first.
 */
const MAX_TRACKED_NOTES = 160;

/**
 * Interactions asked of each relay per subscription.
 *
 * Sized against the union above: 160 notes at a typical handful of interactions
 * each fits comfortably, while one brigaded note is capped at 500 events per relay
 * instead of every reaction it ever received. That cap is the whole point — an
 * unbounded `{kinds:[1,1111,6,7,9735], "#e":[…160 ids]}` across four relays asks
 * for every reaction, repost, reply and zap ever made against 160 notes.
 */
const INTERACTION_LIMIT = 500;

/**
 * Republish policy. See `InterestSet` for why each number exists.
 *
 * `threshold` is a screenful of new rows, so a trickle of arriving notes does not
 * pay for a round trip. `cooldownMs` bounds a busy feed to roughly six
 * re-subscribes a minute per relay. `maxStaleMs` closes the gap the threshold
 * leaves: a feed that goes quiet holding fewer than `threshold` uncovered ids
 * still gets them, just later.
 */
const POLICY = {
  max: MAX_TRACKED_NOTES,
  threshold: 8,
  cooldownMs: 10_000,
  maxStaleMs: 30_000,
} as const;

/** How long a burst of new ids is allowed to accumulate before it is published. */
const SETTLE_MS = 700;

const NO_COUNTS: ReadonlyMap<string, NoteInteractions> = new Map();

/** The app-wide tracker for one (engine, viewer) pair. */
class InteractionTracker {
  private readonly interest = new InterestSet(POLICY);
  private readonly listeners = new Set<() => void>();
  private counts: ReadonlyMap<string, NoteInteractions> = NO_COUNTS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private releaseSubscription: (() => void) | null = null;
  private unobserve: (() => void) | null = null;
  private disposed = false;
  private muteRules: MuteRules = NO_MUTES;
  /**
   * The last set the store handed us, kept so a mute list edit can be re-tallied
   * without waiting for another event to arrive.
   *
   * Un-muting has to put the real number back *now* — a reader who un-mutes and
   * watches a reply count stay wrong concludes the un-mute did not work. Holding
   * these costs nothing: they are the same arrays the store is already holding, not
   * copies.
   */
  private lastTally:
    | {
        readonly ids: readonly string[];
        readonly events: readonly NostrEvent[];
      }
    | undefined;

  constructor(
    private readonly engine: Engine,
    private readonly viewerPubkey: string | undefined,
  ) {}

  /** Latest counts. Identity changes only when some note's counts changed. */
  snapshot(): ReadonlyMap<string, NoteInteractions> {
    return this.counts;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Register interest in some notes. Cheap enough to call on every render. */
  want(ids: readonly string[]): void {
    if (this.disposed) return;
    this.interest.want(ids);
    this.schedule();
  }

  /**
   * Point the tally at a new mute list.
   *
   * Compared by reference, because `useMuteRules` gives one identity per version of
   * the list — the store re-emits that list several times a second, and re-tallying
   * every held interaction on each of those would be the most expensive thing this
   * class does.
   */
  setMuteRules(rules: MuteRules): void {
    if (this.disposed || this.muteRules === rules) return;
    this.muteRules = rules;
    const held = this.lastTally;
    if (held !== undefined) this.absorb(held.ids, held.events);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.unobserve?.();
    this.unobserve = null;
    this.releaseSubscription?.();
    this.releaseSubscription = null;
    this.listeners.clear();
    this.counts = NO_COUNTS;
    this.lastTally = undefined;
  }

  /**
   * Arm the republish timer.
   *
   * A leading schedule, not a debounce that re-arms: on a live feed ids arrive
   * faster than any sensible delay, so pushing the timer back on every change
   * means no REQ is ever sent. A pending timer is left alone, and whatever has
   * accumulated when it fires is what gets published.
   */
  private schedule(): void {
    if (this.disposed || this.timer !== null) return;
    const delay = this.interest.delayUntilPublishable(Date.now());
    if (delay === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.republish();
      },
      Math.max(SETTLE_MS, delay),
    );
  }

  private republish(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (!this.interest.shouldPublish(now)) {
      this.schedule();
      return;
    }
    const ids = this.interest.publish(now);
    if (ids.length === 0) return;

    // Bounded on the wire, unbounded locally — see the module doc.
    const query: Filter = {
      kinds: [...INTERACTION_KINDS],
      "#e": [...ids],
      limit: INTERACTION_LIMIT,
    };
    const local: Filter = { kinds: [...INTERACTION_KINDS], "#e": [...ids] };

    const previousRelease = this.releaseSubscription;
    const previousUnobserve = this.unobserve;
    // Released before the new lease is taken so a content-keyed share cannot
    // resolve to the outgoing subscription.
    previousUnobserve?.();
    previousRelease?.();

    this.releaseSubscription = acquireSharedSubscription(
      this.engine,
      `interactions:${filtersContentKey([query])}`,
      [query],
    );
    this.unobserve = this.engine.store.observe(local, (events) => {
      this.absorb(
        ids,
        events.map((stored) => stored.event),
      );
    });
  }

  private absorb(ids: readonly string[], events: readonly NostrEvent[]): void {
    this.lastTally = { ids, events };
    const next = countInteractions({
      noteIds: ids,
      events,
      ...(this.viewerPubkey ? { viewerPubkey: this.viewerPubkey } : {}),
      limit: INTERACTION_LIMIT,
      muteRules: this.muteRules,
      previous: this.counts,
    });
    // Reference-equal when nothing changed, so a store tick that touched an
    // unrelated note re-renders nothing at all.
    if (next === this.counts) return;
    this.counts = next;
    for (const listener of this.listeners) listener();
  }
}

interface TrackerEntry {
  readonly tracker: InteractionTracker;
  refs: number;
}

/** Keyed by engine, so an account or relay-set change starts from nothing. */
const registry = new WeakMap<Engine, Map<string, TrackerEntry>>();

function acquireTracker(
  engine: Engine,
  viewerPubkey: string | undefined,
): InteractionTracker {
  let byViewer = registry.get(engine);
  if (!byViewer) {
    byViewer = new Map();
    registry.set(engine, byViewer);
  }
  const key = viewerPubkey ?? "";
  const existing = byViewer.get(key);
  if (existing) {
    existing.refs += 1;
    return existing.tracker;
  }
  const tracker = new InteractionTracker(engine, viewerPubkey);
  byViewer.set(key, { tracker, refs: 1 });
  return tracker;
}

/** The live tracker for this pair, if some component is holding one. */
function peekTracker(
  engine: Engine,
  viewerPubkey: string | undefined,
): InteractionTracker | undefined {
  return registry.get(engine)?.get(viewerPubkey ?? "")?.tracker;
}

function releaseTracker(
  engine: Engine,
  viewerPubkey: string | undefined,
): void {
  const byViewer = registry.get(engine);
  const key = viewerPubkey ?? "";
  const entry = byViewer?.get(key);
  if (!entry || !byViewer) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  byViewer.delete(key);
  entry.tracker.dispose();
}

/**
 * Counts for a set of visible notes.
 *
 * The returned map covers every note the *app* is tracking, not just the ids
 * passed in — a superset is free, since it is one shared query, and callers look
 * up by id anyway. Entries are reference-stable across ticks: a note whose events
 * did not change comes back as the same object, so an arriving reaction re-renders
 * one row rather than the whole feed.
 *
 * Totals exclude accounts the reader has muted, and each entry carries `mutedOut`
 * saying how many were left out, so a surface can state it rather than showing a
 * number that quietly shrank.
 */
export function useInteractions(
  noteIds: readonly string[],
  viewerPubkey?: string,
): ReadonlyMap<string, NoteInteractions> {
  const engine = useEngine();
  // Read half only, and app-wide shared: this hook runs on every feed, thread and
  // notification surface, so acquiring the write path here would put a publish
  // capability behind a read of some numbers.
  const { rules } = useMuteRules();
  const [counts, setCounts] =
    useState<ReadonlyMap<string, NoteInteractions>>(NO_COUNTS);

  // Lease the shared tracker. Declared before the interest effect below so it has
  // run by the time interest is registered, on mount and on every change.
  useEffect(() => {
    const tracker = acquireTracker(engine, viewerPubkey);
    setCounts(tracker.snapshot());
    const unsubscribe = tracker.subscribe(() => setCounts(tracker.snapshot()));
    return () => {
      unsubscribe();
      releaseTracker(engine, viewerPubkey);
    };
  }, [engine, viewerPubkey]);

  /*
   * Mute rules are handed over in an effect of their own, not in the lease above.
   *
   * Listing `rules` as a dependency of the lease would tear the tracker down and
   * rebuild it on every mute edit — releasing the shared subscription and opening a
   * new REQ for numbers we already hold. This effect only re-tallies. It runs after
   * the lease on mount (declaration order), so the rules are in place before any
   * event can arrive, and `setMuteRules` is a no-op on an unchanged rule set.
   */
  useEffect(() => {
    peekTracker(engine, viewerPubkey)?.setMuteRules(rules);
  }, [engine, viewerPubkey, rules]);

  // Content identity of the caller's set: a feed rebuilds this array on every
  // render, and registering interest on object identity would run every render.
  const key = useMemo(() => [...new Set(noteIds)].sort().join(","), [noteIds]);

  useEffect(() => {
    if (key === "") return;
    // The lease effect above has already run, so the tracker exists. Peeking
    // rather than acquiring keeps this path from ever creating one it would then
    // have to dispose of.
    peekTracker(engine, viewerPubkey)?.want(key.split(","));
  }, [engine, viewerPubkey, key]);

  return counts;
}
