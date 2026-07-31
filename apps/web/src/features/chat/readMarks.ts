/**
 * Read marks for private conversations, stored on this device.
 *
 * Local-only, deliberately. NIP-17 defines no read receipt, and inventing one
 * would publish to a relay exactly when you read each message — metadata the gift
 * wrap went to some trouble to hide. Cross-device read state is worth having, but
 * not at that price.
 *
 * Keyed by account pubkey, because read state is personal: two accounts on one
 * device must not inherit each other's, and switching accounts must never mark a
 * stranger's conversations read.
 */

export function readMarksKey(pubkey: string): string {
  return `setu-dm-read:${pubkey}`;
}

/** Read marks for an account. Never throws; a bad store reads as empty. */
export function loadReadMarks(
  pubkey: string | undefined,
  storage: Storage | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): Map<string, number> {
  if (!pubkey || !storage) return new Map();
  try {
    const raw = storage.getItem(readMarksKey(pubkey));
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return new Map();
    }
    const out = new Map<string, number>();
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      // Anything non-numeric is dropped rather than coerced: `NaN > 0` is false,
      // so a coerced value would silently mark a conversation permanently unread.
      if (typeof at === "number" && Number.isFinite(at)) out.set(id, at);
    }
    return out;
  } catch {
    // Corrupt storage costs a few re-read conversations. Throwing here would take
    // the whole screen down instead.
    return new Map();
  }
}

/** Persist read marks. Failure is silent: it costs a mark, not the app. */
export function saveReadMarks(
  pubkey: string | undefined,
  marks: ReadonlyMap<string, number>,
  storage: Storage | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): void {
  if (!pubkey || !storage) return;
  try {
    storage.setItem(
      readMarksKey(pubkey),
      JSON.stringify(Object.fromEntries(marks)),
    );
  } catch {
    // Quota exceeded or storage disabled. The conversation still reads fine.
  }
}
