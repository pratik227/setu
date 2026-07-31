/**
 * The list of identities this device remembers.
 *
 * Separate from `setu-session`, which names the *active* one, because the two answer
 * different questions and the distinction is the whole feature:
 *
 *  - `setu-session` — who am I signed in as right now?
 *  - `setu-accounts` — who else could I switch to without setting up again?
 *
 * ## Switching away is not removing
 *
 * This is the trap. `SessionProvider.signOut` deletes the account's IndexedDB
 * database, its conversation read marks and its notification watermark, because
 * signing out on a shared computer must not leave the previous user's timeline and
 * message partners sitting under the login screen. **Switching** must run none of
 * that: the whole point of a switcher is coming back to a warm cache and the read
 * positions you left. So the two operations are separate functions with separate
 * names all the way down, and this module's `forgetAccount` only edits the list —
 * discarding data is the caller's explicit second step.
 *
 * ## One signed-in account at a time
 *
 * There is one engine, one relay pool and one store, all keyed to the active pubkey
 * (`EngineProvider`). This list is a set of saved credentials, not a set of live
 * sessions: nothing is fetched, no notification arrives, and no message is received
 * for an account that is not the active one. Anything that implied otherwise would be
 * a promise the architecture cannot keep.
 */

import {
  assertPersistable,
  isStoredSession,
  type StoredSession,
} from "./storage";

const ACCOUNTS_KEY = "setu-accounts";

/** A remembered identity: a stored session plus when we first saw it. */
export interface StoredAccount extends StoredSession {
  /** Unix ms, used only to keep the list in a stable, meaningful order. */
  readonly addedAt: number;
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!isStoredSession(value)) return false;
  const addedAt = (value as { addedAt?: unknown }).addedAt;
  return typeof addedAt === "number" && Number.isFinite(addedAt);
}

/**
 * Add or update one account in a list.
 *
 * Pure so the two properties that matter can be asserted rather than assumed: an
 * account is keyed by pubkey and therefore never duplicated, and re-signing in keeps
 * its original `addedAt` so the switcher does not reshuffle itself every time
 * somebody unlocks a key.
 */
export function upsertAccount(
  accounts: readonly StoredAccount[],
  session: StoredSession,
  now: number,
): readonly StoredAccount[] {
  const existing = accounts.find(
    (account) => account.pubkey === session.pubkey,
  );
  const updated: StoredAccount = {
    ...session,
    addedAt: existing?.addedAt ?? now,
  };
  return [
    ...accounts.filter((account) => account.pubkey !== session.pubkey),
    updated,
  ].sort((a, b) => a.addedAt - b.addedAt);
}

/** Drop one account from a list. Touches no stored data. */
export function removeAccount(
  accounts: readonly StoredAccount[],
  pubkey: string,
): readonly StoredAccount[] {
  return accounts.filter((account) => account.pubkey !== pubkey);
}

/**
 * Can this record be restored into a signing session on its own?
 *
 * `nip07` can (the extension holds the key), `readonly` never signed anyway, and
 * `encrypted`/`nip46` need a passphrase first — which is not a defect but the reason
 * those keys are safe at rest. Drives the "locked" affordance in the switcher, so a
 * user knows before they click that they are about to be asked for something.
 */
export function needsPassphrase(account: StoredSession): boolean {
  return account.kind === "encrypted" || account.kind === "nip46";
}

/** Every remembered account, oldest first. Never throws; bad data reads as empty. */
export function loadAccounts(): readonly StoredAccount[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filtered rather than rejected wholesale: one malformed entry must not cost
    // the user every other account they had saved.
    return parsed.filter(isStoredAccount).sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [];
  }
}

function writeAccounts(accounts: readonly StoredAccount[]): void {
  try {
    assertPersistable(accounts);
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch (error) {
    // The same split as `saveSession`: a refusal is a bug worth surfacing, and a
    // full or disabled storage only costs the list being remembered.
    if (error instanceof Error && error.message.startsWith("refusing")) {
      throw error;
    }
  }
}

/** Remember an account, or refresh what we know about one. */
export function rememberAccount(
  session: StoredSession,
  now: number = Date.now(),
): readonly StoredAccount[] {
  const next = upsertAccount(loadAccounts(), session, now);
  writeAccounts(next);
  return next;
}

/**
 * Forget an account.
 *
 * Removes the credential record and nothing else. Deleting the account's cached
 * events and read state is a separate, louder operation — see the module note.
 */
export function forgetAccount(pubkey: string): readonly StoredAccount[] {
  const next = removeAccount(loadAccounts(), pubkey);
  writeAccounts(next);
  return next;
}

/** The remembered record for one pubkey, if there is one. */
export function findAccount(pubkey: string): StoredAccount | undefined {
  return loadAccounts().find((account) => account.pubkey === pubkey);
}
