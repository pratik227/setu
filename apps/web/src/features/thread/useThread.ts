/**
 * Thread resolution against the store.
 *
 * Everything a thread needs is fetched by *asking relays to fill the store* and
 * reading the store back — never by keeping the fetched events on the side. That
 * is why the hook holds a map of `NostrEvent` only as a render-cheap projection
 * of what `observe` has already handed it: nothing enters that map except
 * through a store callback, so it cannot disagree with the store.
 *
 * Three subscriptions, no more:
 *  - a one-shot probe for the focused id, whose *completion* is what lets the UI
 *    say "unavailable" instead of spinning forever;
 *  - one live `{ ids: [...] }` subscription covering the focused note and every
 *    ancestor id the tree still misses;
 *  - one live `{ kinds, "#e": [rootId] }` subscription for the whole subtree.
 *
 * Per-note subscriptions are deliberately absent: a thread with forty replies
 * would otherwise open forty REQs and hit the relay's subscription cap.
 */

import type { Engine } from "@setu/core";
import { Kind, type NostrEvent, rootAndReplyIds } from "@setu/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { idLookupLimit } from "../../engine/queryLimits";
import { useSession } from "../identity/SessionProvider";
import { useMuteRules } from "../moderation/useMuteList";
import { NOTE_TARGET_KINDS } from "../notes/noteKinds";
import { buildThread, MAX_MISSING_IDS, type ThreadTree } from "./threadTree";

/** Kinds that can be a reply in a conversation: notes and NIP-22 comments. */
const REPLY_KINDS: readonly number[] = [Kind.ShortTextNote, Kind.Comment];

/** How long to let newly discovered missing ids accumulate before re-asking. */
const SETTLE_MS = 300;

/** Cap on the live reply query, so a brigaded thread cannot exhaust the tab. */
const REPLY_LIMIT = 300;

export type ThreadStatus =
  /** The focused note is not held yet and the probe has not finished. */
  | "loading"
  /** Every relay answered and none of them had it. */
  | "unavailable"
  | "ready";

export interface ThreadState {
  readonly tree: ThreadTree;
  readonly status: ThreadStatus;
}

const EMPTY_HELD: ReadonlyMap<string, NostrEvent> = new Map();

interface Scope {
  readonly engine: Engine;
  readonly noteId: string;
}

/**
 * Resolve the conversation around `noteId`.
 *
 * The tree is built here rather than in the view because the build's output is
 * also its own input: `tree.missingIds` is what drives the next fetch. Building
 * it twice — once to render, once to decide what to ask for — would be two
 * chances to disagree.
 */
