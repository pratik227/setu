/**
 * NIP-13 proof of work: spending computation to make an event id start with zeros.
 *
 * An event id is a SHA-256 of the serialised event, so nudging a `nonce` tag and
 * rehashing until the id has enough leading zero *bits* is the only way to produce
 * one. Some relays require it before they will accept a write, and a client without it
 * does not get an error it can explain — the note is simply rejected, or accepted and
 * quietly dropped.
 *
 * ## Difficulty is leading zero *bits*, not zero hex characters
 *
 * The distinction is the single most common way to get this wrong, and it is off by a
 * factor of four: `0x0f…` has four leading zero bits and one leading zero nibble.
 * Counting characters means advertising difficulty 8 for work worth 32, which a relay
 * checking properly will reject — after the user waited for it.
 *
 * ## Mining is cancellable, and bounded by the caller
 *
 * Difficulty cost is exponential: each extra bit doubles the expected hashes. 20 bits
 * is about a million, which is a moment; 30 is a billion, which is not. So this never
 * loops forever — it takes a deadline and reports failure, because a composer that
 * hangs is worse than one that says "this relay wants more work than we could do".
 *
 * The loop yields nothing and blocks whatever thread it runs on. That is a *caller*
 * decision this module deliberately does not make: on the main thread it will stutter
 * the UI, and the right home for real difficulty is a worker.
 */

import { computeEventId } from "./event";
import type { UnsignedEvent } from "./types";

/** The `nonce` tag name, per the NIP. */
const NONCE_TAG = "nonce";

/**
 * Leading zero bits in a hex-encoded 32-byte id.
 *
 * Counts *bits*, per the NIP. A non-hex character ends the count rather than throwing:
 * this is also used on ids that arrived from a relay, and a malformed one has no
 * difficulty rather than being a crash.
 */
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (const char of hex) {
    const nibble = Number.parseInt(char, 16);
    if (Number.isNaN(nibble)) break;
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    // Math.clz32 counts leading zeros in a 32-bit word; a nibble's own leading zeros
    // are that minus the 28 bits above it.
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

/**
 * The difficulty an event actually achieved.
 *
 * Measured from the id, never read from the `nonce` tag's committed target. The tag
 * says what the author was *aiming* for and is trivially inflated; only the hash is
 * evidence. A client that trusted the tag would let anyone claim any difficulty.
 */
export function eventDifficulty(id: string): number {
  return leadingZeroBits(id);
}

/**
 * The difficulty the author committed to, from the `nonce` tag, or undefined.
 *
 * Useful only for *display* alongside {@link eventDifficulty} — a mismatch means the
 * author claimed more than they did, which per the NIP makes the event invalid for
 * anyone who cares about the claim.
 */
export function committedDifficulty(
  event: Pick<UnsignedEvent, "tags">,
): number | undefined {
  for (const tag of event.tags) {
    if (tag[0] !== NONCE_TAG) continue;
    const target = Number(tag[2]);
    if (Number.isInteger(target) && target >= 0) return target;
  }
  return undefined;
}

export interface MineResult {
  /** The event with its `nonce` tag, ready to sign. */
  readonly event: UnsignedEvent;
  /** Difficulty actually reached — always >= the target. */
  readonly difficulty: number;
  /** How many hashes it took. Reported so a UI can say what it spent. */
  readonly hashes: number;
}

export interface MineOptions {
  /** Leading zero bits required. 0 or less returns the event untouched. */
  readonly targetBits: number;
  /**
   * Give up after this many milliseconds.
   *
   * Mandatory, with no default, because the alternative is a loop that can run for
   * years at a difficulty a user typed by accident. A caller that genuinely wants to
   * keep going passes a large number and means it.
   */
  readonly timeoutMs: number;
  /** Injected clock, so a test does not have to spend real time. */
  readonly now?: () => number;
}

/**
 * Mine a `nonce` until the event id has `targetBits` leading zero bits.
 *
 * Returns `undefined` on timeout rather than throwing — running out of time is an
 * expected outcome here, not an error, and the caller's next move (publish anyway,
 * lower the target, tell the user) is a policy decision.
 *
 * `created_at` is left alone. Bumping it as a second entropy source is tempting and is
 * a real technique, but it would silently re-date a note the user wrote a minute ago,
 * and for a *reply* it can reorder a conversation.
 */
export function mineEvent(
  event: UnsignedEvent,
  options: MineOptions,
): MineResult | undefined {
  const { targetBits, timeoutMs } = options;
  const clock = options.now ?? (() => Date.now());

  if (targetBits <= 0) {
    const id = computeEventId(event);
    return { event, difficulty: leadingZeroBits(id), hashes: 0 };
  }

  // Every tag except an existing nonce: re-mining an event must not accumulate one
  // nonce tag per attempt, which would grow the event on each retry and change what
  // the reader signed.
  const baseTags = event.tags.filter((tag) => tag[0] !== NONCE_TAG);
  const deadline = clock() + timeoutMs;

  let nonce = 0;
  let hashes = 0;
  for (;;) {
    const candidate: UnsignedEvent = {
      ...event,
      tags: [...baseTags, [NONCE_TAG, String(nonce), String(targetBits)]],
    };
    const id = computeEventId(candidate);
    hashes += 1;
    const difficulty = leadingZeroBits(id);
    if (difficulty >= targetBits) {
      return { event: candidate, difficulty, hashes };
    }

    nonce += 1;
    // The clock is read every 512 hashes rather than every one: `Date.now()` is not
    // free, and at these rates checking it per attempt is a measurable share of the
    // work being done.
    if ((nonce & 0x1ff) === 0 && clock() >= deadline) return undefined;
  }
}
