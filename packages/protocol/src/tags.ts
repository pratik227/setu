/**
 * Tag helpers over the raw `string[][]` wire shape.
 *
 * No object wrapping, no per-event index built eagerly: tags are read on the
 * hot path (timeline rendering walks every event's tags) and allocating a
 * wrapper per tag is a cost paid on every row for no benefit. These are plain
 * loops over the array the relay gave us.
 */

import { isAddressable } from "./kinds";
import type { Hex32, NostrEvent } from "./types";

/** Anything with tags — lets helpers work on unsigned drafts too. */
export interface HasTags {
  readonly tags: readonly (readonly string[])[];
}

/** Full tag rows whose first element is `name`. */
export function getTagged(
  event: HasTags,
  name: string,
): readonly (readonly string[])[] {
  const out: (readonly string[])[] = [];
  for (const tag of event.tags) {
    if (tag[0] === name) out.push(tag);
  }
  return out;
}

/** Value (element 1) of the first tag named `name`, if present. */
export function getTagValue(event: HasTags, name: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === name) return tag[1];
  }
  return undefined;
}

/** Values (element 1) of every tag named `name`, skipping valueless rows. */
export function getTagValues(event: HasTags, name: string): string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== name) continue;
    const value = tag[1];
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** True if the event carries a tag named `name` with the given value. */
export function hasTag(event: HasTags, name: string, value?: string): boolean {
  for (const tag of event.tags) {
    if (tag[0] !== name) continue;
    if (value === undefined || tag[1] === value) return true;
  }
  return false;
}

/** The `d` tag identifier of an addressable event (`""` when absent). */
export function dTag(event: HasTags): string | undefined {
  return getTagValue(event, "d");
}

/** Event ids referenced by `e` tags, in order. */
export function eTags(event: HasTags): string[] {
  return getTagValues(event, "e");
}

/** Pubkeys referenced by `p` tags, in order. */
export function pTags(event: HasTags): Hex32[] {
  return getTagValues(event, "p");
}

/** Relay hints (`r` tags) in order. */
export function rTags(event: HasTags): string[] {
  return getTagValues(event, "r");
}

/** Hashtags (`t` tags), lowercased, deduped. */
export function hashtags(event: HasTags): string[] {
  const seen = new Set<string>();
  for (const value of getTagValues(event, "t")) {
    seen.add(value.toLowerCase());
  }
  return [...seen];
}

/**
 * `kind:pubkey:dTag` coordinate for an addressable (30000–39999) event.
 * Returns `undefined` for non-addressable kinds, where the coordinate has no
 * meaning and using one would silently create a second identity for the event.
 */
export function replaceableAddress(event: NostrEvent): string | undefined {
  if (!isAddressable(event.kind)) return undefined;
  return `${event.kind}:${event.pubkey}:${dTag(event) ?? ""}`;
}

/** Build a coordinate without an event in hand. */
export function addressOf(
  kind: number,
  pubkey: Hex32,
  identifier = "",
): string {
  return `${kind}:${pubkey}:${identifier}`;
}

/** Parsed `a`-tag coordinate. */
export interface ParsedAddress {
  readonly kind: number;
  readonly pubkey: Hex32;
  readonly identifier: string;
}

/** Parse a `kind:pubkey:identifier` coordinate; `undefined` if malformed. */
export function parseAddress(coordinate: string): ParsedAddress | undefined {
  const first = coordinate.indexOf(":");
  if (first <= 0) return undefined;
  const second = coordinate.indexOf(":", first + 1);
  if (second < 0) return undefined;
  const kind = Number(coordinate.slice(0, first));
  if (!Number.isInteger(kind)) return undefined;
  const pubkey = coordinate.slice(first + 1, second);
  if (pubkey.length !== 64) return undefined;
  return { kind, pubkey, identifier: coordinate.slice(second + 1) };
}

/** Root and direct-parent event ids of a reply, per NIP-10. */
export interface ThreadRefs {
  readonly root?: Hex32;
  readonly reply?: Hex32;
}

/**
 * Resolve thread position from `e` tags per NIP-10.
 *
 * Marked tags win: `["e", id, relay, "root"]` / `"reply"`. When no markers are
 * present we fall back to the deprecated positional scheme, because a large
 * amount of history predates markers and dropping it makes old threads look
 * flat: first `e` tag is the root, last is the direct parent, and a lone `e`
 * tag is both.
 */
export function rootAndReplyIds(event: HasTags): ThreadRefs {
  const rows = getTagged(event, "e");
  let root: string | undefined;
  let reply: string | undefined;
  let sawMarker = false;

  for (const tag of rows) {
    const id = tag[1];
    if (id === undefined || id.length === 0) continue;
    const marker = tag[3];
    if (marker === "root") {
      sawMarker = true;
      root ??= id;
    } else if (marker === "reply") {
      sawMarker = true;
      reply ??= id;
    } else if (marker === "mention") {
      // Mentions are not thread positions; NIP-10 says ignore them here.
      sawMarker = true;
    }
  }

  if (sawMarker) {
    // Markers present means the author speaks NIP-10, so their absence is
    // information: an event whose only marked e-tag is a `mention` is a quote,
    // not a reply, and must not be threaded under it.
    if (root === undefined && reply === undefined) return {};
    // A reply marker with no root marker means the parent *is* the root.
    if (root === undefined) return { root: reply, reply };
    if (reply === undefined) return { root, reply: root };
    return { root, reply };
  }

  const positional: string[] = [];
  for (const tag of rows) {
    const id = tag[1];
    if (id !== undefined && id.length > 0) positional.push(id);
  }
  if (positional.length === 0) return {};
  const first = positional[0] as string;
  if (positional.length === 1) return { root: first, reply: first };
  return { root: first, reply: positional[positional.length - 1] as string };
}

/** True if the event is a reply to something (has a resolvable parent). */
export function isReply(event: HasTags): boolean {
  return rootAndReplyIds(event).reply !== undefined;
}
