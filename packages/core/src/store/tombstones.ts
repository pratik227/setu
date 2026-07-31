/**
 * NIP-09 deletion bookkeeping, shared by every {@link ../contracts.EventStore}
 * implementation.
 *
 * Two rules make this non-trivial, and both are enforced here in storage rather
 * than in UI code, so no view can forget them:
 *
 *  1. **Tombstones outlive their targets.** A kind-5 can arrive before the event
 *     it deletes, or after that event has been evicted. So tombstones are
 *     persisted as their own records, keyed independently of the event table. A
 *     relay handing the event back later must not resurrect it.
 *  2. **Only the author may delete.** A kind-5 from Alice tombstones only
 *     Alice's events. Tombstones are therefore keyed by *(deleter, target)* for
 *     id deletions, and address deletions are ignored outright unless the
 *     address's pubkey component is the deleter.
 */

import type { Hex32, NostrEvent, Timestamp } from "@setu/protocol";
import { addressAuthor, addressOf, KIND_DELETION } from "./kinds";

/** A persisted tombstone row. `key` is unique and stable across restarts. */
export interface TombstoneRecord {
  /** `i:<deleterPubkey>:<eventId>` or `a:<kind>:<pubkey>:<dTag>`. */
  readonly key: string;
  /**
   * `created_at` of the deletion request. For address tombstones this bounds the
   * deletion: NIP-09 deletes all versions of an addressable event *up to* the
   * request's timestamp, so a genuinely newer version may still be stored.
   */
  readonly createdAt: Timestamp;
}

/** Everything a single kind-5 event asks to delete. */
export interface DeletionTargets {
  /** Tombstone keys for `e`-tag (by-id) deletions. */
  readonly idKeys: readonly string[];
  /** Raw event ids referenced, for evicting rows that are already stored. */
  readonly ids: readonly Hex32[];
  /** Tombstone keys for `a`-tag (by-address) deletions, author-checked. */
  readonly addressKeys: readonly string[];
  /** Raw addresses referenced, for evicting rows that are already stored. */
  readonly addresses: readonly string[];
  /** `created_at` of the deletion request. */
  readonly createdAt: Timestamp;
}

/** Tombstone key for "author `deleter` deleted event `id`". */
export function idTombstoneKey(deleter: Hex32, id: Hex32): string {
  return `i:${deleter}:${id}`;
}

/** Tombstone key for "the author of `address` deleted it". */
export function addressTombstoneKey(address: string): string {
  return `a:${address}`;
}

/**
 * Extracts the author-checked deletion targets of a kind-5 event.
 *
 * Returns empty targets for non-deletion events. `a` tags whose pubkey component
 * differs from the requester are dropped here, so a forged cross-author deletion
 * never reaches storage.
 */
export function deletionTargets(event: NostrEvent): DeletionTargets {
  if (event.kind !== KIND_DELETION) {
    return {
      idKeys: [],
      ids: [],
      addressKeys: [],
      addresses: [],
      createdAt: event.created_at,
    };
  }
  const ids: Hex32[] = [];
  const idKeys: string[] = [];
  const addresses: string[] = [];
  const addressKeys: string[] = [];
  for (const tag of event.tags) {
    const value = tag[1];
    if (value === undefined || value === "") continue;
    if (tag[0] === "e") {
      ids.push(value);
      idKeys.push(idTombstoneKey(event.pubkey, value));
    } else if (tag[0] === "a") {
      // Author check: only the address owner can delete the address.
      if (addressAuthor(value) !== event.pubkey) continue;
      addresses.push(value);
      addressKeys.push(addressTombstoneKey(value));
    }
  }
  return {
    idKeys,
    ids,
    addressKeys,
    addresses,
    createdAt: event.created_at,
  };
}

/**
 * The tombstone keys that could block `event`, in the order they should be
 * checked. An event is blocked if any of these keys is tombstoned (address
 * tombstones additionally compare timestamps — see
 * {@link isTombstonedBy}).
 */
export function blockingKeysFor(
  event: NostrEvent,
): readonly { readonly key: string; readonly boundByTimestamp: boolean }[] {
  const keys: { key: string; boundByTimestamp: boolean }[] = [
    { key: idTombstoneKey(event.pubkey, event.id), boundByTimestamp: false },
  ];
  const address = addressOf(event);
  if (address !== undefined) {
    keys.push({ key: addressTombstoneKey(address), boundByTimestamp: true });
  }
  return keys;
}

/**
 * Decides whether a tombstone record blocks an event.
 *
 * Id tombstones are absolute. Address tombstones only cover versions at or
 * before the deletion request's `created_at`, so republishing a *newer* version
 * of an addressable event is legal.
 */
export function isTombstonedBy(
  event: NostrEvent,
  record: TombstoneRecord,
  boundByTimestamp: boolean,
): boolean {
  if (!boundByTimestamp) return true;
  return event.created_at <= record.createdAt;
}

/**
 * In-memory tombstone index. The Dexie store keeps the same records in its own
 * table and reuses the pure helpers above, so both stores agree by construction.
 */
export class TombstoneIndex {
  private readonly records = new Map<string, TombstoneRecord>();

  /** Number of distinct tombstones held. */
  get size(): number {
    return this.records.size;
  }

  /** Records every target of a kind-5 event, keeping the newest timestamp. */
  ingest(event: NostrEvent): DeletionTargets {
    const targets = deletionTargets(event);
    for (const key of [...targets.idKeys, ...targets.addressKeys]) {
      const existing = this.records.get(key);
      if (existing === undefined || existing.createdAt < targets.createdAt) {
        this.records.set(key, { key, createdAt: targets.createdAt });
      }
    }
    return targets;
  }

  /** Restores persisted records (used when hydrating from IndexedDB). */
  load(records: readonly TombstoneRecord[]): void {
    for (const record of records) this.records.set(record.key, record);
  }

  /** All records, for persistence. */
  all(): readonly TombstoneRecord[] {
    return [...this.records.values()];
  }

  /** True when a tombstone forbids storing (or re-storing) `event`. */
  blocks(event: NostrEvent): boolean {
    for (const { key, boundByTimestamp } of blockingKeysFor(event)) {
      const record = this.records.get(key);
      if (record === undefined) continue;
      if (isTombstonedBy(event, record, boundByTimestamp)) return true;
    }
    return false;
  }

  /** Drops every tombstone. Only for `EventStore.clear()`. */
  clear(): void {
    this.records.clear();
  }
}
