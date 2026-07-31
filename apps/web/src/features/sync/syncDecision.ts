import {
  changedKeys,
  contestedKeys,
  DEFAULT_SETTINGS,
  mergeSettings,
  SETTINGS_VERSION,
  type SettingKey,
  type SettingsDocument,
  type SyncedSettings,
} from "./settingsDocument";

/**
 * What to do when the local settings and the account's document disagree.
 *
 * ## The conflict rule, stated once
 *
 * Kind 30078 is addressable: relays keep the newest event per `(pubkey, kind, d)`
 * and discard the rest. So *on the wire* this is last-write-wins by `created_at`,
 * and no client can change that. What a client chooses is what it writes, and the
 * rule here is:
 *
 *  1. **Local state is the source of truth for rendering.** The document is a
 *     synchronisation channel, never a dependency. Signed out, offline, or with
 *     nothing on the relays, settings work exactly as they did before this file
 *     existed.
 *  2. **Every write is a three-way merge**, base = the snapshot this device last
 *     agreed on, ours = local, theirs = the newest document we hold. A device
 *     therefore only ever asserts the fields *it* changed, so two devices editing
 *     different settings both survive — which whole-document last-write-wins
 *     would not manage.
 *  3. **A newer remote document is never clobbered by a stale local one.** Staleness
 *     is detected structurally, by comparing the document's `created_at`/`id`
 *     against the baseline this device merged from, not by trusting clocks to
 *     order two devices' edits.
 *  4. **The same field changed on both sides is a conflict, and is asked about.**
 *     Not merged, not silently won by whoever saves last: the panel names the
 *     fields and offers "keep this device's" or "use the other device's". Anything
 *     else loses a change the user made and never told them.
 *  5. **Disjoint changes are adopted automatically.** If the other device changed
 *     only settings this device did not, taking them costs nothing and asking about
 *     them would train the user to dismiss the prompt.
 *
 * Nothing here writes; `decideSync` is a pure function of three snapshots so the
 * rules above are testable without a relay.
 */

/**
 * The last document state this device agreed with, per account.
 *
 * All three parts are needed. `settings` is the merge base — without it, "the user
 * changed the theme here" and "the other device changed the theme" are
 * indistinguishable. `createdAt` and `eventId` identify *which* document that was,
 * so a newer one is recognised as newer even when its contents happen to match.
 */
export interface SyncBaseline {
  readonly createdAt: number;
  readonly eventId: string;
  readonly settings: SyncedSettings;
}

/** The newest document we hold for this account, decrypted and parsed. */
export interface RemoteDocument {
  readonly createdAt: number;
  readonly eventId: string;
  readonly document: SettingsDocument;
}

export type SyncStatus =
  /** No document on the relays yet — and we are sure, or still looking. */
  | { readonly kind: "absent"; readonly confirmed: boolean }
  /** The document matches this device. */
  | { readonly kind: "in-sync" }
  /** This device has changes the document does not carry. */
  | { readonly kind: "unsaved"; readonly changed: readonly SettingKey[] }
  /**
   * The document carries changes this device can take without losing anything.
   * `settings` is the merged result to apply locally.
   */
  | {
      readonly kind: "adopt";
      readonly settings: SyncedSettings;
      readonly changed: readonly SettingKey[];
    }
  /** Both sides changed the same fields. Needs a decision, not a merge. */
  | {
      readonly kind: "conflict";
      readonly contested: readonly SettingKey[];
      readonly theirs: SyncedSettings;
      /** What "keep this device's" would produce, for the resolve path. */
      readonly ours: SyncedSettings;
    };

/**
 * True when `remote` is a document this device has not already accounted for.
 *
 * The `created_at` comparison is the important one, but the tie needs the same
 * treatment relays give it: at equal timestamps the lowest id is the one that
 * survives, so a document with an *earlier* id at the same second really is the
 * one we will be reading from now on, and treating it as old would leave this
 * device merging against a copy no relay serves.
 */
