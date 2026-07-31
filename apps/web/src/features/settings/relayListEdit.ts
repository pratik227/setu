import type { EventTemplate, NostrEvent } from "@setu/protocol";
import { Kind } from "@setu/protocol";

/**
 * Editing a relay list (kind 10002) without destroying it.
 *
 * The same hazard as the follow list, and for the same reason: kind 10002 is
 * *replaceable*, so publishing one replaces the previous entirely. There is no "add
 * a relay" operation on the network — only "here is my whole list now". Every write
 * is therefore a chance to silently delete the rest of it.
 *
 * The specific way this goes wrong for relay lists is worse than for follows. A
 * relay list tells every other client where to find your notes. Truncate it and
 * your posts stop reaching the people who read you, and nothing anywhere reports an
 * error — you simply become quiet to part of the network, on relays you never chose
 * to leave.
 *
 * So the same three protections as `followList.ts`:
 *
 *  1. **Never invent a list from nothing.** Writing a one-entry list because we have
 *     not finished fetching the real one is the destructive case. `absenceConfirmed`
 *     has to be true before a first list is created.
 *  2. **Preserve tags we do not understand.** A kind 10002 may carry tags beyond
 *     `r`, and a rebuild that emits only `r` deletes them.
 *  3. **Preserve `content`.** It is conventionally empty here, but "conventionally"
 *     is not "always", and dropping it is data loss either way.
 */

/** One relay and what it is used for. NIP-65 markers are read/write/both. */
export interface RelayEntry {
  readonly url: string;
  readonly read: boolean;
  readonly write: boolean;
}

export type RelayEditRefusal =
  /** No list was found and we are not certain none exists. */
  | "unverified-absence"
  /** The edit would leave no relays at all. */
  | "would-empty"
  /** Nothing about the list would change. */
  | "no-change";

export type RelayEditResult =
  | { readonly ok: true; readonly template: EventTemplate }
  | { readonly ok: false; readonly reason: RelayEditRefusal };

/** Entries in a kind-10002, in list order, deduplicated by url. */
export function relayEntries(
  event: NostrEvent | undefined,
): readonly RelayEntry[] {
  if (!event || event.kind !== Kind.RelayList) return [];
  const out: RelayEntry[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1] || seen.has(tag[1])) continue;
    seen.add(tag[1]);
    const marker = tag[2];
    out.push({
      url: tag[1],
      // No marker means both, per NIP-65. Treating an unmarked relay as
      // read-only would quietly stop publishing there.
      read: marker !== "write",
      write: marker !== "read",
    });
  }
  return out;
}

function sameList(a: readonly RelayEntry[], b: readonly RelayEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.url === other.url &&
      entry.read === other.read &&
      entry.write === other.write
    );
  });
}

export interface RelayListEditInput {
  /** The newest kind-10002 we could find, or undefined if none exists. */
  readonly current: NostrEvent | undefined;
  /**
   * True only when every queried relay answered and none held a list.
   *
   * Required to create a first list. "Nobody returned one" and "we did not finish
   * asking" are indistinguishable from a partial result, and treating the second
   * as the first replaces a working relay list with whatever is on screen.
   */
  readonly absenceConfirmed: boolean;
  /** The list the reader wants, in the order they arranged it. */
  readonly next: readonly RelayEntry[];
}

/**
 * Build the kind-10002 for an edited relay list.
 *
 * Refuses to produce an empty list. A published kind-10002 with no relays is not
 * "no preference" — it is an active statement that you can be reached nowhere, and
 * clients that honour it will stop looking for you entirely.
 */
export function editRelayList({
  current,
  absenceConfirmed,
  next,
}: RelayListEditInput): RelayEditResult {
  if (!current && !absenceConfirmed) {
    return { ok: false, reason: "unverified-absence" };
  }
  const cleaned: RelayEntry[] = [];
  const seen = new Set<string>();
  for (const entry of next) {
    const url = entry.url.trim();
    // A relay that is neither read nor write is not a relay you use; dropping it
    // is what the reader meant by unchecking both.
    if (url === "" || seen.has(url) || (!entry.read && !entry.write)) continue;
    seen.add(url);
    cleaned.push({ url, read: entry.read, write: entry.write });
  }

  if (cleaned.length === 0) return { ok: false, reason: "would-empty" };
  if (sameList(cleaned, relayEntries(current))) {
    return { ok: false, reason: "no-change" };
  }

  // Tags we do not understand are carried through. A rebuild that emits only `r`
  // tags deletes whatever else the list held.
  const preserved = (current?.tags ?? []).filter((tag) => tag[0] !== "r");
  const tags: string[][] = [
    ...preserved.map((tag) => [...tag]),
    ...cleaned.map((entry) =>
      entry.read && entry.write
        ? ["r", entry.url]
        : ["r", entry.url, entry.read ? "read" : "write"],
    ),
  ];

  return {
    ok: true,
    template: {
      kind: Kind.RelayList,
      // Conventionally empty, but conventionally is not always, and dropping it
      // is data loss either way.
      content: current?.content ?? "",
      tags,
    },
  };
}

/**
 * Build a kind-10050 (DM relays) for an edited list.
 *
 * Simpler than kind 10002 — there are no read/write markers, a DM relay is one you
 * receive on — but the same absence rule applies, and one extra consequence worth
 * knowing: publishing *no* DM relay list means nobody can send you a private
 * message at all, because senders have nowhere to deliver to and (correctly) will
 * not guess.
 */
export function editDmRelayList({
  current,
  absenceConfirmed,
  next,
}: {
  readonly current: NostrEvent | undefined;
  readonly absenceConfirmed: boolean;
  readonly next: readonly string[];
}): RelayEditResult {
  if (!current && !absenceConfirmed) {
    return { ok: false, reason: "unverified-absence" };
  }
  const cleaned = [
    ...new Set(next.map((url) => url.trim()).filter((url) => url !== "")),
  ];
  if (cleaned.length === 0) return { ok: false, reason: "would-empty" };

  const existing = (current?.tags ?? [])
    .filter((tag) => tag[0] === "relay" && tag[1])
    .map((tag) => tag[1] as string);
  if (
    existing.length === cleaned.length &&
    existing.every((url, index) => url === cleaned[index])
  ) {
    return { ok: false, reason: "no-change" };
  }

  const preserved = (current?.tags ?? []).filter((tag) => tag[0] !== "relay");
  return {
    ok: true,
    template: {
      kind: Kind.DirectMessageRelays,
      content: current?.content ?? "",
      tags: [
        ...preserved.map((tag) => [...tag]),
        ...cleaned.map((url) => ["relay", url]),
      ],
    },
  };
}
