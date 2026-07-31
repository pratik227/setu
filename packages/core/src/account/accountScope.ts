/**
 * The account-scope reset registry.
 *
 * **Why this exists before there is anything to register.**
 *
 * Module-level singletons — a relay pool, a profile cache, a `since` tracker, a
 * feed engine held in a module variable — survive React unmounts, route changes,
 * hot reloads and, critically, account switches. That is precisely how data leaks
 * across accounts: the component tree is rebuilt, the singleton is not, and the
 * new account renders the previous account's cache.
 *
 * The failure mode is not the singleton; it is *forgetting* one. Registration is
 * therefore colocated with construction: whatever creates a long-lived object
 * registers its reset in the same statement, so adding a singleton without
 * registering it is a visible omission rather than an invisible one.
 *
 * ```ts
 * const pool = new WebSocketRelayPool();
 * registerResettable("relayPool", () => pool.close());
 * ```
 *
 * Then, on sign-out or account switch, exactly once, before the new account's
 * objects are constructed:
 *
 * ```ts
 * await resetAccountScope();
 * ```
 *
 * This module is deliberately the only singleton in `@setu/core` — everything else
 * is constructed and injected, so it is the only thing that *can* leak.
 */

import type { Unsubscribe } from "../contracts";

/** A reset function. May be async; may not throw meaningfully — see below. */
export type ResetFn = () => void | Promise<void>;

/** What a reset failure reports. */
export interface ResetFailure {
  /** The name the resettable was registered under. */
  readonly name: string;
  readonly error: unknown;
}

/** Outcome of a {@link resetAccountScope} run. */
export interface ResetReport {
  /** Names reset without error, in reset order. */
  readonly reset: readonly string[];
  /** Resettables that threw. One failure never prevents the others running. */
  readonly failures: readonly ResetFailure[];
}

interface Registration {
  readonly name: string;
  readonly reset: ResetFn;
  /** Insertion order, so resets run in a predictable sequence. */
  readonly seq: number;
}

const registry = new Map<string, Registration>();
let sequence = 0;

/**
 * Registers a reset function under a unique name.
 *
 * Registering an existing name **replaces** the previous entry rather than
 * appending: the common cause is a hot reload re-running module initialisation,
 * and keeping both would reset a stale object. Choose names that identify the
 * singleton, not the call site (`"relayPool"`, `"profileBatcher"`).
 *
 * Returns a function that removes the registration, for the rare object whose
 * lifetime is shorter than the account's.
 */
export function registerResettable(name: string, reset: ResetFn): Unsubscribe {
  if (name === "") throw new Error("registerResettable requires a name");
  sequence += 1;
  const registration: Registration = { name, reset, seq: sequence };
  registry.set(name, registration);
  return () => {
    // Only unregister if this exact registration is still the live one, so a
    // replaced entry's disposer cannot remove its successor.
    if (registry.get(name) === registration) registry.delete(name);
  };
}

/** Names currently registered, in registration order. */
export function listResettables(): readonly string[] {
  return [...registry.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => entry.name);
}

/**
 * Runs every registered reset, in registration order.
 *
 * A throwing reset is collected and reporting continues — a half-reset scope is
 * strictly worse than a fully-reset one with an error to log, because the whole
 * point is that no fragment of the previous account survives. Call this exactly
 * once per account switch, before constructing the new account's objects.
 *
 * Registrations are *not* removed: the singletons still exist and will need
 * resetting again on the next switch. Use the disposer from
 * {@link registerResettable} to remove one permanently.
 */
export async function resetAccountScope(): Promise<ResetReport> {
  const entries = [...registry.values()].sort((a, b) => a.seq - b.seq);
  const reset: string[] = [];
  const failures: ResetFailure[] = [];
  for (const entry of entries) {
    try {
      await entry.reset();
      reset.push(entry.name);
    } catch (error) {
      failures.push({ name: entry.name, error });
    }
  }
  return { reset, failures };
}

/**
 * Empties the registry without running anything.
 *
 * For test isolation only. Calling this in app code loses the ability to reset
 * the singletons that are still alive, which is the exact bug this module exists
 * to prevent.
 */
export function clearResettables(): void {
  registry.clear();
}
