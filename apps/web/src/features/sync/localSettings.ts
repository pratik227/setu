import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, type SyncedSettings } from "./settingsDocument";
import type { SyncBaseline } from "./syncDecision";

/**
 * The device's own copy of its settings, and the last document it agreed with.
 *
 * Two separate things in one file because they are two halves of the same rule:
 * **local is the source of truth for rendering, the relay document is a channel.**
 * Everything a screen reads comes from here, synchronously, with no network and no
 * account. Sign in on a second device and sync fills this in; stay signed out and
 * nothing about settings stops working. That direction is not an implementation
 * detail — a client whose theme depends on a relay answering is a client that boots
 * grey on a bad connection.
 *
 * ## Why a module store and not a context
 *
 * The composer reads the media host, Settings writes it, and neither is a parent of
 * the other. A provider would have to sit above both, and the value would then be
 * unavailable to anything mounted outside it. `useSyncExternalStore` over one module
 * singleton has no such geometry, and there is exactly one copy of the state — two
 * hooks holding their own `useState` mirror of the same key is how two surfaces come
 * to disagree.
 *
 * ## What is *not* here
 *
 * Appearance. `ThemeProvider` already owns mode/theme/accent and persists them under
 * `setu-theme`, which the anti-FOUC boot script reads before React exists. Copying
 * those three values here as well would create a second writer for one piece of
 * state, and the loser of that race paints the wrong background on the next reload.
 * The sync layer reads appearance from the theme context and writes it back through
 * the theme context; only the settings nothing else owns live in this store.
 */

/** The settings this store owns: everything except appearance. */
export type DeviceSettings = Pick<
  SyncedSettings,
  "homeFeed" | "trendingWindowSeconds" | "mediaHost"
>;

export const DEVICE_SETTING_KEYS = [
  "homeFeed",
  "trendingWindowSeconds",
  "mediaHost",
] as const satisfies readonly (keyof DeviceSettings)[];

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  homeFeed: DEFAULT_SETTINGS.homeFeed,
  trendingWindowSeconds: DEFAULT_SETTINGS.trendingWindowSeconds,
  mediaHost: DEFAULT_SETTINGS.mediaHost,
};

/**
 * Not scoped to an account, deliberately.
 *
 * These are device preferences that must work before anyone signs in — the upload
 * host matters to a signed-in user, but the feed choice and the window are read on
 * screens that render with no session at all. Scoping them per pubkey would mean a
 * signed-out user has no settings, which is the failure this store exists to avoid.
 * The *baseline* below is per account, because agreeing with a document is
 * inherently an account-scoped fact.
 */
const DEVICE_KEY = "setu-settings";

/** One account's baseline. Keyed by pubkey: two accounts, two documents. */
function baselineKey(pubkey: string): string {
  return `setu-settings-sync:${pubkey}`;
}

/** `localStorage`, or undefined where it is blocked (private mode, iframes). */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Accessing `localStorage` *throws* on some configurations rather than being
    // absent, and an unhandled throw here would take the whole app down at import
    // time. Settings then live for the session only, which is the right degradation.
    return undefined;
  }
}

function readDevice(): DeviceSettings {
  const raw = storage()?.getItem(DEVICE_KEY);
  if (!raw) return DEFAULT_DEVICE_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_DEVICE_SETTINGS;
    }
    const object = parsed as Record<string, unknown>;
    return {
      homeFeed:
        typeof object.homeFeed === "string" && object.homeFeed !== ""
          ? object.homeFeed
          : DEFAULT_DEVICE_SETTINGS.homeFeed,
      trendingWindowSeconds:
        typeof object.trendingWindowSeconds === "number" &&
        Number.isFinite(object.trendingWindowSeconds) &&
        object.trendingWindowSeconds > 0
          ? object.trendingWindowSeconds
          : DEFAULT_DEVICE_SETTINGS.trendingWindowSeconds,
      mediaHost:
        typeof object.mediaHost === "string" && object.mediaHost !== ""
          ? object.mediaHost
          : DEFAULT_DEVICE_SETTINGS.mediaHost,
    };
  } catch {
    // A corrupt row is not worth a broken app: fall back to defaults and let the
    // next write replace it.
    return DEFAULT_DEVICE_SETTINGS;
  }
}

let current: DeviceSettings | undefined;
const listeners = new Set<() => void>();

/** The current device settings. Reads storage once, then serves from memory. */
export function deviceSettings(): DeviceSettings {
  current ??= readDevice();
  return current;
}

/**
 * Change one or more device settings.
 *
 * The snapshot's identity changes only when a value does, so a component reading
 * through `useDeviceSettings` does not re-render because something wrote an
 * identical value — which the sync layer does every time it confirms a document
 * matches.
 */
export function setDeviceSettings(patch: Partial<DeviceSettings>): void {
  const next: DeviceSettings = { ...deviceSettings(), ...patch };
  if (DEVICE_SETTING_KEYS.every((key) => next[key] === deviceSettings()[key])) {
    return;
  }
  current = next;
  try {
    storage()?.setItem(DEVICE_KEY, JSON.stringify(next));
  } catch {
    // Quota or a disabled store: the setting still applies for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the device settings, re-rendering when they change. */
export function useDeviceSettings(): DeviceSettings {
  return useSyncExternalStore(subscribe, deviceSettings, deviceSettings);
}

/**
 * Everything a document carries, assembled from the two places it lives.
 *
 * Appearance is passed in rather than read, so this stays usable from a test and
 * from a non-React caller.
 */
export function effectiveSettings(appearance: {
  readonly themeMode: SyncedSettings["themeMode"];
  readonly themeId: string;
  readonly accentId: string;
}): SyncedSettings {
  return { ...deviceSettings(), ...appearance };
}

/** The baseline for an account, or undefined if this device has never synced it. */
export function readBaseline(pubkey: string): SyncBaseline | undefined {
  const raw = storage()?.getItem(baselineKey(pubkey));
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const object = parsed as Record<string, unknown>;
    if (
      typeof object.createdAt !== "number" ||
      typeof object.eventId !== "string" ||
      typeof object.settings !== "object" ||
      object.settings === null
    ) {
      return undefined;
    }
    // The stored settings are re-validated through the same splitter the wire uses,
    // because a baseline read from a corrupt row would silently become the merge
    // base and start asserting garbage as "what this device changed".
    return {
      createdAt: object.createdAt,
      eventId: object.eventId,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(object.settings as Partial<SyncedSettings>),
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Record that this device now agrees with a document.
 *
 * Written after a successful publish *and* after adopting a remote document — both
 * are moments where this device and the relays hold the same thing, and only the
 * baseline distinguishes "I changed this" from "the other device did" next time.
 */
export function writeBaseline(pubkey: string, baseline: SyncBaseline): void {
  try {
    storage()?.setItem(baselineKey(pubkey), JSON.stringify(baseline));
  } catch {
    // Without a baseline the next comparison falls back to defaults, which is
    // conservative — it can ask about a conflict that is not one, but it cannot
    // silently discard a change.
  }
}

/** Forget an account's baseline. Used when its settings are deliberately reset. */
export function clearBaseline(pubkey: string): void {
  try {
    storage()?.removeItem(baselineKey(pubkey));
  } catch {
    // Nothing to do: an unremovable row cannot cause a wrong write, only an
    // unnecessary comparison.
  }
}

/** Test seam: drops the in-memory copy so the next read hits storage again. */
export function resetDeviceSettingsCache(): void {
  current = undefined;
  for (const listener of listeners) listener();
}
