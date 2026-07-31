import { type Conversation, groupConversations } from "@setu/core";
import {
  type ChatMessage,
  type Filter,
  Kind,
  type NostrEvent,
  toChatMessage,
  unwrap,
} from "@setu/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { filterContentKey } from "../../engine/sharedSubscription";
import { useStoreEvents } from "../discover/useStoreEvents";
import { useSession } from "../identity/SessionProvider";
import { loadReadMarks, saveReadMarks } from "./readMarks";
import { useInboxRelays } from "./useInboxRelays";

/**
 * The private-message inbox: gift wraps in, conversations out.
 *
 * ## Where the wraps are read from
 *
 * From the account's own kind-10050 relays as well as the configured set — the union
 * `useInboxRelays` computes. This used to be the configured set alone, via
 * `useSharedSubscription`, and that was a hole rather than a gap: NIP-17 senders
 * deliver to the *recipient's* inbox list, so an account whose list named a relay
 * Setu did not read was reachable by private message and could not see one. Both
 * sides looked healthy — the sender's publish was accepted, the recipient's inbox was
 * simply empty.
 *
 * ## Why decryption is cached rather than recomputed
 *
 * Every gift wrap costs two NIP-44 decryptions and one signature verification, and
 * the store re-emits the whole matching set on each change. Decrypting on every
 * tick would redo hundreds of ECDH operations per second on a busy inbox and lock
 * the main thread. So each wrap is decrypted once, keyed by its id, and the result
 * is kept for the life of the session.
 *
 * The cache is scoped to `(engine, viewer)`: a different account cannot read the
 * previous account's plaintext, and switching accounts must not leak one
 * conversation into the other.
 *
 * ## Why failures are cached too
 *
 * An inbox contains wraps we cannot open — spam addressed to us with a payload we
 * are not the recipient of, malformed events, wraps whose seal fails verification.
 * Retrying those on every tick is the same cost as decrypting them, forever.
 * A failure is remembered so it is attempted exactly once.
 *
 * ## What is *not* stored
 *
 * Decrypted messages never go into the event store. The store holds signed,
 * verified events and is the app's source of truth for public data; a rumor has no
 * signature, and putting one there would both break that invariant and risk a
 * decrypted private message being served to any surface that queries by kind.
 */

/** Gift wraps to hold. Bounded like every other filter — see `queryLimits`. */
const INBOX_LIMIT = 500;

export interface DirectMessagesApi {
  readonly conversations: readonly Conversation[];
  /** Every decrypted message, for callers that group differently. */
  readonly messages: readonly ChatMessage[];
  /** True until the first wrap has been processed. */
  readonly loading: boolean;
  /** Wraps addressed to us that could not be opened. Shown, never hidden. */
  readonly undecryptable: number;
  /** False when this session cannot decrypt at all (read-only, or no NIP-44). */
  readonly canRead: boolean;
}

const NO_MESSAGES: readonly ChatMessage[] = [];

