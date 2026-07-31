import {
  type EventTemplate,
  eventDifficulty,
  type Hex32,
  type UnsignedEvent,
} from "@setu/protocol";

/**
 * Every decision around NIP-13 mining, deliberately outside the worker.
 *
 * `mineEvent` is a loop; the interesting parts are the choices around it — how long
 * to spend, whether a difficulty is worth starting at all, what to say when it did
 * not finish, and what the signer must be handed so the work is not thrown away.
 * All of that lives here, as pure functions, because a `Worker` cannot be unit
 * tested without a browser and none of these answers should be discovered by
 * reading a worker's source.
 *
 * This module must stay free of React and of DOM APIs: the worker imports it, and
 * anything pulled in here is pulled into a second bundle that exists only to hash.
 *
 * ## Mining happens before signing, and that constrains the template
 *
 * A `nonce` tag changes the serialised event, which changes its id, which is what
 * the signature covers. So the order is: pin `created_at`, mine, then sign the
 * mined tags — and the `created_at` has to be pinned *first*, because a signer that
 * fills in its own timestamp (every one of them does when the field is absent)
 * produces a different id and silently discards the work. `unsignedForMining` and
 * `templateFromMined` exist so that pairing is one decision in one place rather
 * than an invariant someone has to remember.
 */

/**
 * Hashes per second assumed when budgeting.
 *
 * Measured at roughly 550k/s for a small kind-1 on a current desktop; this is set
 * well below that on purpose. The number's only job is to turn a difficulty into a
 * time budget, and being pessimistic means a phone gets a budget it can actually
 * finish in rather than one derived from a laptop.
 */
const ASSUMED_HASHES_PER_SECOND = 200_000;

/**
 * Budget multiplier over the expected number of hashes.
 *
 * The search is geometric, not fixed-cost: the expected work is 2^bits hashes but
 * any individual attempt can take several times that. Four times expected clears
 * about 98% of attempts, so a difficulty the device can comfortably reach does not
 * report a timeout because of ordinary bad luck.
 */
const BUDGET_SAFETY_FACTOR = 4;

/** Never budget less than this — process startup alone is a few milliseconds. */
export const MIN_MINING_MS = 2_000;

/**
 * Never budget more than this, whatever the difficulty.
 *
 * A minute is already an extraordinary thing to ask of someone posting a note. The
 * cap is what makes the "publish without the work" path a *bounded* wait rather
 * than an open-ended one, and it is why a high difficulty degrades into a stated
 * failure instead of a composer that never comes back.
 */
export const MAX_MINING_MS = 60_000;

/**
 * The worst odds worth starting: a 1-in-50 chance of finishing inside the cap.
 *
 * Below that, spending the user's minute is not an attempt, it is a formality with
 * a known outcome — so {@link miningPlan} refuses up front and says so.
 */
const MIN_SUCCESS_ODDS = 50;

/** Expected hashes for a target, i.e. 2^bits. */
export function expectedHashes(targetBits: number): number {
  return 2 ** targetBits;
}

/** Expected wall-clock milliseconds for a target, at the assumed rate. */
export function estimateMiningMs(targetBits: number): number {
  return (expectedHashes(targetBits) / ASSUMED_HASHES_PER_SECOND) * 1000;
}

/** How long this build is willing to spend on a target. */
export function miningBudgetMs(targetBits: number): number {
  const wanted = estimateMiningMs(targetBits) * BUDGET_SAFETY_FACTOR;
  return Math.min(MAX_MINING_MS, Math.max(MIN_MINING_MS, Math.round(wanted)));
}

/**
 * The highest difficulty worth starting, derived rather than picked.
 *
 * Falls out of the cap and the odds above: whatever fits in a minute at the assumed
 * rate, times the odds we are willing to accept. Derived so that changing the cap
 * cannot leave a stale constant behind claiming 29 bits is attemptable when it no
 * longer is.
 */
export const MAX_ATTEMPTABLE_DIFFICULTY = Math.floor(
  Math.log2(
    (MAX_MINING_MS / 1000) * ASSUMED_HASHES_PER_SECOND * MIN_SUCCESS_ODDS,
  ),
);

