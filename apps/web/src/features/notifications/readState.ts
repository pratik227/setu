/**
 * The "last seen" watermark that turns notifications into an unread count.
 *
 * ## Key scheme
 *
 * `setu:notifications:lastSeen:<pubkey-hex>` — one key per account, value is a
 * decimal Unix timestamp in **seconds**, matching `created_at` so the comparison
 * needs no unit conversion.
 *
 * Keyed by pubkey rather than stored as a single field because read state is
 * per-identity: switching accounts must not clear or inherit the other account's
 * badge, and a shared key would do both. The value is not a secret and not a
 * capability — losing it costs a badge, never access.
 *
 * ## First run
 *
 * When no watermark exists we report **zero unread** and immediately write the
 * current time as the watermark. The alternative — treating everything held as
 * unread — greets a returning account with "99+" built from a year of history it
 * has already read elsewhere, and a badge that is wrong on first sight is a badge
 * the user learns to ignore. "We have never recorded what you saw" is not the same
 * claim as "you have seen none of this", and only the first is true, so the rule
 * is: history before the first run is history.
 *
 * ## Monotonicity
 *
 * The watermark only ever moves forward, and the comparison is strictly greater
 * (`createdAt > lastSeen`). Both matter: a relay handing back an event with a
 * future `created_at` would otherwise stick permanently unread, and a
 * mark-read at exactly T must not leave the item that happened at T unread.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useSession } from "../identity/SessionProvider";
import type { NotificationItem } from "./groupNotifications";
import { useNotifications } from "./useNotifications";

const KEY_PREFIX = "setu:notifications:lastSeen:";

/** The `localStorage` key holding one account's watermark. */
export function lastSeenKey(pubkey: string): string {
  return `${KEY_PREFIX}${pubkey}`;
}

/**
 * How many grouped rows are newer than the watermark.
 *
 * Pure, and the whole of the unread rule: `undefined` — no watermark recorded —
 * is zero unread, never "all of them". See the first-run note above.
 */
export function countUnread(
  items: readonly NotificationItem[],
  lastSeen: number | undefined,
): number {
  if (lastSeen === undefined) return 0;
  let count = 0;
  for (const item of items) {
    if (item.createdAt > lastSeen) count += 1;
  }
  return count;
}

/**
 * The watermark to persist, given what is already stored.
 *
 * Pure so the monotonic rule is asserted rather than assumed: a mark-read can
 * never move the watermark backwards, which is what keeps a stale component (or a
 * second tab that loaded earlier) from resurrecting rows the user already
 * dismissed.
 */
export function nextWatermark(
  stored: number | undefined,
  through: number,
): number {
  return stored === undefined ? through : Math.max(stored, through);
}

// --- storage -----------------------------------------------------------------

function readRaw(pubkey: string): number | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(lastSeenKey(pubkey));
    if (raw === null) return undefined;
    const parsed = Number(raw);
    // A corrupt or non-finite value is treated as absent rather than as zero:
    // zero would mark every notification unread, which is the outcome the
    // first-run rule exists to avoid.
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

function writeRaw(pubkey: string, at: number): void {
  try {
    localStorage.setItem(lastSeenKey(pubkey), String(Math.floor(at)));
  } catch {
    // Storage may be unavailable (private mode, quota). The count still works
    // for this tab from the in-memory cache below; it just is not remembered.
  }
}

/**
 * In-memory mirror plus a listener set.
 *
 * `localStorage` writes do not notify the tab that made them, and the badge lives
 * in a different React tree from the screen that marks notifications read. Without
 * an explicit subscription the badge would keep its count until something
 * unrelated re-rendered it — which reads as "the app ignored my click".
 */
const cache = new Map<string, number | undefined>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to watermark changes in this tab or another one. */
export function subscribeReadState(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorageEvent);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorageEvent);
    }
  };
}

function onStorageEvent(event: StorageEvent): void {
  if (event.key !== null && !event.key.startsWith(KEY_PREFIX)) return;
  // Another tab moved a watermark. Drop the mirror so the next read re-reads
  // storage; keeping a stale copy would show two tabs different badges.
  cache.clear();
  emit();
}

