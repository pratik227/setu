import { createContext, type ReactNode, useContext } from "react";
import { type SettingsSync, useSettingsSync } from "./useSettingsSync";

/**
 * The settings sync engine, mounted once for the whole app.
 *
 * ## Why this exists at all
 *
 * `useSettingsSync` was called from exactly one place: the Settings panel. Sync
 * therefore ran only while that panel was on screen. Everything downstream of it
 * followed from that one fact — a second device's preferences arrived when you opened
 * Settings and not before, so the feed you were shown on launch was this device's
 * default even when the account had a stored answer. The document was being published
 * correctly and read almost never.
 *
 * Reading has to happen where the app starts, not where the settings are displayed.
 *
 * ## Why a provider rather than a second call
 *
 * Calling the hook in both places would work — `useSharedSubscription` dedupes the
 * REQ, and adopting is idempotent — but it would create two writers for one piece of
 * state. Both instances hold their own baseline in React state, both decrypt, and both
 * run the adopt effect; the baseline is the record of *what this device last agreed
 * with*, and two copies of it drifting apart is precisely how a merge decides a field
 * the other device changed was a local edit and reverts it on the next save. One
 * engine, one baseline.
 *
 * The panel reads this instance instead of making its own, so what it displays and
 * what it would publish are the same object.
 *
 * ## What is deliberately *not* here
 *
 * Rendering. Consumers of a *setting* read `useDeviceSettings()` directly and know
 * nothing about sync — that is the "local is the source of truth for rendering, the
 * relay document is a channel" rule from `localSettings.ts`. This context carries the
 * sync machinery (status, conflicts, save), which only Settings needs. A screen that
 * imported it to find out the media host would be waiting on a relay for an answer
 * already sitting in `localStorage`.
 */

const SettingsSyncContext = createContext<SettingsSync | undefined>(undefined);

export function SettingsSyncProvider({ children }: { children: ReactNode }) {
  const sync = useSettingsSync();
  return (
    <SettingsSyncContext.Provider value={sync}>
      {children}
    </SettingsSyncContext.Provider>
  );
}

/**
 * The app's sync engine.
 *
 * Throws when the provider is missing rather than falling back to a fresh engine: a
 * silent second instance is the two-baselines bug described above, and it would show
 * up as settings quietly reverting rather than as anything a test would catch.
 */
export function useSettingsSyncContext(): SettingsSync {
  const sync = useContext(SettingsSyncContext);
  if (!sync) {
    throw new Error("useSettingsSyncContext requires <SettingsSyncProvider>");
  }
  return sync;
}