/**
 * What to do about a configured difficulty.
 *
 * `unreachable` is a real case and not defensive coding: the synced document
 * deliberately accepts any non-negative integer so a value written by a future
 * build survives a round trip through this one, which means this build can be
 * handed a 40 it has no hope of mining.
 */
export type MiningPlan =
  | { readonly kind: "off" }
  | { readonly kind: "unreachable"; readonly targetBits: number }
  | {
      readonly kind: "mine";
      readonly targetBits: number;
      readonly budgetMs: number;
    };

/**
 * Turn the setting into a plan.
 *
 * A malformed value is *off*, never a best guess: difficulty is exponential, so
 * rounding 20.5 up or reading a stray `NaN` as some default is how a user who never
 * asked for proof of work ends up waiting for it.
 */
export function miningPlan(difficulty: number): MiningPlan {
  if (!Number.isInteger(difficulty) || difficulty <= 0) return { kind: "off" };
  if (difficulty > MAX_ATTEMPTABLE_DIFFICULTY) {
    return { kind: "unreachable", targetBits: difficulty };
  }
  return {
    kind: "mine",
    targetBits: difficulty,
    budgetMs: miningBudgetMs(difficulty),
  };
}

/**
 * The difficulties the picker offers.
 *
 * Short, and stopping at 24, because every extra bit doubles the cost and the
 * useful range is "off", "enough for a relay that only wants a token amount", and
 * "enough for one that means it". A free-text field here would let someone type 40
 * and wonder why posting broke.
 */
export const POW_CHOICES: readonly number[] = [0, 8, 16, 20, 24];

/** Round wall-clock milliseconds to something worth showing a human. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "under a second";
  const seconds = ms / 1000;
  if (seconds < 60) return `about ${Math.round(seconds)}s`;
  return `about ${Math.round(seconds / 60)}m`;
}

/** `1.4M`, `62k`, `900`. Hash counts are big and precision is not the point. */
export function formatHashes(hashes: number): string {
  if (hashes >= 1_000_000) return `${(hashes / 1_000_000).toFixed(1)}M`;
  if (hashes >= 1000) return `${Math.round(hashes / 1000)}k`;
  return String(hashes);
}

/**
 * Label for one entry in the picker, including what it costs.
 *
 * The cost is the whole decision being made, so it is on the option rather than in
 * help text below it: 20 and 24 look adjacent and differ by a factor of sixteen.
 */
export function difficultyChoiceLabel(bits: number): string {
  if (bits <= 0) return "Off";
  const budget = miningBudgetMs(bits);
  const estimate = estimateMiningMs(bits);
  // When the honest estimate is past the cap, say the cap: promising "about 84s"
  // when mining stops at 60 would be describing something that cannot happen.
  return estimate > budget
    ? `${bits} bits · up to ${formatDuration(budget)}, often not reached`
    : `${bits} bits · ${formatDuration(estimate)}`;
}

/** Live mining state, as the composer shows it. */
export interface MiningProgress {
  readonly targetBits: number;
  readonly hashes: number;
  readonly elapsedMs: number;
  readonly budgetMs: number;
}

/**
 * One line describing work in flight.
 *
 * Both numbers are here because both answer a different question: hashes say
 * something is happening, elapsed-of-budget says how much longer this can last. A
 * spinner alone at difficulty 24 is indistinguishable from a hung tab.
 */
export function miningLabel(progress: MiningProgress): string {
  const elapsed = Math.round(progress.elapsedMs / 1000);
  const budget = Math.round(progress.budgetMs / 1000);
  return `Mining proof of work, difficulty ${progress.targetBits} · ${formatHashes(
    progress.hashes,
  )} hashes · ${elapsed}s of ${budget}s`;
}

/**
 * The event the signer will hash, with `created_at` pinned.
 *
 * `pubkey` is part of the serialisation too, so it has to be the key that will
 * actually sign. Mining against the wrong one produces an event whose id has no
 * leading zeros at all.
 */
export function unsignedForMining(
  template: EventTemplate,
  pubkey: Hex32,
  nowSeconds: number,
): UnsignedEvent {
  return {
    pubkey,
    created_at: template.created_at ?? nowSeconds,
    kind: template.kind,
    tags: template.tags ?? [],
    content: template.content,
  };
}

