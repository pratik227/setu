import { DEFAULT_ACCENT_ID, DEFAULT_THEME_ID } from "@setu/ui";
import { describe, expect, it } from "vitest";
import {
  changedKeys,
  contestedKeys,
  DEFAULT_SETTINGS,
  mergeSettings,
  parseSettingsDocument,
  SETTING_KEYS,
  SETTINGS_VERSION,
  type SettingsDocument,
  type SyncedSettings,
  sameSettings,
  serializeSettingsDocument,
  splitSettingsFields,
} from "./settingsDocument";

function settings(overrides: Partial<SyncedSettings> = {}): SyncedSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function document(overrides: Partial<SettingsDocument> = {}): SettingsDocument {
  return {
    version: SETTINGS_VERSION,
    settings: DEFAULT_SETTINGS,
    unknown: {},
    ...overrides,
  };
}

describe("DEFAULT_SETTINGS", () => {
  // If these drift from ThemeProvider's own defaults, a freshly installed device
  // believes its untouched theme is a deliberate local change and wins the merge
  // against the account's real one.
  it("agrees with the theme store about what untouched looks like", () => {
    expect(DEFAULT_SETTINGS.themeId).toBe(DEFAULT_THEME_ID);
    expect(DEFAULT_SETTINGS.accentId).toBe(DEFAULT_ACCENT_ID);
    expect(DEFAULT_SETTINGS.themeMode).toBe("system");
  });
});

describe("splitSettingsFields", () => {
  it("reads the keys it owns", () => {
    const { settings: read } = splitSettingsFields({
      themeMode: "dark",
      themeId: "dusk",
      accentId: "amber",
      homeFeed: "global-24h",
      trendingWindowSeconds: 3600,
      mediaHost: "https://files.example",
    });
    expect(read).toEqual({
      themeMode: "dark",
      themeId: "dusk",
      accentId: "amber",
      homeFeed: "global-24h",
      trendingWindowSeconds: 3600,
      mediaHost: "https://files.example",
    });
  });

  // The whole forward-compatibility story. A v2 build adds `fontScale`; this build
  // must hand it back untouched, not delete it.
  it("keeps every key it does not own", () => {
    const { unknown } = splitSettingsFields({
      themeId: "dusk",
      fontScale: 1.25,
      futureThing: { nested: ["a"] },
    });
    expect(unknown).toEqual({
      fontScale: 1.25,
      futureThing: { nested: ["a"] },
    });
  });

  // Values are held as written: a theme this build has never heard of must survive
  // a round trip, because coercing it here would mean *saving* the fallback and
  // losing the user's real choice.
  it("keeps a value it cannot render", () => {
    const { settings: read } = splitSettingsFields({
      themeId: "from-the-future",
    });
    expect(read.themeId).toBe("from-the-future");
  });

  it.each([
    ["themeMode", 42],
    ["themeMode", "sepia"],
    ["themeId", ""],
    ["themeId", 7],
    ["trendingWindowSeconds", "3600"],
    ["trendingWindowSeconds", 0],
    ["trendingWindowSeconds", -1],
    ["trendingWindowSeconds", Number.NaN],
    ["mediaHost", null],
  ])("falls back for a malformed %s of %o", (key, value) => {
    const { settings: read } = splitSettingsFields({ [key]: value });
    expect(read[key as keyof SyncedSettings]).toBe(
      DEFAULT_SETTINGS[key as keyof SyncedSettings],
    );
  });

  it("falls back to the caller's values rather than the defaults", () => {
    const local = settings({ themeId: "dusk", mediaHost: "https://mine" });
    const { settings: read } = splitSettingsFields(
      { accentId: "amber" },
      local,
    );
    expect(read.themeId).toBe("dusk");
    expect(read.mediaHost).toBe("https://mine");
    expect(read.accentId).toBe("amber");
  });
});

describe("parseSettingsDocument", () => {
  it("reads a versioned document", () => {
    const parsed = parseSettingsDocument('{"v":1,"themeMode":"dark"}');
    expect(parsed?.version).toBe(1);
    expect(parsed?.settings.themeMode).toBe("dark");
  });

  it("reads a document from a newer schema, keeping its version", () => {
    const parsed = parseSettingsDocument(
      '{"v":9,"themeMode":"dark","fontScale":2}',
    );
    expect(parsed?.version).toBe(9);
    expect(parsed?.unknown).toEqual({ fontScale: 2 });
  });

  // An unversioned blob has to be interpreted by guessing, and a wrong guess
  // produces a plausible document that overwrites a real one.
  it.each(["{}", '{"themeMode":"dark"}', "[]", "nonsense"])(
    "refuses %o",
    (raw) => {
      expect(parseSettingsDocument(raw)).toBeUndefined();
    },
  );
});