export function useDirectMessages(): DirectMessagesApi {
  const engine = useEngine();
  const { session } = useSession();
  const viewer = session?.pubkey;
  const canRead = Boolean(session?.signer.nip44Decrypt);

  const filter = useMemo(
    () =>
      viewer && canRead
        ? { kinds: [Kind.GiftWrap], "#p": [viewer], limit: INBOX_LIMIT }
        : undefined,
    [viewer, canRead],
  );

  const inboxRelays = useInboxRelays();
  useInboxSubscription(filter, inboxRelays);
  const wraps = useStoreEvents(filter ?? MATCHES_NOTHING);

  // Keyed on the engine *and* the viewer: one account must never see plaintext
  // decrypted under another.
  const caches = useMemo(
    () => ({
      opened: new Map<string, ChatMessage>(),
      failed: new Set<string>(),
    }),
    // `engine` and `viewer` scope the cache rather than feed it: a new engine or
    // a different account must start from empty plaintext, never inherit it.
    [engine, viewer],
  );

  const [messages, setMessages] = useState<readonly ChatMessage[]>(NO_MESSAGES);
  const [undecryptable, setUndecryptable] = useState(0);
  const [loading, setLoading] = useState(true);
  // Guards against two decryption passes overlapping on a fast-arriving inbox.
  const running = useRef(false);

  const signer = session?.signer;

  useEffect(() => {
    if (!signer || !canRead) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    const run = async () => {
      if (running.current) return;
      running.current = true;
      try {
        let added = false;
        for (const { event } of wraps) {
          if (cancelled) return;
          if (caches.opened.has(event.id) || caches.failed.has(event.id)) {
            continue;
          }
          try {
            const result = await unwrap(
              event as NostrEvent,
              signer,
              (candidate) => engine.verifier.verify(candidate),
            );
            const message = toChatMessage(result.rumor);
            if (message) {
              caches.opened.set(event.id, message);
              added = true;
            } else {
              // A wrap that opened but held something other than a chat message.
              // Not an error and not a message — a gift wrap can carry any kind.
              caches.failed.add(event.id);
            }
          } catch {
            // Remembered so it is never retried: an inbox accumulates wraps we
            // cannot open, and retrying each on every tick is unbounded work.
            caches.failed.add(event.id);
          }
        }
        if (cancelled) return;
        if (added) setMessages([...caches.opened.values()]);
        setUndecryptable(caches.failed.size);
        setLoading(false);
      } finally {
        running.current = false;
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [wraps, signer, canRead, caches, engine]);

  const conversations = useMemo(
    () => groupConversations(messages, viewer),
    [messages, viewer],
  );

  return {
    conversations,
    messages,
    loading: loading && canRead,
    undecryptable,
    canRead,
  };
}

/**
 * Hold one gift-wrap REQ, named relay by relay, for as long as the inbox is open.
 *
 * Not `useSharedSubscription`: that fans a filter out over `engine.relays` and
 * nothing else, which is exactly what left wraps on the account's own inbox relays
 * unread. `subscriptions.subscribe` takes per-relay filters, so the inbox names its
 * relays itself and the engine keeps its identity — rebuilding it to widen the read
 * set would tear down every other live subscription and close and reopen the
 * IndexedDB store built in the same memo (see `EngineProvider`).
 *
 * The effect is keyed on the *content* of the filter and the relay list, not their
 * identities: both are recomputed as the store ticks, and re-running on identity
 * would cancel the REQ before any relay answered — which looks like an inbox that
 * never loads. Widening the relay list does reopen it, once, which is the point: the
 * account's inbox list arrives after the first render.
 */
function useInboxSubscription(
  filter: Filter | undefined,
  relays: readonly string[],
): void {
  const engine = useEngine();
  const key = useMemo(
    () =>
      filter && relays.length > 0
        ? JSON.stringify([relays, filterContentKey(filter)])
        : "",
    [filter, relays],
  );

  useEffect(() => {
    if (key === "") return;
    const [urls, filterKey] = JSON.parse(key) as [string[], string];
    const parsed = Object.fromEntries(
      JSON.parse(filterKey) as readonly [string, unknown][],
    ) as Filter;
    const subscription = engine.subscriptions.subscribe({
      filters: urls.map((relay) => ({ relay, filter: parsed })),
    });
    return () => subscription.close();
  }, [engine, key]);
}

/** One conversation by id, or undefined. */
export function useConversation(
  conversations: readonly Conversation[],
  id: string | undefined,
): Conversation | undefined {
  return useMemo(
    () => (id ? conversations.find((c) => c.id === id) : undefined),
    [conversations, id],
  );
}

/**
 * Read marks, per conversation, persisted on this device.
 *
 * They have to be persisted, and this is why: without it every conversation
 * reappeared unread on every visit. Not only after a reload — the state lived in a
 * hook owned by the chat screen, so navigating to Home and back re-created it
 * empty. A read mark that does not survive the trip is not a read mark.
 *
 * Local-only and deliberately so. NIP-17 has no read-receipt event, and inventing
 * one would publish, to a relay, exactly when you read each message — metadata the
 * gift wrap went to some trouble to hide. Read state syncing across devices is
 * worth having, but not at that price.
 */
export function useReadMarks(): {
  readonly lastReadAt: ReadonlyMap<string, number>;
  markRead(conversationId: string, at: number): void;
} {
  const { session } = useSession();
  const pubkey = session?.pubkey;

  // Seeded from storage on first render rather than in an effect: an effect runs
  // after the first paint, so every conversation would flash unread before the
  // marks landed.
  const [lastReadAt, setLastReadAt] = useState<ReadonlyMap<string, number>>(
    () => loadReadMarks(pubkey),
  );

  // Reload when the account changes, during render, so no frame shows the
  // previous account's read state against this account's conversations.
  const [loadedFor, setLoadedFor] = useState(pubkey);
  if (loadedFor !== pubkey) {
    setLoadedFor(pubkey);
    setLastReadAt(loadReadMarks(pubkey));
  }

  const markRead = useCallback(
    (conversationId: string, at: number) => {
      setLastReadAt((previous) => {
        // Monotonic: a mark never moves backwards, so re-opening an old
        // conversation cannot un-read newer messages in it.
        if ((previous.get(conversationId) ?? 0) >= at) return previous;
        const next = new Map(previous);
        next.set(conversationId, at);
        saveReadMarks(pubkey, next);
        return next;
      });
    },
    [pubkey],
  );

  return { lastReadAt, markRead };
}

/** A filter that matches nothing, for the signed-out case. */
const MATCHES_NOTHING = { ids: [], kinds: [], limit: 1 };
