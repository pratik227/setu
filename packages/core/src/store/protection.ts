/**
 * NIP-70 protected events, and the one refusal the publish path owes them.
 *
 * A `["-"]` tag means "only this event's own author may publish it". It is a
 * request about *relaying*, not about storage, which splits the rule in two — and
 * both halves live here so they cannot drift apart:
 *
 *  1. **Storage keeps it.** A protected event we received is legitimate data: the
 *     relay that served it accepted it from its author, and refusing to store it
 *     would only mean the reader cannot see a note everyone else can. So the
 *     store inserts it normally and records the fact via
 *     {@link ../contracts.StoredEvent.protected}.
 *  2. **We never rebroadcast someone else's.** Republishing a protected event to
 *     another relay is precisely what the author asked us not to do — it moves
 *     their note somewhere they chose not to put it. So the publish path refuses,
 *     loudly, with {@link ProtectedEventPublishError}.
 *
 * The marking is derived, never stored twice: {@link isProtected} reads the tag
 * list that the signature already covers, and both stores call it at insert time
 * to fill the row flag. There is no parallel map of protected ids to fall out of
 * sync with the events themselves.
 */

import type { Hex32, NostrEvent } from "@setu/protocol";

/** The NIP-70 tag name: a bare `["-"]` row. */
export const PROTECTED_TAG = "-";

/**
 * True when `event` carries the NIP-70 `-` tag.
 *
 * The tag takes no value, so only the name is examined. This is the authority for
 * the rule — a `StoredEvent.protected` flag is filled from this function at
 * insert time and never computed any other way.
 */
export function isProtected(event: {
  readonly tags: readonly (readonly string[])[];
}): boolean {
  for (const tag of event.tags) {
    if (tag[0] === PROTECTED_TAG) return true;
  }
  return false;
}

/**
 * True when we are allowed to hand `event` to a relay.
 *
 * `ownPubkey` is the identity this client can sign as, and is `undefined` when
 * there is none (or when the caller never wired one up). An unknown identity
 * refuses: not knowing whether an event is ours is not evidence that it is, and
 * the cost of the two mistakes is not symmetric — a refused publish is a visible
 * error the caller can act on, while a wrong rebroadcast cannot be taken back.
 */
export function mayPublish(
  event: NostrEvent,
  ownPubkey: Hex32 | undefined,
): boolean {
  if (!isProtected(event)) return true;
  return ownPubkey !== undefined && event.pubkey === ownPubkey;
}

/**
 * Thrown instead of publishing a protected event that is not ours.
 *
 * A refusal has to be *loud*. Silently dropping it would leave the caller's UI
 * showing a successful post that no relay ever saw; sending it anyway would break
 * the author's request. Throwing a typed error is the only outcome a caller
 * cannot mistake for either, and the fields below give a UI enough to explain
 * itself without re-deriving anything.
 */
export class ProtectedEventPublishError extends Error {
  /** Stable discriminant, safe to compare across module instances. */
  readonly code = "protected-event";
  /** The event that was not published. */
  readonly eventId: Hex32;
  /** Its author — the only party allowed to publish it. */
  readonly author: Hex32;

  constructor(event: NostrEvent) {
    super(
      `refusing to publish protected event ${event.id}: NIP-70 allows only its author (${event.pubkey}) to publish it`,
    );
    this.name = "ProtectedEventPublishError";
    this.eventId = event.id;
    this.author = event.pubkey;
  }
}

/**
 * Type guard for {@link ProtectedEventPublishError}.
 *
 * Matches on the `code` field rather than on `instanceof`, so a caller that ended
 * up with two copies of this module in its bundle still recognises the refusal.
 */
export function isProtectedEventPublishError(
  error: unknown,
): error is ProtectedEventPublishError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "protected-event"
  );
}

/**
 * Thrown when an event handed to `publish` fails verification.
 *
 * Distinct in kind from the NIP-70 refusal: that one means "this is not ours to
 * relay", this one means "this event is not what it claims to be". A caller
 * seeing this has a bug or a tampered event, not a permissions problem.
 */
export class UnverifiedPublishError extends Error {
  readonly code = "unverified-event" as const;
  readonly eventId: string;

  constructor(event: { readonly id: string }) {
    super(
      "refusing to publish an event that failed verification: its id or " +
        "signature does not match its content",
    );
    this.name = "UnverifiedPublishError";
    this.eventId = event.id;
  }
}

/** Matches on `code` rather than `instanceof`, so it survives bundling. */
export function isUnverifiedPublishError(
  error: unknown,
): error is UnverifiedPublishError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "unverified-event"
  );
}