describe("serializeSettingsDocument", () => {
  it("round-trips every known key", () => {
    const original = document({
      settings: settings({ themeMode: "light", trendingWindowSeconds: 3600 }),
    });
    const parsed = parseSettingsDocument(serializeSettingsDocument(original));
    expect(parsed?.settings).toEqual(original.settings);
    expect(parsed?.version).toBe(original.version);
  });

  it("writes preserved keys back beside the known ones", () => {
    const parsed = parseSettingsDocument(
      serializeSettingsDocument(
        document({ version: 4, unknown: { fontScale: 1.5, x: null } }),
      ),
    );
    expect(parsed?.version).toBe(4);
    expect(parsed?.unknown).toEqual({ fontScale: 1.5, x: null });
  });

  // A stale unknown bucket that shadowed a known key would resurrect the value the
  // user just changed.
  it("never lets a preserved key shadow a known one", () => {
    const json = serializeSettingsDocument(
      document({
        settings: settings({ themeMode: "dark" }),
        unknown: { themeMode: "light" },
      }),
    );
    expect(parseSettingsDocument(json)?.settings.themeMode).toBe("dark");
  });

  // The document is the only thing published, so its key set is the security
  // boundary for "never sync a secret".
  it("writes nothing but the version, the known keys, and what was preserved", () => {
    const json = serializeSettingsDocument(document());
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      "v",
      ...SETTING_KEYS,
    ]);
  });
});

describe("changedKeys / sameSettings", () => {
  it("finds nothing between equal snapshots", () => {
    expect(changedKeys(DEFAULT_SETTINGS, settings())).toEqual([]);
    expect(sameSettings(DEFAULT_SETTINGS, settings())).toBe(true);
  });

  it("names exactly the fields that differ", () => {
    expect(
      changedKeys(
        settings({ themeId: "dusk", homeFeed: "global-24h" }),
        settings(),
      ),
    ).toEqual(["themeId", "homeFeed"]);
  });
});

describe("mergeSettings", () => {
  const base = settings();

  it("takes ours for fields we changed", () => {
    const merged = mergeSettings({
      base,
      ours: settings({ themeId: "dusk" }),
      theirs: base,
    });
    expect(merged.themeId).toBe("dusk");
  });

  it("takes theirs for fields we did not touch", () => {
    const merged = mergeSettings({
      base,
      ours: base,
      theirs: settings({ mediaHost: "https://theirs" }),
    });
    expect(merged.mediaHost).toBe("https://theirs");
  });

  // The reason the merge is per field at all: whole-document last-write-wins would
  // discard one of these two changes even though they cannot conflict.
  it("keeps both sides when they changed different fields", () => {
    const merged = mergeSettings({
      base,
      ours: settings({ themeId: "dusk" }),
      theirs: settings({ mediaHost: "https://theirs" }),
    });
    expect(merged).toEqual(
      settings({ themeId: "dusk", mediaHost: "https://theirs" }),
    );
  });

  it("treats a field we reverted to the base as untouched", () => {
    const merged = mergeSettings({
      base,
      ours: base,
      theirs: settings({ themeId: "dusk" }),
    });
    expect(merged.themeId).toBe("dusk");
  });
});

describe("contestedKeys", () => {
  const base = settings();

  it("is empty when only one side changed a field", () => {
    expect(
      contestedKeys({
        base,
        ours: settings({ themeId: "dusk" }),
        theirs: settings({ mediaHost: "https://theirs" }),
      }),
    ).toEqual([]);
  });

  it("names a field both sides changed differently", () => {
    expect(
      contestedKeys({
        base,
        ours: settings({ themeId: "dusk" }),
        theirs: settings({ themeId: "dawn" }),
      }),
    ).toEqual(["themeId"]);
  });

  // Two devices that made the *same* change agree; asking about it would be noise.
  it("is empty when both sides made the same change", () => {
    expect(
      contestedKeys({
        base,
        ours: settings({ themeId: "dusk" }),
        theirs: settings({ themeId: "dusk" }),
      }),
    ).toEqual([]);
  });
});
