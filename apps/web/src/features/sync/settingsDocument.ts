import { parseAppDataJson, serializeAppDataJson } from "@setu/protocol";
import type { ThemeMode } from "@setu/ui";

/**
 * The document Setu keeps in NIP-78, and the rules for reading and writing it.
 *
 * ## Why this file is so careful
 *
 * A future build will read what today's build wrote, and an older build will be
 * asked to save a document a newer build created. Both directions have to be
 * non-destructive, or the feature that was supposed to carry your settings between
 * devices becomes the feature that deletes them — silently, because there is no
 * server to complain and no error a relay could return.
 *
 * So four rules, and each one exists because of a specific failure:
 *
 *  1. **Versioned.** `v` is written on every save and refused on read when absent
 *     (see `parseAppDataJson`). An unversioned blob has to be interpreted by
 *     guessing, and a wrong guess produces a plausible document that overwrites a
 *     real one.
 *  2. **Flat.** Every setting is a top-level scalar. Nesting looks tidier and makes
 *     preservation much harder: an unknown key *inside* a nested object has to be
 *     merged separately at every level, and the level that gets forgotten is where
 *     the data goes missing. One level, one merge.
 *  3. **Unknown keys are preserved verbatim.** Exactly the rule `profileEdit.ts`
 *     enforces for kind 0. A v2 build adds `fontScale`; a v1 build saves the
 *     document; `fontScale` must still be there.
 *  4. **A version bump may add keys or retire them. It may never reuse a key with a
 *     new meaning.** This is what makes rule 3 safe: because keys keep their
 *     meaning forever, an older build can read the parts of a newer document it
 *     recognises, write them back, and leave the rest alone — and it keeps the
 *     *higher* version number when it does, so saving from an old device does not
 *     downgrade a document a new device will read next.
 *
 * ## What is never in here
 *
 * **No secrets. Ever.** Not an `nsec`, not an ncryptsec, not a bunker connection
 * string or its secret token, not a NIP-42 challenge response, not a session
 * record. This document is published to relays; it is encrypted, but "encrypted
 * with the key we would be leaking" is not a security argument, and a copy of your
 * key on every relay you write to is a permanent compromise that no later fix can
 * recall. The type below is a closed record of six scalars, which is the enforcement:
 * the only path from local state into the document is `SyncedSettings`, so there is
 * nowhere for a secret to be added by accident. If you are about to widen it, that
 * is the moment to stop.
 *
 * Nor drafts, read marks, or anything else large or fast-moving. This is a
 * preferences document, and every save is a signed event broadcast to every write
 * relay.
 */

/** The document's address. One `d` tag, forever — see `nip78.ts`. */
export const SETTINGS_IDENTIFIER = "setu/settings";

/** Schema version of the fields this build understands. */
export const SETTINGS_VERSION = 1;

/**
 * The media host uploads go to.
 *
 * Defined here rather than in `useUpload` because it is now a synced preference,
 * and the default has to be the same value the sync layer compares against — two
 * definitions of "the default" is how a device decides it has unsaved changes
 * forever.
 */
export const DEFAULT_MEDIA_HOST = "https://nostr.build";

/**
 * Every synced setting, flat, and the exact set of keys this build owns.
 *
 * Values are held as written, not coerced: `themeId` is a `string` rather than a
 * union of the themes that exist today, because a document written by a build with
 * more themes must round-trip through this one unchanged. Rendering coerces at the
 * edge (`findTheme`, `homeFeedOption` both fall back), which is the right place —
 * falling back *here* would mean saving the fallback and losing the real choice.
 */
export interface SyncedSettings {
  readonly themeMode: ThemeMode;
  readonly themeId: string;
  readonly accentId: string;
  /** A `HomeFeedId`, kept as a string for the forward-compatibility reason above. */
  readonly homeFeed: string;
  /** "Talked about" window, in seconds. */
  readonly trendingWindowSeconds: number;
  readonly mediaHost: string;
}

export type SettingKey = keyof SyncedSettings;

/** Every key, in the order the UI lists them. */
export const SETTING_KEYS = [
  "themeMode",
  "themeId",
  "accentId",
  "homeFeed",
  "trendingWindowSeconds",
  "mediaHost",
] as const satisfies readonly SettingKey[];

const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

/**
 * What a device that has never synced and never been touched looks like.
 *
 * Load-bearing beyond being a fallback: it is the base of the three-way merge for
 * an account that has no baseline yet, so "the user changed something before ever
 * syncing" is detectable. That is why the theme values are asserted against
 * `ThemeProvider`'s own defaults in the tests rather than merely commented — if
 * they drift, a freshly installed device believes its untouched theme is a local
 * change and wins the merge against the account's real one.
 */
export const DEFAULT_SETTINGS: SyncedSettings = {
  themeMode: "system",
  themeId: "setu",
  accentId: "neutral",
  homeFeed: "latest",
  // 12 hours: the option Discover starts on.
  trendingWindowSeconds: 12 * 60 * 60,
  mediaHost: DEFAULT_MEDIA_HOST,
};

