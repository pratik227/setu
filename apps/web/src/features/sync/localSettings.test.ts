import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearBaseline,
  DEFAULT_DEVICE_SETTINGS,
  deviceSettings,
  effectiveSettings,
  readBaseline,
  resetDeviceSettingsCache,
  setDeviceSettings,
  writeBaseline,
} from "./localSettings";
import { DEFAULT_SETTINGS } from "./settingsDocument";

/** Minimal `localStorage`, so the key scheme and the persistence are real here. */
function stubStorage(): Map<string, string> {
  const rows = new Map<string, string>();
  const stub = {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
    removeItem: (key: string) => {
      rows.delete(key);
    },
    clear: () => rows.clear(),
    key: (index: number) => [...rows.keys()][index] ?? null,
    get length() {
      return rows.size;
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = stub;
  return rows;
}

let rows: Map<string, string>;

beforeEach(() => {
  rows = stubStorage();
  resetDeviceSettingsCache();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  resetDeviceSettingsCache();
});

describe("deviceSettings", () => {
  it("starts from the defaults with nothing stored", () => {
    expect(deviceSettings()).toEqual(DEFAULT_DEVICE_SETTINGS);
  });

  it("persists a change and reads it back", () => {
    setDeviceSettings({ mediaHost: "https://files.example" });
    expect(deviceSettings().mediaHost).toBe("https://files.example");
    resetDeviceSettingsCache();
    expect(deviceSettings().mediaHost).toBe("https://files.example");
  });

  it("keeps the settings it was not asked to change", () => {
    setDeviceSettings({ homeFeed: "global-24h" });
    setDeviceSettings({ trendingWindowSeconds: 3600 });
    expect(deviceSettings()).toEqual({
      ...DEFAULT_DEVICE_SETTINGS,
      homeFeed: "global-24h",
      trendingWindowSeconds: 3600,
    });
  });

  // The sync layer writes an identical value every time it confirms a document
  // matches; re-rendering every reader for that would be a churn loop.
  it("does not change the snapshot's identity for an identical write", () => {
    const before = deviceSettings();
    setDeviceSettings({ mediaHost: before.mediaHost });
    expect(deviceSettings()).toBe(before);
  });

  it.each([
    ["not json", DEFAULT_DEVICE_SETTINGS],
    ["null", DEFAULT_DEVICE_SETTINGS],
    ['{"mediaHost":42}', DEFAULT_DEVICE_SETTINGS],
    ['{"trendingWindowSeconds":"3600"}', DEFAULT_DEVICE_SETTINGS],
    ['{"trendingWindowSeconds":-5}', DEFAULT_DEVICE_SETTINGS],
    ['{"homeFeed":""}', DEFAULT_DEVICE_SETTINGS],
    // Read on the publish path: a difficulty that is not a whole number of bits
    // must fall back to off rather than reach the miner.
    ['{"powDifficulty":"20"}', DEFAULT_DEVICE_SETTINGS],
    ['{"powDifficulty":20.5}', DEFAULT_DEVICE_SETTINGS],
    ['{"powDifficulty":-1}', DEFAULT_DEVICE_SETTINGS],
  ])("survives a corrupt row (%o)", (raw, expected) => {
    rows.set("setu-settings", raw);
    resetDeviceSettingsCache();
    expect(deviceSettings()).toEqual(expected);
  });

  // Local settings are the source of truth for rendering, so a browser that
  // refuses storage must still get working settings rather than an exception.
  it("works with no storage at all", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    resetDeviceSettingsCache();
    expect(deviceSettings()).toEqual(DEFAULT_DEVICE_SETTINGS);
    setDeviceSettings({ homeFeed: "global-24h" });
    expect(deviceSettings().homeFeed).toBe("global-24h");
  });
});

describe("effectiveSettings", () => {
  it("assembles the document from the two places settings live", () => {
    setDeviceSettings({ mediaHost: "https://files.example" });
    expect(
      effectiveSettings({
        themeMode: "dark",
        themeId: "dusk",
        accentId: "amber",
      }),
    ).toEqual({
      themeMode: "dark",
      themeId: "dusk",
      accentId: "amber",
      homeFeed: DEFAULT_SETTINGS.homeFeed,
      trendingWindowSeconds: DEFAULT_SETTINGS.trendingWindowSeconds,
      mediaHost: "https://files.example",
      powDifficulty: DEFAULT_SETTINGS.powDifficulty,
    });
  });
});

describe("baselines", () => {
  const alice = "a".repeat(64);
  const bob = "b".repeat(64);

  it("is absent until this device has agreed with a document", () => {
    expect(readBaseline(alice)).toBeUndefined();
  });

  it("round-trips", () => {
    writeBaseline(alice, {
      createdAt: 1234,
      eventId: "e1",
      settings: { ...DEFAULT_SETTINGS, themeId: "dusk" },
    });
    expect(readBaseline(alice)).toEqual({
      createdAt: 1234,
      eventId: "e1",
      settings: { ...DEFAULT_SETTINGS, themeId: "dusk" },
    });
  });

  // Agreeing with a document is an account-scoped fact: one account's baseline
  // applied to another would make every one of the second account's settings look
  // like a deliberate local change.
  it("is scoped per account", () => {
    writeBaseline(alice, {
      createdAt: 1,
      eventId: "e1",
      settings: DEFAULT_SETTINGS,
    });
    expect(readBaseline(bob)).toBeUndefined();
    clearBaseline(alice);
    expect(readBaseline(alice)).toBeUndefined();
  });

  it("fills in missing keys rather than trusting a partial row", () => {
    rows.set(
      `setu-settings-sync:${alice}`,
      JSON.stringify({
        createdAt: 5,
        eventId: "e1",
        settings: { themeId: "dusk" },
      }),
    );
    expect(readBaseline(alice)?.settings).toEqual({
      ...DEFAULT_SETTINGS,
      themeId: "dusk",
    });
  });

  // A corrupt baseline read as valid would silently become the merge base and start
  // asserting garbage as "what this device changed".
  it.each([
    "not json",
    "null",
    '{"eventId":"e1","settings":{}}',
    '{"createdAt":5,"settings":{}}',
    '{"createdAt":5,"eventId":"e1"}',
    '{"createdAt":"5","eventId":"e1","settings":{}}',
  ])("refuses a malformed baseline (%o)", (raw) => {
    rows.set(`setu-settings-sync:${alice}`, raw);
    expect(readBaseline(alice)).toBeUndefined();
  });
});