export function remoteIsAhead(
  remote: RemoteDocument,
  baseline: SyncBaseline | undefined,
): boolean {
  if (!baseline) return true;
  if (remote.createdAt !== baseline.createdAt) {
    return remote.createdAt > baseline.createdAt;
  }
  return remote.eventId !== baseline.eventId
    ? remote.eventId < baseline.eventId
    : false;
}

export interface SyncInput {
  /** What this device is rendering right now. */
  readonly local: SyncedSettings;
  readonly baseline: SyncBaseline | undefined;
  readonly remote: RemoteDocument | undefined;
  /**
   * True only once we are confident the account has no document.
   *
   * Same rule as every other replaceable write in Settings: "there is nothing
   * stored" and "nothing has arrived yet" look identical, and acting on the second
   * as if it were the first is what destroys a document written elsewhere.
   */
  readonly absenceConfirmed: boolean;
}

export function decideSync({
  local,
  baseline,
  remote,
  absenceConfirmed,
}: SyncInput): SyncStatus {
  // No baseline means this device never agreed to anything, so the base of the
  // merge is "factory settings". A device whose settings still match the defaults
  // has nothing to lose and adopts silently; one that has been customised does
  // not, which is why the comparison exists at all.
  const base = baseline?.settings ?? DEFAULT_SETTINGS;

  // Nothing to compare against. With a baseline this is a document we published
  // before and the relays have not handed back yet, so this device is still the
  // authority on it; without one, the account has never had settings stored.
  if (!remote) {
    if (!baseline) return { kind: "absent", confirmed: absenceConfirmed };
    const changed = changedKeys(local, base);
    return changed.length === 0
      ? { kind: "in-sync" }
      : { kind: "unsaved", changed };
  }

  const theirs = remote.document.settings;
  if (!remoteIsAhead(remote, baseline)) {
    const changed = changedKeys(local, base);
    return changed.length === 0
      ? { kind: "in-sync" }
      : { kind: "unsaved", changed };
  }

  const contested = contestedKeys({ base, ours: local, theirs });
  if (contested.length > 0) {
    return {
      kind: "conflict",
      contested,
      theirs,
      ours: mergeSettings({ base, ours: local, theirs }),
    };
  }

  const merged = mergeSettings({ base, ours: local, theirs });
  return {
    kind: "adopt",
    settings: merged,
    changed: changedKeys(merged, local),
  };
}

export type SettingsWriteRefusal =
  /** No document found and we are not certain there is none. */
  | "unverified-absence"
  /** The write would not change the document. */
  | "no-change";

export interface SettingsWritePlan {
  readonly document: SettingsDocument;
  readonly changed: readonly SettingKey[];
}

export type SettingsWriteResult =
  | { readonly ok: true; readonly plan: SettingsWritePlan }
  | { readonly ok: false; readonly reason: SettingsWriteRefusal };

/**
 * Build the document to publish.
 *
 * Three protections, in the order they matter:
 *
 *  1. **Refuses to write from an unconfirmed absence.** A first save built while the
 *     account's real document is still in flight replaces settings from another
 *     device *and* every unknown key a newer build put there.
 *  2. **Merges rather than rebuilds.** The body starts from the newest remote
 *     document — its version number and its unknown keys included — and only the
 *     fields this device actually changed are asserted over it.
 *  3. **Keeps the higher version.** An old build saving a new build's document must
 *     not renumber it downwards; the keys it did not understand are still in there
 *     and still mean what the newer build meant.
 */
export function planSettingsWrite({
  local,
  baseline,
  remote,
  absenceConfirmed,
}: SyncInput): SettingsWriteResult {
  if (!remote && !absenceConfirmed) {
    return { ok: false, reason: "unverified-absence" };
  }

  const base = baseline?.settings ?? DEFAULT_SETTINGS;
  const theirs = remote?.document.settings ?? base;
  const settings = mergeSettings({ base, ours: local, theirs });
  const changed = changedKeys(settings, theirs);

  if (remote && changed.length === 0) {
    return { ok: false, reason: "no-change" };
  }

  return {
    ok: true,
    plan: {
      changed,
      document: {
        version: Math.max(remote?.document.version ?? 0, SETTINGS_VERSION),
        settings,
        unknown: remote?.document.unknown ?? {},
      },
    },
  };
}