/** A parsed document: the settings it carries, its version, and the rest of it. */
export interface SettingsDocument {
  readonly version: number;
  readonly settings: SyncedSettings;
  /**
   * Keys this build does not know, carried through untouched on every write.
   *
   * Never merged into `settings` and never inspected. A key here belongs to a
   * build that understood it, and the only correct thing to do with it is put it
   * back exactly where it was found.
   */
  readonly unknown: Readonly<Record<string, unknown>>;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && THEME_MODES.includes(value as ThemeMode);
}

/**
 * Split a document body into the settings this build owns and everything else.
 *
 * A known key whose value has the wrong *type* — `themeMode: 42` — is dropped and
 * replaced by this device's value on the next save. That is the one place this
 * module does not preserve what it found, and deliberately: a number is not a mode
 * any build can honour, so carrying it forward would mean every future build has to
 * keep handling it, forever, to protect a value that was never meaningful. Unknown
 * *keys* are always preserved; malformed *known* keys are not.
 */
export function splitSettingsFields(
  fields: Readonly<Record<string, unknown>>,
  fallback: SyncedSettings = DEFAULT_SETTINGS,
): { settings: SyncedSettings; unknown: Record<string, unknown> } {
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key))
      unknown[key] = value;
  }

  const string = (key: SettingKey, current: string): string => {
    const value = fields[key];
    return typeof value === "string" && value !== "" ? value : current;
  };

  return {
    unknown,
    settings: {
      themeMode: isThemeMode(fields.themeMode)
        ? fields.themeMode
        : fallback.themeMode,
      themeId: string("themeId", fallback.themeId),
      accentId: string("accentId", fallback.accentId),
      homeFeed: string("homeFeed", fallback.homeFeed),
      trendingWindowSeconds:
        typeof fields.trendingWindowSeconds === "number" &&
        Number.isFinite(fields.trendingWindowSeconds) &&
        fields.trendingWindowSeconds > 0
          ? fields.trendingWindowSeconds
          : fallback.trendingWindowSeconds,
      mediaHost: string("mediaHost", fallback.mediaHost),
    },
  };
}

/**
 * Parse a decrypted document body.
 *
 * Returns `undefined` only when the body is not a versioned JSON object at all —
 * which is a document we must not overwrite blindly, because we cannot tell whether
 * it is corrupt or simply from somewhere we do not understand.
 */
export function parseSettingsDocument(
  json: string,
): SettingsDocument | undefined {
  const parsed = parseAppDataJson(json);
  if (!parsed) return undefined;
  const { settings, unknown } = splitSettingsFields(parsed.fields);
  return { version: parsed.version, settings, unknown };
}

/** Serialize a document body: version, known keys, then everything preserved. */
export function serializeSettingsDocument(document: SettingsDocument): string {
  const fields: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) fields[key] = document.settings[key];
  for (const [key, value] of Object.entries(document.unknown)) {
    // Known keys win: an unknown bucket that shadowed one would resurrect a value
    // the user just changed.
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      fields[key] = value;
    }
  }
  return serializeAppDataJson(document.version, fields);
}

/** Keys whose values differ. The unit both the merge and the UI work in. */
export function changedKeys(
  a: SyncedSettings,
  b: SyncedSettings,
): readonly SettingKey[] {
  return SETTING_KEYS.filter((key) => a[key] !== b[key]);
}

export function sameSettings(a: SyncedSettings, b: SyncedSettings): boolean {
  return changedKeys(a, b).length === 0;
}

/**
 * Three-way per-field merge: `base` is what both sides started from, `ours` is this
 * device, `theirs` is the document on the relays.
 *
 * Per *field*, not per document, and that is the whole reason concurrent edits do
 * not have to lose. Kind 30078 is addressable, so on the wire the newer event
 * replaces the older one entirely — two devices saving a whole-document snapshot
 * means the second one silently discards the first one's change even when they
 * touched completely different settings. Merging field by field against the last
 * snapshot we agreed on turns that into a loss only when *the same field* was
 * changed on both sides, which is a real conflict and is surfaced rather than
 * resolved.
 *
 * Ours wins a genuine tie here; callers are expected to detect the overlap first
 * (`contestedKeys`) and ask.
 */
export function mergeSettings({
  base,
  ours,
  theirs,
}: {
  readonly base: SyncedSettings;
  readonly ours: SyncedSettings;
  readonly theirs: SyncedSettings;
}): SyncedSettings {
  const merged: Record<string, unknown> = { ...theirs };
  for (const key of SETTING_KEYS) {
    if (ours[key] !== base[key]) merged[key] = ours[key];
  }
  return merged as unknown as SyncedSettings;
}

/** Fields both sides changed away from the base, to different values. */
export function contestedKeys({
  base,
  ours,
  theirs,
}: {
  readonly base: SyncedSettings;
  readonly ours: SyncedSettings;
  readonly theirs: SyncedSettings;
}): readonly SettingKey[] {
  return SETTING_KEYS.filter(
    (key) =>
      ours[key] !== base[key] &&
      theirs[key] !== base[key] &&
      ours[key] !== theirs[key],
  );
}
