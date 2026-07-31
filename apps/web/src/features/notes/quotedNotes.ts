/**
 * The events a screenful of notes quotes — one subscription for the whole app.
 *
 * A quote card has to fetch the event it points at, and the obvious shape of that
 * is the worst subscription a client can make: a feed of eighty notes with a
 * dozen quotes in it opens a dozen REQs, and relays cap concurrent subscriptions
 * in the low tens. The other obvious shape is worse — one REQ per surface, keyed
 * on the id set — because a live feed's id set changes several times a second, so
 * the REQ is cancelled and reopened before any relay answers and the quoted events
 * never arrive at all. `useInterestIds` exists because of that exact failure.
 *
 * So there is one tracker per engine. Every mounted quote card registers the id it
 * needs; the tracker keeps a grow-only union and republishes on the policy in
 * `InterestSet`. Ids are unique, so the filter's bound is exact
 * (`idLookupLimit`) — *n* ids can match at most *n* events.
 *
 * Authors go through `engine.profiles.request`, which is already the app-wide
 * batched, chunked, deduplicated profile loader; this module only observes the
 * store for the kind-0s it brings back. It deliberately does not run NIP-05
 * verification: a quote card shows no badge, so there is nothing to verify.
 */

import type { Engine } from "@setu/core";
import { type Filter, Kind, type NostrEvent } from "@setu/protocol";
import { useEffect, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { InterestSet } from "../../engine/interestSet";
import { idLookupLimit } from "../../engine/queryLimits";
import {
  acquireSharedSubscription,
  filtersContentKey,
} from "../../engine/sharedSubscription";
import { nip05DisplayName } from "../profiles/nip05";
import { parseProfileContent, preferredName } from "../profiles/profileContent";
import { fallbackAuthor } from "../profiles/useAuthors";
import type { AuthorView } from "./types";

/**
 * Quoted events tracked at once.
 *
 * Smaller than the interaction tracker's union because a quote is a minority of
 * rows and each id is only ever wanted by the one card rendering it. Several
 * screens' worth of quotes fits; the least recently wanted ids are evicted first.
 */
const MAX_TRACKED_QUOTES = 96;

/**
 * Republish policy. See `InterestSet` for why each number exists.
 *
 * `threshold` is deliberately low — a handful of quote cards is a whole screen's
 * worth of them, and waiting for eight would leave the first four unresolved.
 * `maxStaleMs` is the backstop that covers a screen with one quote on it.
 */
const POLICY = {
  max: MAX_TRACKED_QUOTES,
  threshold: 4,
  cooldownMs: 8_000,
  maxStaleMs: 4_000,
} as const;

/** How long a burst of new ids may accumulate before it is published. */
const SETTLE_MS = 400;

/**
 * How long an id stays "loading" after it has actually been asked for.
 *
 * A quoted event that no relay holds is the normal case, not an error — the author
 * may have quoted a note from a relay we do not read. Without a deadline the card
 * would show a spinner forever, which claims something is still happening when
 * nothing is. After this long the card says so instead.
 */
const GRACE_MS = 8_000;

/** What a card knows about the event it points at. */
export interface QuotedNote {
  /**
   * `loading` only while the id is genuinely in flight. `missing` is a settled
   * answer — no relay we asked returned it — and the card renders the reference
   * rather than an empty box.
   */
  readonly status: "loading" | "found" | "missing";
  readonly event?: NostrEvent;
  /** Placeholder until the kind-0 lands, exactly as a feed row's author is. */
  readonly author?: AuthorView;
}

const LOADING: QuotedNote = { status: "loading" };
const MISSING: QuotedNote = { status: "missing" };

function toAuthorView(pubkey: string, content: string): AuthorView {
  const details = parseProfileContent(content);
  const fallback = fallbackAuthor(pubkey);
  return {
    pubkey,
    resolved: true,
    displayName: preferredName(details) ?? fallback.displayName,
    handle: details.nip05 ? nip05DisplayName(details.nip05) : fallback.handle,
    ...(details.picture ? { avatarUrl: details.picture } : {}),
    ...(details.nip05 ? { nip05: details.nip05 } : {}),
    // Never set here. A quote card shows no verification badge, and a `verified`
    // flag taken from the profile's own claim would mean "this author typed a
    // domain name".
    verified: false,
  };
}

/** The app-wide tracker for one engine. */
class QuoteTracker {
  private readonly interest = new InterestSet(POLICY);
  private readonly listeners = new Set<() => void>();
  private readonly events = new Map<string, NostrEvent>();
  private readonly authors = new Map<string, AuthorView>();
  private readonly placeholders = new Map<string, AuthorView>();
  /** Ids whose fetch window has closed, so absence is now an answer. */
  private readonly settled = new Set<string>();
  private readonly wantedAuthors = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private graceTimers = new Set<ReturnType<typeof setTimeout>>();
  private releaseSubscription: (() => void) | null = null;
  private unobserveEvents: (() => void) | null = null;
  private unobserveAuthors: (() => void) | null = null;
  private authorTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly engine: Engine) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Register interest in one quoted event. Cheap enough to call per render. */
  want(id: string): void {
    if (this.disposed || id === "") return;
    this.interest.want([id]);
    this.schedule();
  }

  read(id: string): QuotedNote {
    const event = this.events.get(id);
    if (event === undefined) {
      return this.settled.has(id) ? MISSING : LOADING;
    }
    return { status: "found", event, author: this.authorFor(event.pubkey) };
  }

  /**
   * Resolved author, or a placeholder held at a stable identity.
   *
   * `fallbackAuthor` builds a new object per call, so returning one directly would
   * make every read of an unresolved author a different value — and the hook
   * compares identities to decide whether the card needs to re-render.
   */
  private authorFor(pubkey: string): AuthorView {
    const resolved = this.authors.get(pubkey);
    if (resolved !== undefined) return resolved;
    let placeholder = this.placeholders.get(pubkey);
    if (placeholder === undefined) {
      placeholder = fallbackAuthor(pubkey);
      this.placeholders.set(pubkey, placeholder);
    }
    return placeholder;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.authorTimer !== null) clearTimeout(this.authorTimer);
    this.authorTimer = null;
    for (const timer of this.graceTimers) clearTimeout(timer);
    this.graceTimers.clear();
    this.unobserveEvents?.();
    this.unobserveEvents = null;
    this.unobserveAuthors?.();
    this.unobserveAuthors = null;
    this.releaseSubscription?.();
    this.releaseSubscription = null;
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Arm the republish timer.
   *
   * A leading schedule, not a debounce that re-arms: a pending timer is left
   * alone, because on a live feed ids arrive faster than any sensible delay and
   * pushing the timer back on every one means no REQ is ever sent.
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

    const filter: Filter = { ids: [...ids], limit: idLookupLimit(ids.length) };

    const previousRelease = this.releaseSubscription;
    const previousUnobserve = this.unobserveEvents;
    // Released before the new lease is taken, so a content-keyed share cannot
    // resolve to the subscription that is on its way out.
    previousUnobserve?.();
    previousRelease?.();

    this.releaseSubscription = acquireSharedSubscription(
      this.engine,
      `quotes:${filtersContentKey([filter])}`,
      [filter],
    );
    this.unobserveEvents = this.engine.store.observe(filter, (rows) => {
      this.absorb(rows.map((row) => row.event));
    });

    // Absence only becomes an answer once the ids have actually been asked for.
    const asked = [...ids];
    const grace = setTimeout(() => {
      this.graceTimers.delete(grace);
      if (this.disposed) return;
      let changed = false;
      for (const id of asked) {
        if (this.events.has(id) || this.settled.has(id)) continue;
        this.settled.add(id);
        changed = true;
      }
      if (changed) this.notify();
    }, GRACE_MS);
    this.graceTimers.add(grace);
  }

  private absorb(events: readonly NostrEvent[]): void {
    let changed = false;
    for (const event of events) {
      if (this.events.has(event.id)) continue;
      this.events.set(event.id, event);
      // A quoted event that arrived is no longer waiting on anything, so a grace
      // deadline that fires later must not mark it missing.
      this.settled.delete(event.id);
      changed = true;
      if (!this.wantedAuthors.has(event.pubkey)) {
        this.wantedAuthors.add(event.pubkey);
        this.engine.profiles.request([event.pubkey]);
        this.scheduleAuthors();
      }
    }
    if (changed) this.notify();
  }

  /**
   * Re-install the kind-0 observer for the authors we now need.
   *
   * Debounced for the same reason `useAuthors` debounces: a feed page's worth of
   * quotes resolves in a burst, and reinstalling the observer per author is a
   * store fan-out target per author.
   */
  private scheduleAuthors(): void {
    if (this.disposed || this.authorTimer !== null) return;
    this.authorTimer = setTimeout(() => {
      this.authorTimer = null;
      if (this.disposed || this.wantedAuthors.size === 0) return;
      this.unobserveAuthors?.();
      this.unobserveAuthors = this.engine.store.observe(
        { kinds: [Kind.Metadata], authors: [...this.wantedAuthors] },
        (rows) => {
          let changed = false;
          for (const { event } of rows) {
            // The store enforces replaceable last-write-wins, so the first row per
            // author is already the newest one.
            if (this.authors.has(event.pubkey)) continue;
            this.authors.set(
              event.pubkey,
              toAuthorView(event.pubkey, event.content),
            );
            changed = true;
          }
          if (changed) this.notify();
        },
      );
    }, SETTLE_MS);
  }
}