/**
 * The template to sign once mining is done.
 *
 * Carries the mined `created_at` back even when the caller never set one — this is
 * the step that makes the work survive signing, and omitting it is a bug with no
 * visible symptom beyond an event that quietly has no proof of work.
 */
export function templateFromMined(
  template: EventTemplate,
  mined: UnsignedEvent,
): EventTemplate {
  return { ...template, created_at: mined.created_at, tags: mined.tags };
}

/**
 * How an attempt ended, before the signed id is known.
 *
 * `timeout` is not an error: `mineEvent` returning `undefined` is an expected
 * outcome that the caller has to have a policy for.
 */
export type PowAttemptOutcome =
  | "mined"
  | "timeout"
  | "skipped"
  | "unavailable"
  | "unreachable";

export interface PowSummary {
  /** The difficulty that was configured. 0 means proof of work was off. */
  readonly requested: number;
  /** The difficulty the *signed* id actually has. The only evidence there is. */
  readonly achieved: number;
  /**
   * `lost` is `mined` that did not survive signing — see {@link summarisePow}.
   */
  readonly outcome: PowAttemptOutcome | "lost";
}

/**
 * Grade an attempt against the event that was actually signed.
 *
 * Measured from the signed id, never from the miner's own report, because between
 * mining and signing sits a signer this app does not control. A NIP-07 extension
 * that ignores the `created_at` we sent, or an account switched in the extension
 * between mining and signing, both produce a perfectly valid event with none of the
 * work in it — and a client that reported "difficulty 20" there would be
 * advertising work it does not have, which per the NIP makes the claim invalid.
 */
export function summarisePow(attempt: {
  readonly requested: number;
  readonly outcome: PowAttemptOutcome;
  readonly signedId: string;
}): PowSummary {
  const achieved = eventDifficulty(attempt.signedId);
  const outcome =
    attempt.outcome === "mined" && achieved < attempt.requested
      ? "lost"
      : attempt.outcome;
  return { requested: attempt.requested, achieved, outcome };
}

/**
 * What to tell the user about the work, or nothing when there is nothing to say.
 *
 * The rule this enforces: **publishing without the work is fine, pretending it is
 * there is not.** Every outcome that did not produce the requested difficulty says
 * so in a sentence naming why, so "sent" never covers for a silent downgrade.
 */
export function describePow(
  summary: PowSummary | undefined,
): string | undefined {
  if (!summary || summary.requested <= 0) return undefined;
  switch (summary.outcome) {
    case "mined":
      return `Includes proof of work: difficulty ${summary.achieved}.`;
    case "timeout":
      return `Published without proof of work: difficulty ${summary.requested} was not reached within ${formatDuration(
        miningBudgetMs(summary.requested),
      )}. Most relays accept notes without it.`;
    case "skipped":
      return `Published without proof of work: you skipped mining. Most relays accept notes without it.`;
    case "unreachable":
      return `Published without proof of work: difficulty ${summary.requested} is more than this device can mine inside ${formatDuration(
        MAX_MINING_MS,
      )}. Lower it in Settings if a relay is asking for it.`;
    case "unavailable":
      return "Published without proof of work: mining needs a Web Worker, which this browser did not provide.";
    case "lost":
      return `Proof of work was lost after mining: the signer changed the note, so the id has difficulty ${summary.achieved} rather than ${summary.requested}.`;
  }
}

/** How many hashes `mineEvent` does between two reads of its injected clock. */
export const HASHES_PER_CLOCK_READ = 512;

/** How often the worker reports in. Fast enough to look alive, rare enough to be free. */
export const PROGRESS_INTERVAL_MS = 250;

/** What the main thread asks the worker to do. */
export interface PowMineRequest {
  readonly event: UnsignedEvent;
  readonly targetBits: number;
  readonly budgetMs: number;
}

/** What the worker says back. `timeout` is a normal completion, not an error. */
export type PowWorkerMessage =
  | {
      readonly type: "progress";
      readonly hashes: number;
      readonly elapsedMs: number;
    }
  | {
      readonly type: "mined";
      readonly event: UnsignedEvent;
      readonly difficulty: number;
      readonly hashes: number;
    }
  | { readonly type: "timeout" };
