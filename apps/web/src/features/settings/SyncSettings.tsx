import {
  Badge,
  Button,
  findAccent,
  findTheme,
  Input,
  Label,
  Panel,
  Spinner,
} from "@setu/ui";
import { CloudOff, RefreshCw, ShieldAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { HOME_FEEDS } from "../feed/homeFeeds";
import { absoluteTime, relativeTime } from "../notes/relativeTime";
import { setDeviceSettings, useDeviceSettings } from "../sync/localSettings";
import { useSettingsSyncContext } from "../sync/SettingsSyncProvider";
import {
  DEFAULT_MEDIA_HOST,
  SETTING_KEYS,
  type SettingKey,
  type SyncedSettings,
} from "../sync/settingsDocument";
import {
  type SettingsSync,
  type SyncReadability,
  useEffectiveSettings,
} from "../sync/useSettingsSync";
import { PowDifficultyField } from "./PowDifficultyField";
import { SaveRow } from "./settingsShared";

/**
 * Settings sync (NIP-78), and the honesty this panel owes the reader.
 *
 * The mechanism is invisible — a kind-30078 document, encrypted to yourself, held by
 * the relays you already use — so everything that could surprise someone is stated
 * on screen rather than left to be discovered:
 *
 *  - **What is included**, field by field, because "your settings" is not a
 *    knowable list and a user deciding whether to publish anything deserves to see
 *    exactly what it is.
 *  - **That it is encrypted, and that encryption is not anonymity.** The relay still
 *    learns that this account saved settings, and when.
 *  - **That some sessions cannot read it.** A read-only session has no key at all;
 *    a NIP-07 extension without `nip44` support cannot decrypt. Saying so beats an
 *    empty panel, and it is the difference between "I have no settings stored" and
 *    "this browser cannot open them" — the second must never invite a save.
 *  - **Conflicts.** When another device changed the same setting, the panel names it
 *    and asks. It does not merge silently and it does not pick a winner.
 */

const SETTING_LABELS: Record<SettingKey, string> = {
  themeMode: "Mode",
  themeId: "Theme",
  accentId: "Accent",
  homeFeed: "Home feed",
  trendingWindowSeconds: "Talked-about window",
  mediaHost: "Media host",
  powDifficulty: "Proof of work",
};

function describeValue(key: SettingKey, settings: SyncedSettings): string {
  switch (key) {
    case "themeMode":
      return settings.themeMode;
    case "themeId":
      return findTheme(settings.themeId).label;
    case "accentId":
      return findAccent(settings.accentId).label;
    case "homeFeed": {
      // This panel lists what the *document* holds, so an id this build does not
      // know is shown as itself. `homeFeedOption` falls back to "Latest", which is
      // the right thing for the picker — Home genuinely shows Latest — but wrong
      // here: it would name a value the account has not stored, next to a Save
      // button that would publish the other one.
      const known = HOME_FEEDS.find((feed) => feed.id === settings.homeFeed);
      return known
        ? known.label
        : `${settings.homeFeed} (set on another device)`;
    }
    case "trendingWindowSeconds": {
      const hours = settings.trendingWindowSeconds / 3600;
      return hours >= 1
        ? `${Math.round(hours)}h`
        : `${Math.round(settings.trendingWindowSeconds / 60)}m`;
    }
    case "mediaHost":
      try {
        return new URL(settings.mediaHost).hostname;
      } catch {
        return settings.mediaHost;
      }
    // "bits" is carried into the summary because the number alone is ambiguous:
    // NIP-13 counts leading zero bits and 20 hex characters would be 80 of them.
    case "powDifficulty":
      return settings.powDifficulty > 0
        ? `${settings.powDifficulty} bits`
        : "off";
  }
}

export function SyncSection() {
  // The app's one sync engine, not a second one. Reading the shared instance is
  // what keeps what this panel shows and what it would publish the same object.
  const sync = useSettingsSyncContext();

  return (
    <Panel title="Settings sync">
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">
          Your client preferences, kept on the relays you already use (NIP-78,
          kind 30078) so a second device starts where this one left off. There
          is no server involved. The document is encrypted to your own key with
          NIP-44, because how you have configured a client is a fingerprint and
          kind 30078 is otherwise public — though a relay can still see{" "}
          <em>that</em> you saved settings, and when.
        </p>

        <StatusLine sync={sync} />
        <SyncedList sync={sync} />
        <MediaHostField />
        <PowDifficultyField />

        <p className="text-2xs text-muted-foreground">
          Never included: your keys, an encrypted key, a remote-signer
          connection or its secret, or anything else that could sign on your
          behalf. A copy of a key on every relay you write to is a compromise
          nothing can recall, so the synced document is a closed list of the
          preferences above and cannot carry one.
        </p>

        <SaveRow
          busy={sync.busy}
          error={sync.error}
          state={sync.publishState}
          onSave={() => void sync.save()}
          onDismiss={sync.dismissError}
        />

        {!sync.canPublish ? (
          <p className="text-xs text-muted-foreground">
            This session cannot sign, so settings can be read from your relays
            but not saved to them. Everything on this device keeps working.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function StatusLine({ sync }: { sync: SettingsSync }) {
  const { status, readability } = sync;

  if (readability.kind === "reading") {
    return (
      <Row>
        <Spinner size={14} aria-hidden />
        Reading the settings stored for this account.
      </Row>
    );
  }

  if (readability.kind !== "ok" && readability.kind !== "idle") {
    return <UnreadableNotice readability={readability} />;
  }

  if (status.kind === "conflict") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs">
        <p>
          Another device changed{" "}
          {status.contested
            .map((key) => SETTING_LABELS[key].toLowerCase())
            .join(", ")}{" "}
          as well as this one. Both changes are real, and one of them has to
          lose — Setu will not decide which.
        </p>
        <ul className="flex flex-col gap-0.5">
          {status.contested.map((key) => (
            <li key={key} className="flex flex-wrap items-baseline gap-1.5">
              <span className="text-muted-foreground">
                {SETTING_LABELS[key]}
              </span>
              <span>this device: {describeValue(key, status.ours)}</span>
              <span className="text-muted-foreground">·</span>
              <span>other device: {describeValue(key, status.theirs)}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={sync.useTheirs}>
            Use the other device's
          </Button>
          <Button size="sm" variant="outline" onClick={sync.keepOurs}>
            Keep this device's
          </Button>
        </div>
        <p className="text-muted-foreground">
          Keeping this device's leaves the change unsaved until you press Save,
          and only the contested settings are overwritten — anything the other
          device changed that this one did not is kept either way.
        </p>
      </div>
    );
  }

  switch (status.kind) {
    case "absent":
      return status.confirmed ? (
        <Row>
          <CloudOff className="size-3.5 shrink-0" aria-hidden />
          Nothing stored for this account yet. Saving publishes the settings
          below.
        </Row>
      ) : (
        <Row>
          <Spinner size={14} aria-hidden />
          Checking your relays for stored settings.
        </Row>
      );
    case "unsaved":
      return (
        <Row>
          <RefreshCw className="size-3.5 shrink-0" aria-hidden />
          Not saved yet:{" "}
          {status.changed
            .map((key) => SETTING_LABELS[key].toLowerCase())
            .join(", ")}
          .
        </Row>
      );
    default:
      return (
        <Row>
          <Badge variant="secondary" className="text-2xs">
            In sync
          </Badge>
          {sync.documentAt !== undefined ? (
            <span title={absoluteTime(sync.documentAt)}>
              Saved {relativeTime(sync.documentAt)} ago.
            </span>
          ) : (
            <span>This device matches the stored settings.</span>
          )}
        </Row>
      );
  }
}

function UnreadableNotice({ readability }: { readability: SyncReadability }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs">
      <p className="flex items-start gap-1.5">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {readability.kind === "unsupported"
            ? "This session cannot decrypt stored settings."
            : readability.kind === "undecryptable"
              ? "This account has stored settings that could not be decrypted with this key."
              : "This account has stored settings that Setu could not read."}
        </span>
      </p>
      <p className="text-muted-foreground">
        {readability.kind === "unsupported"
          ? "A read-only session has no key to decrypt with, and a browser extension without NIP-44 support cannot be asked to. Sign in with a key, or use an extension that implements NIP-44."
          : "Nothing will be overwritten: Setu refuses to replace a document it could not open, because doing so would delete settings — including any a newer version of Setu wrote — on behalf of someone who never saw them."}
      </p>
      <p className="text-muted-foreground">
        The settings on this device are unaffected and keep working.
      </p>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function SyncedList({ sync }: { sync: SettingsSync }) {
  const local = useEffectiveSettings();
  const changed = new Set(
    sync.status.kind === "unsaved"
      ? sync.status.changed
      : sync.status.kind === "conflict"
        ? sync.status.contested
        : [],
  );

  return (
    <ul className="flex flex-col gap-1 rounded-lg border border-border/60 px-3 py-2">
      {SETTING_KEYS.map((key) => (
        <li key={key} className="flex items-baseline gap-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {SETTING_LABELS[key]}
          </span>
          <span className={changed.has(key) ? "font-semibold" : undefined}>
            {describeValue(key, local)}
          </span>
        </li>
      ))}
      {/* Said explicitly because this panel deliberately does not duplicate the
          controls: appearance is changed above, the feed and window where they are
          used, and the last two here. A second copy of a control is a second thing
          to disagree with the first. */}
      <li className="pt-1 text-2xs text-muted-foreground">
        Appearance is set above, the home feed from the picker on Home, and the
        window from the picker in Discover. The media host and proof of work are
        set below. This panel publishes whatever they currently are.
      </li>
    </ul>
  );
}

/**
 * One of the two settings this panel owns (the other is `PowDifficultyField`).
 *
 * Applied on blur rather than per keystroke: every intermediate value of a URL
 * being typed is a different host, and a partially typed one is where the next
 * upload would have gone.
 */
function MediaHostField() {
  const { mediaHost } = useDeviceSettings();
  const [draft, setDraft] = useState(mediaHost);
  const [invalid, setInvalid] = useState(false);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(DEFAULT_MEDIA_HOST);
      setInvalid(false);
      setDeviceSettings({ mediaHost: DEFAULT_MEDIA_HOST });
      return;
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      setInvalid(true);
      return;
    }
    // https only. A NIP-98 upload sends a signed event as an authorization header,
    // and sending that over http hands it to anyone on the path.
    if (url.protocol !== "https:") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDeviceSettings({ mediaHost: url.origin });
    setDraft(url.origin);
  };

  return (
    <div className="space-y-1">
      <Label htmlFor="sync-media-host">Media host</Label>
      <Input
        id="sync-media-host"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        placeholder={DEFAULT_MEDIA_HOST}
      />
      {invalid ? (
        <p className="text-2xs text-destructive">
          That is not an https URL. Uploads authenticate with a signed event
          (NIP-98), and sending one over http hands it to whoever is in between.
        </p>
      ) : (
        <p className="text-2xs text-muted-foreground">
          Where attachments are uploaded. Uploading is a choice to trust a third
          party with your file and a signature, so it is worth knowing which
          one.
        </p>
      )}
    </div>
  );
}