interface TrackerEntry {
  readonly tracker: QuoteTracker;
  refs: number;
}

/** Keyed by engine, so an account or relay-set change starts from nothing. */
const registry = new WeakMap<Engine, TrackerEntry>();

function acquireTracker(engine: Engine): QuoteTracker {
  const existing = registry.get(engine);
  if (existing) {
    existing.refs += 1;
    return existing.tracker;
  }
  const tracker = new QuoteTracker(engine);
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
 * The event behind one quote reference.
 *
 * Every card calling this shares one subscription and one store observer. The
 * returned value is re-read on every tracker change but only re-renders this card
 * when *its* id's answer differs, so a feed of quotes resolving one at a time does
 * not re-render the ones already resolved.
 */
export function useQuotedNote(id: string): QuotedNote {
  const engine = useEngine();
  const [quoted, setQuoted] = useState<QuotedNote>(LOADING);

  useEffect(() => {
    if (id === "") return;
    const tracker = acquireTracker(engine);
    const read = () => {
      const next = tracker.read(id);
      setQuoted((current) =>
        current.status === next.status &&
        current.event === next.event &&
        current.author === next.author
          ? current
          : next,
      );
    };
    tracker.want(id);
    read();
    const unsubscribe = tracker.subscribe(read);
    return () => {
      unsubscribe();
      releaseTracker(engine);
    };
  }, [engine, id]);

  return quoted;
}
