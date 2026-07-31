/**
 * The persisted row shape for {@link ../store/dexieStore.DexieEventStore}.
 *
 * Kept flat and index-friendly: IndexedDB can only index own properties, so the
 * derived index keys (`tagKeys`, `addressKey`) are denormalised onto the row at
 * write time rather than computed per query.
 */

import type { Hex32, NostrEvent, Timestamp } from "@setu/protocol";
import type { StoredEvent } from "../contracts";
import { expirationOf } from "./expiration";
import { addressOf } from "./kinds";
import { isProtected } from "./protection";
import { tagIndexKeysOf } from "./queryPlan";

/** A stored event, flattened for IndexedDB. */
export interface EventRow {
  id: Hex32;
  pubkey: Hex32;
  created_at: Timestamp;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
  /** Multi-entry index of `letter:value` tag buckets. */
  tagKeys: string[];
  /**
   * `kind:pubkey:dTag` for replaceable/addressable kinds, omitted otherwise.
   * Omitted rather than null because IndexedDB cannot index null.
   */
  addressKey?: string;
  /**
   * NIP-40 deadline in unix seconds, omitted when the event carries none.
   *
   * Denormalised purely so the expiry sweep is an index range scan rather than a
   * full-table walk. It is never what *decides* whether an event is expired —
   * that is always `expiration.isExpiredAt` reading the tags — so this column
   * cannot drift into being the wrong answer.
   */
  expiresAt?: Timestamp;
  /** Provenance: every relay observed serving this event. */
  relays: string[];
  /** Provenance: when we first saw it, unix seconds. */
  firstSeen: Timestamp;
}

/** Builds a row from a verified event plus its provenance. */
export function toRow(
  event: NostrEvent,
  relays: readonly string[],
  firstSeen: Timestamp,
): EventRow {
  const address = addressOf(event);
  const row: EventRow = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
    tagKeys: [...tagIndexKeysOf(event.tags)],
    relays: [...relays],
    firstSeen,
  };
  if (address !== undefined) row.addressKey = address;
  const expiresAt = expirationOf(event);
  if (expiresAt !== undefined) row.expiresAt = expiresAt;
  return row;
}

/** Reconstructs the wire event from a row. */
export function rowToEvent(row: EventRow): NostrEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: row.tags,
    content: row.content,
    sig: row.sig,
  };
}

/**
 * Reconstructs the public {@link StoredEvent} from a row.
 *
 * The NIP-70 flag is recomputed from the tags rather than persisted: it is a pure
 * function of data the row already carries, and a stored copy could only ever
 * disagree with it.
 */
export function rowToStored(row: EventRow): StoredEvent {
  const event = rowToEvent(row);
  return {
    event,
    provenance: { relays: row.relays, firstSeen: row.firstSeen },
    ...(isProtected(event) ? { protected: true as const } : {}),
  };
}
