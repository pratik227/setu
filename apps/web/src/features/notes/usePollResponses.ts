/**
 * The kind-1018s answering the polls on screen — one subscription for the app.
 *
 * The same shape as `quotedNotes.ts` and `useInteractions.ts`, and for the same
 * reason: the obvious implementation puts the query inside the card, so a feed with
 * eighty polls in it opens eighty REQs and the relay's subscription cap is gone
 * before the first tally lands. Keying one REQ per surface on the id set is worse —
 * a live feed's set changes several times a second, so the subscription is
 * cancelled and reopened before any relay answers and no responses ever arrive.
 *
 * So there is one tracker per engine. Every mounted poll card registers its id, the
 * tracker keeps a grow-only union under `InterestSet`'s policy, and one filter
 * covers the lot.
 *
 * The network filter is bounded and the local read is not, exactly as
 * `useInteractions` explains: a relay serves the newest N, so a bound is what stops
 * one viral poll from flooding the store — while the same bound on the local query
 * would make an option's count *fall* as newer responses pushed older ones out of
 * the window, and a vote count that goes down is worse than one that is a floor.
 * When the observed set reaches the bound the tally is marked `bounded` and the card
 * says the number is a floor for that reason too.
 */

import type { Engine } from "@setu/core";
import {
  type Filter,
  Kind,
  type NostrEvent,
  type PollResponse,
  parsePollResponse,
} from "@setu/protocol";
import { useEffect, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { InterestSet } from "../../engine/interestSet";
import {
  acquireSharedSubscription,
  filtersContentKey,
} from "../../engine/sharedSubscription";

/**
 * Polls tracked at once.
 *
 * Smaller than the interaction tracker's union: a poll is a minority of rows, and
 * each id is only wanted by the one card rendering it. Several screens' worth fits,
 * and the least recently wanted ids are evicted first.
 */
const MAX_TRACKED_POLLS = 64;

/**
 * Responses asked of each relay per subscription.
 *
 * Sized against the union above — 64 polls at a few dozen responses each fits
 * comfortably, while one poll that went round the network is capped rather than
 * streaming every vote it ever received into the store.
 */
const RESPONSE_LIMIT = 500;

/** Republish policy. See `InterestSet` for why each number exists. */
const POLICY = {
  max: MAX_TRACKED_POLLS,
  threshold: 4,
  cooldownMs: 8_000,
  maxStaleMs: 4_000,
} as const;

/** How long a burst of new ids may accumulate before it is published. */
const SETTLE_MS = 400;

/** What one card knows about its poll's responses. */
export interface PollResponses {
  /** Every response we hold for this poll, in no particular order. */
  readonly responses: readonly PollResponse[];
  /**
   * True when the query reached its limit, so responses were withheld to honour
   * it. The card must present the tally as a floor rather than a total.
   */
  readonly bounded: boolean;
}

const NONE: PollResponses = { responses: [], bounded: false };

/** The app-wide tracker for one engine. */
class PollTracker {
  private readonly interest = new InterestSet(POLICY);
  private readonly listeners = new Set<() => void>();
  /** Reference-stable per poll: rebuilt only when that poll's set changed. */
  private byPoll = new Map<string, PollResponses>();
  /** Response ids already absorbed, so a re-emit is not a change. */
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private releaseSubscription: (() => void) | null = null;
  private unobserve: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly engine: Engine) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Register interest in one poll. Cheap enough to call per render. */
  want(pollId: string): void {
    if (this.disposed || pollId === "") return;
    this.interest.want([pollId]);
    this.schedule();
  }

  /**
   * This poll's responses.
   *
   * The same object until this poll's own set changes, so a hook comparing
   * identities re-renders one card when one vote lands rather than every card on
   * screen.
   */
  read(pollId: string): PollResponses {
    return this.byPoll.get(pollId) ?? NONE;
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
    this.byPoll = new Map();
  }

  /**
   * Arm the republish timer.
   *
   * A leading schedule, not a debounce that re-arms: on a live feed ids arrive
   * faster than any sensible delay, so pushing the timer back on every one means no
   * REQ is ever sent.
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

    const query: Filter = {
      kinds: [Kind.PollResponse],
      "#e": [...ids],
      limit: RESPONSE_LIMIT,
    };
    // Bounded on the wire, unbounded locally — see the module doc.
    const local: Filter = { kinds: [Kind.PollResponse], "#e": [...ids] };

    const previousRelease = this.releaseSubscription;
    const previousUnobserve = this.unobserve;
    // Released before the new lease is taken, so a content-keyed share cannot
    // resolve to the subscription that is on its way out.
    previousUnobserve?.();
    previousRelease?.();

    this.releaseSubscription = acquireSharedSubscription(
      this.engine,
      `polls:${filtersContentKey([query])}`,
      [query],
    );
    this.unobserve = this.engine.store.observe(local, (rows) => {
      this.absorb(rows.map((row) => row.event));
    });
  }

  private absorb(events: readonly NostrEvent[]): void {
    const fresh: PollResponse[] = [];
    for (const event of events) {
      if (this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      const parsed = parsePollResponse(event);
      if (parsed !== undefined) fresh.push(parsed);
    }
    // The store re-emits its whole matching set on every write, so most callbacks
    // carry nothing new. Returning early is what keeps a vote on one poll from
    // re-rendering every poll card on screen.
    if (fresh.length === 0 && events.length < RESPONSE_LIMIT) return;

    const bounded = events.length >= RESPONSE_LIMIT;
    const touched = new Set<string>();
    const next = new Map(this.byPoll);
    for (const response of fresh) {
      const current = next.get(response.pollId) ?? NONE;
      next.set(response.pollId, {
        responses: [...current.responses, response],
        bounded,
      });
      touched.add(response.pollId);
    }
    // A newly-bounded query changes what every tracked poll's card must say, even
    // the ones no new response arrived for.
    if (bounded) {
      for (const [pollId, held] of next) {
        if (held.bounded || touched.has(pollId)) continue;
        next.set(pollId, { responses: held.responses, bounded: true });
      }
    }
    this.byPoll = next;
    for (const listener of this.listeners) listener();
  }
}

interface TrackerEntry {
  readonly tracker: PollTracker;
  refs: number;
}

/** Keyed by engine, so an account or relay-set change starts from nothing. */
const registry = new WeakMap<Engine, TrackerEntry>();

function acquireTracker(engine: Engine): PollTracker {
  const existing = registry.get(engine);
  if (existing) {
    existing.refs += 1;
    return existing.tracker;
  }
  const tracker = new PollTracker(engine);
  registry.set(engine, { tracker, refs: 1 });
  return tracker;
}

function releaseTracker(engine: Engine): void {
  const entry = registry.get(engine);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  registry.delete(engine);
  entry.tracker.dispose();
}

/**
 * The responses held for one poll.
 *
 * Every card calling this shares one subscription and one store observer. The value
 * is re-read on every tracker change but only re-renders this card when *its*
 * poll's answer differs.
 */
export function usePollResponses(pollId: string): PollResponses {
  const engine = useEngine();
  const [held, setHeld] = useState<PollResponses>(NONE);

  useEffect(() => {
    if (pollId === "") return;
    const tracker = acquireTracker(engine);
    const read = () => setHeld(tracker.read(pollId));
    tracker.want(pollId);
    read();
    const unsubscribe = tracker.subscribe(read);
    return () => {
      unsubscribe();
      releaseTracker(engine);
    };
  }, [engine, pollId]);

  return held;
}