export function useThread(noteId: string): ThreadState {
  const engine = useEngine();
  // Mutes are applied to the *tree*, not to the rows, because a muted reply has to
  // keep its place in the structure or its children orphan. See `ThreadReply`.
  const { rules: muteRules, rulesKey } = useMuteRules();
  const { session } = useSession();
  const viewerPubkey = session?.pubkey;

  const [held, setHeld] = useState<ReadonlyMap<string, NostrEvent>>(EMPTY_HELD);
  const [probeDone, setProbeDone] = useState(false);
  const [wantedIds, setWantedIds] = useState<readonly string[]>([noteId]);

  // Reset during render when the focus moves: a different thread shares nothing
  // with the previous one, and letting the old events survive one paint would
  // render the wrong conversation under the new header.
  const [scope, setScope] = useState<Scope>({ engine, noteId });
  if (scope.engine !== engine || scope.noteId !== noteId) {
    setScope({ engine, noteId });
    setHeld(EMPTY_HELD);
    setProbeDone(false);
    setWantedIds([noteId]);
  }

  const merge = useCallback(
    (incoming: readonly { readonly event: NostrEvent }[]) => {
      setHeld((prev) => {
        let next: Map<string, NostrEvent> | undefined;
        for (const { event } of incoming) {
          if (prev.has(event.id)) continue;
          next ??= new Map(prev);
          next.set(event.id, event);
        }
        return next ?? prev;
      });
    },
    [],
  );

  // --- the focused note: one-shot, so "not found" is a reachable state --------
  useEffect(() => {
    let cancelled = false;
    // Ids are unique, so one id can match at most one event: `limit: 1` is exact,
    // and naming the kinds keeps this off a relay's any-kind path.
    const filter = {
      kinds: [...NOTE_TARGET_KINDS],
      ids: [noteId],
      limit: idLookupLimit(1),
    };
    const done = () => {
      if (!cancelled) setProbeDone(true);
    };
    void engine.subscriptions
      .fetch({ filters: engine.relays.map((relay) => ({ relay, filter })) })
      .then(done, done);
    return () => {
      cancelled = true;
    };
  }, [engine, noteId]);

  // --- the focused note and every missing ancestor: live ---------------------
  const wantedKey = useMemo(() => [...wantedIds].sort().join(","), [wantedIds]);

  useEffect(() => {
    const ids = wantedKey.split(",").filter((id) => id.length > 0);
    if (ids.length === 0) return;
    const filter = {
      kinds: [...NOTE_TARGET_KINDS],
      ids,
      limit: idLookupLimit(ids.length),
    };

    const subscription = engine.subscriptions.subscribe({
      filters: engine.relays.map((relay) => ({ relay, filter })),
    });
    const unobserve = engine.store.observe(filter, merge);

    return () => {
      unobserve();
      subscription.close();
    };
  }, [engine, wantedKey, merge]);

  // --- the subtree: one subscription for the whole thread --------------------
  const focused = held.get(noteId);
  // NIP-10 names the root, and replies tag it, so one `#e` filter on the root
  // reaches every descendant regardless of how deep it sits.
  const rootId = focused
    ? (rootAndReplyIds(focused).root ?? noteId)
    : undefined;

  useEffect(() => {
    if (rootId === undefined) return;
    const filter = {
      kinds: [...REPLY_KINDS],
      "#e": [rootId],
      limit: REPLY_LIMIT,
    };

    const subscription = engine.subscriptions.subscribe({
      filters: engine.relays.map((relay) => ({ relay, filter })),
    });
    const unobserve = engine.store.observe(filter, merge);

    return () => {
      unobserve();
      subscription.close();
    };
  }, [engine, rootId, merge]);

  // --- the projection -------------------------------------------------------
  const events = useMemo(() => [...held.values()], [held]);
  const tree = useMemo(
    () =>
      buildThread({
        events,
        focusedId: noteId,
        muteRules,
        ...(viewerPubkey ? { viewerPubkey } : {}),
      }),
    // `rulesKey` is the value identity of `muteRules`; depending on it means editing
    // the list rebuilds the tree, and a store tick that re-emits an equal list does
    // not. Rebuilding on every tick would defeat the row memoisation the thread
    // shares with the feed.
    [events, noteId, muteRules, rulesKey, viewerPubkey],
  );

  // --- grow the id interest set from what the tree says it lacks -------------
  const latestMissing = useRef<readonly string[]>(tree.missingIds);
  latestMissing.current = tree.missingIds;
  const growTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (wantedIds.length >= MAX_MISSING_IDS + 1) return;
    const extra = tree.missingIds.filter((id) => !wantedIds.includes(id));
    if (extra.length === 0) return;

    // Leading schedule, not a reset-on-every-change debounce. Walking up a chain
    // discovers one new id per round trip, so re-arming the timer on each
    // discovery would push the re-subscribe back for as long as the chain keeps
    // growing and no REQ would ever go out. One timer runs, publishes whatever
    // is missing when it fires, and only then may another be scheduled.
    if (growTimer.current !== null) return;
    growTimer.current = setTimeout(() => {
      growTimer.current = null;
      setWantedIds((prev) => {
        const next = new Set(prev);
        for (const id of latestMissing.current) {
          if (next.size > MAX_MISSING_IDS) break;
          next.add(id);
        }
        return next.size === prev.length ? prev : [...next];
      });
    }, SETTLE_MS);
  }, [tree.missingIds, wantedIds]);

  useEffect(
    () => () => {
      if (growTimer.current) clearTimeout(growTimer.current);
      growTimer.current = null;
    },
    [],
  );

  const status: ThreadStatus = tree.focused
    ? "ready"
    : probeDone
      ? "unavailable"
      : "loading";

  return useMemo(() => ({ tree, status }), [tree, status]);
}
