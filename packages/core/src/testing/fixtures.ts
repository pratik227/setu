/**
 * Deterministic event fixtures for this package's tests.
 *
 * Not part of the public barrel — the ids and signatures here are structurally
 * valid but cryptographically meaningless, so nothing that verifies signatures
 * should ever see them.
 */

import type { Hex32, NostrEvent, Timestamp } from "@setu/protocol";

/**
 * Deterministic lowercase hex of `length` chars from a seed string.
 *
 * Seeds are hex-encoded then right-padded, so `hex("a") < hex("b")` — handy for
 * exercising the NIP-01 lexical-id tiebreaker.
 */
export function hex(seed: string, length = 64): string {
  let out = "";
  for (let i = 0; i < seed.length; i += 1) {
    out += seed.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return (out + "0".repeat(length)).slice(0, length);
}

let counter = 0;

/** Fields that may be overridden on a fixture event. */
export interface EventOverrides {
  readonly id?: Hex32;
  readonly pubkey?: Hex32;
  readonly created_at?: Timestamp;
  readonly kind?: number;
  readonly tags?: readonly (readonly string[])[];
  readonly content?: string;
  readonly sig?: string;
}

/** Builds a structurally valid event, defaulting every unspecified field. */
export function makeEvent(overrides: EventOverrides = {}): NostrEvent {
  counter += 1;
  return {
    id: overrides.id ?? hex(`id-${counter}`),
    pubkey: overrides.pubkey ?? hex("alice"),
    created_at: overrides.created_at ?? 1_700_000_000,
    kind: overrides.kind ?? 1,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "hello",
    sig: overrides.sig ?? hex("sig", 128),
  };
}

/** A kind-5 deletion request for the given ids and/or addresses. */
export function makeDeletion(options: {
  readonly pubkey: Hex32;
  readonly ids?: readonly Hex32[];
  readonly addresses?: readonly string[];
  readonly created_at?: Timestamp;
  readonly id?: Hex32;
}): NostrEvent {
  const tags: string[][] = [];
  for (const id of options.ids ?? []) tags.push(["e", id]);
  for (const address of options.addresses ?? []) tags.push(["a", address]);
  return makeEvent({
    ...(options.id !== undefined ? { id: options.id } : {}),
    pubkey: options.pubkey,
    kind: 5,
    tags,
    ...(options.created_at !== undefined
      ? { created_at: options.created_at }
      : {}),
  });
}

/** Well-known pubkeys used across the suites. */
export const PUBKEYS = {
  alice: hex("alice"),
  bob: hex("bob"),
  carol: hex("carol"),
} as const;
