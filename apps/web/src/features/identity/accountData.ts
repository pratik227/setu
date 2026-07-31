/**
 * Deleting one account's local data, and reporting honestly about it.
 *
 * Split from `SessionProvider` because it is the part with teeth: two entry points
 * that differ by one line, and choosing the wrong one either leaves a signed-out
 * user's timeline on a shared computer or closes the live engine out from under the
 * user who is still reading. Worth its own file, and its own name, so a call site
 * has to state which it means.
 *
 * The distinction that runs through the whole feature: **switching away is not
 * removing**. Nothing here is ever called on a switch (`accounts.ts`).
 */

import { DexieEventStore, resetAccountScope } from "@setu/core";
import type { Hex32 } from "@setu/protocol";
import { clearReadMarks } from "../chat/readMarks";
import { clearNotificationsRead } from "../notifications/readState";

/**
 * What a data-discarding operation managed to do about an account's local data.
 *
 * Reported rather than thrown, and the two outcomes are never merged. "Signed out
 * and the events are gone" and "signed out, but this account's notes, profile cache
 * and private-message wraps are still on this device" are different facts about a
 * shared computer, and only the second one asks anything of the user.
 */
export type SignOutCleanup =
  | { readonly status: "cleared" }
  | { readonly status: "left-behind"; readonly reason: string };

/**
 * How long to wait for the browser to drop the database before giving up on it.
 *
 * An IndexedDB deletion is *blocked*, not failed, while any connection to the
 * database is open — including one in another tab of this origin — and a blocked
 * request reports nothing at all: no error, no completion. Without a deadline a
 * sign-out on a second tab would leave this promise pending for the life of the
 * page and the user would never be told either way.
 */
const DATABASE_DELETE_TIMEOUT_MS = 5000;

/**
 * Everything one account keeps on this device, deleted. Returns why not, or nothing.
 *
 * The reason is returned raw rather than phrased, because the two callers are talking
 * about different things: one has just signed the user out, the other has removed an
 * account the user was not looking at. "Signed out, but…" is wrong for the second.
 *
 * The notification watermark is in here for a reason it did not used to be: it
 * survived sign-out, so the previous account's read position outlived every other
 * trace of them. Both it and the conversation read marks go before the database and
 * unconditionally — they are keyed by account and cost nothing to remove, so there is
 * no reason for them to be contingent on IndexedDB cooperating.
 */
async function deleteAccountStorage(
  pubkey: string,
): Promise<string | undefined> {
  clearReadMarks(pubkey);
  clearNotificationsRead(pubkey);
  try {
    await Promise.race([
      new DexieEventStore({ accountPubkey: pubkey as Hex32 }).destroy(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "the browser did not finish deleting it — another tab may still have it open",
              ),
            ),
          DATABASE_DELETE_TIMEOUT_MS,
        ),
      ),
    ]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Tears down the **active** account's long-lived objects, then deletes its database.
 *
 * The order is the entire content of this function.
 *
 *  1. `resetAccountScope` runs the resets registered with it — the engine, then the
 *     store (see `EngineProvider`). The store goes *after* the engine because the
 *     engine's subscriptions hold observers on it: dropping the store first leaves a
 *     live query firing against a closed handle. And it goes at all because the
 *     deletion waits on every connection still open to the database. Dexie does
 *     close its own instances when it sees a deletion coming — an ingest batch
 *     flushing a frame late can reopen one, which is the "was blocked" notice in the
 *     console — but that only rescues handles Dexie knows about, and the pool has to
 *     stop feeding it either way.
 *  2. Only then is the database deleted, through a throwaway handle: nothing up here
 *     holds a reference to the store the provider built, and a second connection
 *     opened purely to drop the database is harmless once the first one is closed.
 *
 * The registry snapshot is taken by the `resetAccountScope()` call below, which runs
 * synchronously with this function's first line — deliberately, because by the time
 * React has re-rendered the tree without an account the provider has registered the
 * *signed-out* engine under the same names, and resetting that one would close a
 * pool the login screen is about to use.
 *
 * Nothing here throws. The caller has already signed the user out; a failure to
 * tidy up is something to report, not something to undo a sign-out over.
 */
export async function discardAccountData(
  pubkey: string | undefined,
): Promise<SignOutCleanup> {
  const report = await resetAccountScope();
  const failed = report.failures.map((failure) => failure.name);

  // No pubkey means no database was ever opened for this session: a signed-out
  // session gets an in-memory store, on purpose, so there is nothing on disk to
  // attribute to anyone (see `EngineProvider`).
  if (pubkey === undefined) {
    return failed.length === 0
      ? { status: "cleared" }
      : {
          status: "left-behind",
          reason: `Setu could not shut down ${failed.join(", ")} while signing out.`,
        };
  }

  const problem = await deleteAccountStorage(pubkey);
  if (problem) {
    return {
      status: "left-behind",
      reason: `Signed out, but this account's stored events are still on this device: ${problem}`,
    };
  }

  return failed.length === 0
    ? { status: "cleared" }
    : {
        status: "left-behind",
        // The database is gone, so the events are — but something refused to close,
        // and a half-torn-down scope is worth saying out loud rather than rounding
        // down to success.
        reason: `The stored events were deleted, but ${failed.join(", ")} did not shut down cleanly.`,
      };
}

/**
 * Delete a *non-active* account's data.
 *
 * `resetAccountScope()` is deliberately absent. The registry names the live engine
 * and store, which belong to whoever is still signed in — running the resets while
 * removing somebody else's account would close a pool and a database in active use,
 * and the user would watch their own timeline go blank for deleting an account they
 * were not looking at.
 */
export async function discardInactiveAccountData(
  pubkey: string,
): Promise<SignOutCleanup> {
  const problem = await deleteAccountStorage(pubkey);
  return problem
    ? {
        status: "left-behind",
        reason: `That account is no longer in the switcher, but its stored events are still on this device: ${problem}`,
      }
    : { status: "cleared" };
}
