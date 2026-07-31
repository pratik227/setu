import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  type SettingsDocument,
  type SyncedSettings,
} from "./settingsDocument";
import {
  decideSync,
  planSettingsWrite,
  type RemoteDocument,
  remoteIsAhead,
  type SyncBaseline,
} from "./syncDecision";

function settings(overrides: Partial<SyncedSettings> = {}): SyncedSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function remote({
  createdAt = 1000,
  eventId = "e1",
  version = SETTINGS_VERSION,
  unknown = {},
  ...overrides
}: Partial<SyncedSettings> & {
  createdAt?: number;
  eventId?: string;
  version?: number;
  unknown?: Record<string, unknown>;
} = {}): RemoteDocument {
  const document: SettingsDocument = {
    version,
    settings: settings(overrides),
    unknown,
  };
  return { createdAt, eventId, document };
}

function baseline(
  overrides: Partial<SyncedSettings> = {},
  at: { createdAt?: number; eventId?: string } = {},
): SyncBaseline {
  return {
    createdAt: at.createdAt ?? 1000,
    eventId: at.eventId ?? "e1",
    settings: settings(overrides),
  };
}

describe("remoteIsAhead", () => {
  it("treats any document as ahead of never having synced", () => {
    expect(remoteIsAhead(remote(), undefined)).toBe(true);
  });

  it("compares created_at", () => {
    expect(remoteIsAhead(remote({ createdAt: 2000 }), baseline())).toBe(true);
    expect(remoteIsAhead(remote({ createdAt: 500 }), baseline())).toBe(false);
  });

  it("is false for the document we already agreed with", () => {
    expect(remoteIsAhead(remote(), baseline())).toBe(false);
  });

  // At equal timestamps the lowest id is what every relay keeps, so the *earlier*
  // id really is the document we will be reading from now on. Treating it as old
  // would leave this device merging against a copy no relay serves.
  it("breaks a created_at tie the way relays do", () => {
    const ours = baseline({}, { createdAt: 1000, eventId: "bbbb" });
    expect(
      remoteIsAhead(remote({ createdAt: 1000, eventId: "aaaa" }), ours),
    ).toBe(true);
    expect(
      remoteIsAhead(remote({ createdAt: 1000, eventId: "cccc" }), ours),
    ).toBe(false);
  });
});

describe("decideSync", () => {
  it("reports an absent document when nothing has ever synced", () => {
    expect(
      decideSync({
        local: settings(),
        baseline: undefined,
        remote: undefined,
        absenceConfirmed: false,
      }),
    ).toEqual({ kind: "absent", confirmed: false });
  });

  it("carries whether the absence is confirmed", () => {
    const status = decideSync({
      local: settings(),
      baseline: undefined,
      remote: undefined,
      absenceConfirmed: true,
    });
    expect(status).toEqual({ kind: "absent", confirmed: true });
  });

  // A device with a baseline published the document once; the relays not having
  // handed it back yet does not make this device's copy suspect.
  it("trusts the baseline when the document has not arrived", () => {
    expect(
      decideSync({
        local: settings(),
        baseline: baseline(),
        remote: undefined,
        absenceConfirmed: false,
      }),
    ).toEqual({ kind: "in-sync" });
    expect(
      decideSync({
        local: settings({ themeId: "dusk" }),
        baseline: baseline(),
        remote: undefined,
        absenceConfirmed: false,
      }),
    ).toEqual({ kind: "unsaved", changed: ["themeId"] });
  });

  it("is in sync when nothing has changed on either side", () => {
    expect(
      decideSync({
        local: settings(),
        baseline: baseline(),
        remote: remote(),
        absenceConfirmed: true,
      }),
    ).toEqual({ kind: "in-sync" });
  });

  it("names this device's unsaved changes", () => {
    expect(
      decideSync({
        local: settings({ themeId: "dusk", mediaHost: "https://mine" }),
        baseline: baseline(),
        remote: remote(),
        absenceConfirmed: true,
      }),
    ).toEqual({ kind: "unsaved", changed: ["themeId", "mediaHost"] });
  });

  // A second device signing in for the first time: nothing local to protect, so
  // the account's settings are taken silently. This is the case the whole feature
  // exists for.
  it("adopts wholesale on a device with default settings and no baseline", () => {
    const status = decideSync({
      local: settings(),
      baseline: undefined,
      remote: remote({ themeMode: "dark", themeId: "dusk" }),
      absenceConfirmed: true,
    });
    expect(status.kind).toBe("adopt");
    if (status.kind !== "adopt") return;
    expect(status.settings.themeId).toBe("dusk");
    expect(status.changed).toEqual(["themeMode", "themeId"]);
  });

  // Disjoint changes are not a conflict, and prompting about them would train the
  // user to dismiss the prompt that matters.
  it("merges disjoint changes without asking", () => {
    const status = decideSync({
      local: settings({ themeId: "dusk" }),
      baseline: baseline(),
      remote: remote({ mediaHost: "https://theirs", createdAt: 2000 }),
      absenceConfirmed: true,
    });
    expect(status.kind).toBe("adopt");
    if (status.kind !== "adopt") return;
    expect(status.settings).toEqual(
      settings({ themeId: "dusk", mediaHost: "https://theirs" }),
    );
    // Only the field arriving from the other device is "changing" locally.
    expect(status.changed).toEqual(["mediaHost"]);
  });

  it("asks when both devices changed the same field", () => {
    const status = decideSync({
      local: settings({ themeId: "dusk" }),
      baseline: baseline(),
      remote: remote({ themeId: "dawn", createdAt: 2000 }),
      absenceConfirmed: true,
    });
    expect(status.kind).toBe("conflict");
    if (status.kind !== "conflict") return;
    expect(status.contested).toEqual(["themeId"]);
    expect(status.theirs.themeId).toBe("dawn");
    expect(status.ours.themeId).toBe("dusk");
  });

  // A device that has been customised but never synced must not have its settings
  // replaced without being asked, even though it has no baseline.
  it("asks rather than discarding local settings on a first sync", () => {
    const status = decideSync({
      local: settings({ themeId: "dusk" }),
      baseline: undefined,
      remote: remote({ themeId: "dawn" }),
      absenceConfirmed: true,
    });
    expect(status.kind).toBe("conflict");
  });

  it("does not ask when both devices made the same change", () => {
    const status = decideSync({
      local: settings({ themeId: "dusk" }),
      baseline: baseline(),
      remote: remote({ themeId: "dusk", createdAt: 2000 }),
      absenceConfirmed: true,
    });
    expect(status.kind).toBe("adopt");
  });

  // The document has been re-published with the same values — nothing to apply, but
  // the caller still advances the baseline so this does not re-evaluate forever.
  it("adopts an identical newer document with nothing to change", () => {
    const status = decideSync({
      local: settings(),
      baseline: baseline(),
      remote: remote({ createdAt: 2000, eventId: "e2" }),
      absenceConfirmed: true,
    });
    expect(status).toEqual({
      kind: "adopt",
      settings: settings(),
      changed: [],
    });
  });
});