/** The stored watermark for an account, or `undefined` on first run. */
export function readLastSeen(pubkey: string): number | undefined {
  if (cache.has(pubkey)) return cache.get(pubkey);
  const value = readRaw(pubkey);
  cache.set(pubkey, value);
  return value;
}

/**
 * Move an account's watermark forward to `through` (seconds) and notify readers.
 * Never moves it back — see `nextWatermark`.
 */
export function markNotificationsRead(pubkey: string, through: number): void {
  const next = nextWatermark(readLastSeen(pubkey), through);
  if (next === readLastSeen(pubkey)) return;
  cache.set(pubkey, next);
  writeRaw(pubkey, next);
  emit();
}

/**
 * Record the first-run watermark if there is none, and return it.
 *
 * Called from a read path on purpose: the seed has to happen the first time the
 * app looks at an account's notifications, whether or not the user ever opens the
 * screen, or a badge built later would count that whole session as unread.
 */
export function seedLastSeen(pubkey: string, now: number): number {
  const existing = readLastSeen(pubkey);
  if (existing !== undefined) return existing;
  cache.set(pubkey, now);
  writeRaw(pubkey, now);
  emit();
  return now;
}

/**
 * Forget an account's watermark, on sign-out.
 *
 * This key used to survive sign-out, and the result was the previous account's read
 * position sitting on the device after everything else about them had been deleted.
 * Two ways that goes wrong, and the second is the one that matters: the same account
 * signing back in inherits a watermark from a session whose events are gone, so a
 * timestamp says "seen" about notifications the store can no longer show — and on a
 * shared computer the value itself is a residue, a decimal timestamp keyed by a
 * stranger's pubkey saying when they last looked at their notifications.
 *
 * Removed rather than zeroed: zero is a *valid* watermark meaning "seen nothing", and
 * writing it would mark a year of history unread. Absent is the state the first-run
 * rule above is written for.
 */
export function clearNotificationsRead(pubkey: string | undefined): void {
  if (!pubkey) return;
  cache.delete(pubkey);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(lastSeenKey(pubkey));
    }
  } catch {
    // Storage disabled or blocked by policy. Reported by the caller as data left
    // behind; there is nothing further this function can do about it.
  }
  emit();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// --- hooks -------------------------------------------------------------------

/** The live watermark for an account. `undefined` when nobody is signed in. */
export function useLastSeen(pubkey: string | undefined): number | undefined {
  const getSnapshot = useCallback(
    () => (pubkey ? readLastSeen(pubkey) : undefined),
    [pubkey],
  );
  return useSyncExternalStore(subscribeReadState, getSnapshot, getSnapshot);
}

/**
 * How many grouped notifications are newer than the viewer's watermark.
 *
 * Drives the sidebar badge, so it holds the notification subscription for the
 * whole session — shared by ref-count with the screens, which ask for the same
 * filter.
 */
export function useUnreadCount(): number {
  const { items, viewerPubkey } = useNotifications();
  const lastSeen = useLastSeen(viewerPubkey);

  // First run for this account: record "now" in an effect, not during render —
  // seeding notifies subscribers, and notifying mid-render would update another
  // component while this one renders. No count flashes in the meantime, because
  // an absent watermark already reports zero.
  useEffect(() => {
    if (!viewerPubkey) return;
    if (lastSeen !== undefined) return;
    seedLastSeen(viewerPubkey, nowSeconds());
  }, [viewerPubkey, lastSeen]);

  return countUnread(items, lastSeen);
}

/**
 * The mark-read call, bound to the signed-in account.
 *
 * Exposed as its own hook so the sidebar badge and the screen agree without the
 * screen having to know a badge exists.
 *
 * Pass the newest *rendered* row's timestamp rather than letting it default to
 * now: the default is right for an empty list, but on a full one it would also
 * mark read everything a relay is still about to deliver with an older
 * `created_at`, which is a notification the user never saw.
 */
export function useMarkNotificationsRead(): (through?: number) => void {
  const { session } = useSession();
  const pubkey = session?.pubkey;
  return useCallback(
    (through?: number) => {
      if (!pubkey) return;
      markNotificationsRead(pubkey, through ?? nowSeconds());
    },
    [pubkey],
  );
}

/** Test seam: drops the in-memory mirror so a fresh read hits storage. */
export function resetReadStateCache(): void {
  cache.clear();
}