describe("planSettingsWrite", () => {
  // The destructive case, and the reason this refusal exists: a first save built
  // while the account's real document is still in flight replaces settings from
  // another device *and* every unknown key a newer build put there.
  it("refuses to write from an unconfirmed absence", () => {
    expect(
      planSettingsWrite({
        local: settings({ themeId: "dusk" }),
        baseline: undefined,
        remote: undefined,
        absenceConfirmed: false,
      }),
    ).toEqual({ ok: false, reason: "unverified-absence" });
  });

  it("creates a first document once the absence is confirmed", () => {
    const result = planSettingsWrite({
      local: settings({ themeId: "dusk" }),
      baseline: undefined,
      remote: undefined,
      absenceConfirmed: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.document.version).toBe(SETTINGS_VERSION);
    expect(result.plan.document.settings.themeId).toBe("dusk");
    expect(result.plan.document.unknown).toEqual({});
  });

  it("refuses a write that would change nothing", () => {
    expect(
      planSettingsWrite({
        local: settings(),
        baseline: baseline(),
        remote: remote(),
        absenceConfirmed: true,
      }),
    ).toEqual({ ok: false, reason: "no-change" });
  });

  // Merge, never rebuild — the same rule kind 0 needs. Without it, saving from a
  // v1 build deletes every key a v2 build wrote.
  it("preserves the keys it does not understand", () => {
    const result = planSettingsWrite({
      local: settings({ themeId: "dusk" }),
      baseline: baseline(),
      remote: remote({ unknown: { fontScale: 1.5 } }),
      absenceConfirmed: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.document.unknown).toEqual({ fontScale: 1.5 });
  });

  // An old build saving a new build's document must not renumber it downwards: the
  // keys it did not understand are still in there and still mean what v9 meant.
  it("keeps a higher version than this build writes", () => {
    const result = planSettingsWrite({
      local: settings({ themeId: "dusk" }),
      baseline: baseline(),
      remote: remote({ version: 9 }),
      absenceConfirmed: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.document.version).toBe(9);
  });

  // The point of the three-way merge on the write path: this device asserts only
  // what it changed, so the other device's concurrent change to a different field
  // survives a write that replaces the whole document.
  it("asserts only the fields this device changed", () => {
    const result = planSettingsWrite({
      local: settings({ themeId: "dusk" }),
      baseline: baseline(),
      remote: remote({ mediaHost: "https://theirs", createdAt: 2000 }),
      absenceConfirmed: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.document.settings).toEqual(
      settings({ themeId: "dusk", mediaHost: "https://theirs" }),
    );
    expect(result.plan.changed).toEqual(["themeId"]);
  });

  // A device whose local state is stale — it never changed anything, the other
  // device did — has nothing to assert, so there is nothing to write and nothing
  // it could clobber.
  it("has nothing to write when only the other device changed something", () => {
    expect(
      planSettingsWrite({
        local: settings(),
        baseline: baseline(),
        remote: remote({ themeId: "dawn", createdAt: 2000 }),
        absenceConfirmed: true,
      }),
    ).toEqual({ ok: false, reason: "no-change" });
  });
});
