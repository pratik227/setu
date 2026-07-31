import { Kind } from "@setu/protocol";
import {
  ACCENTS,
  Button,
  cn,
  Input,
  Label,
  Panel,
  ScrollArea,
  Spinner,
  THEMES,
  useTheme,
} from "@setu/ui";
import { Check } from "lucide-react";
import { useCallback, useState } from "react";
import { usePublish } from "../compose/usePublish";
import { useSession } from "../identity/SessionProvider";
import { editProfile, type ProfileFields, profileFields } from "./profileEdit";
import { DmRelaySection, RelaySection } from "./RelaySettings";
import { SyncSection } from "./SyncSettings";
import { SaveRow, useOwnReplaceable } from "./settingsShared";

/**
 * Settings.
 *
 * Every section below Appearance publishes an event that *replaces* its predecessor —
 * kind 0, kind 10002, kind 10050, and the kind-30078 settings document — which is the
 * fact that shapes the whole screen. A form that submits what it happens to have
 * loaded deletes everything it did not load. The edit modules (`profileEdit`,
 * `relayListEdit`, `sync/syncDecision`) all refuse to write from an unconfirmed
 * absence; this screen's job is to wait for the fetch and to say what it is waiting
 * for rather than presenting an empty form as if it were the truth.
 *
 * Appearance is first and deliberately unconditional: it is device-local state that
 * works with no account at all. Settings sync (the section below Profile) can carry
 * it to another device, but nothing on this screen depends on that having happened.
 *
 * Relay capabilities are shown because they explain behaviour a reader would
 * otherwise blame on the client. A relay that wants payment answers queries with
 * silence, not an error — so "Payment required" next to a relay is the difference
 * between "this app is broken" and "that door is shut".
 */

export function SettingsScreen() {
  const { session } = useSession();

  return (
    <ScrollArea className="px-4 py-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-12">
        <AppearanceSection />
        {session ? (
          <>
            <ProfileSection />
            <SyncSection />
            <RelaySection />
            <DmRelaySection />
          </>
        ) : (
          <Panel title="Sign in to change your settings">
            <p className="px-4 pb-4 text-xs text-muted-foreground">
              Your profile and relay list live on relays under your public key,
              so there is nothing to load or save until this client has one.
              Appearance and the other preferences above are kept on this device
              and work signed out — signing in only adds the option to carry
              them to another one.
            </p>
          </Panel>
        )}
      </div>
    </ScrollArea>
  );
}

/* -------------------------------------------------------------------------- */
/* Appearance                                                                  */
/* -------------------------------------------------------------------------- */

function AppearanceSection() {
  const { mode, setMode, themeId, setThemeId, accentId, setAccentId } =
    useTheme();

  return (
    <Panel title="Appearance">
      <div className="flex flex-col gap-4 px-4 pb-4">
        <div className="space-y-1.5">
          <Label>Mode</Label>
          <div className="flex flex-wrap gap-2">
            {(["light", "dark", "system"] as const).map((option) => (
              <Button
                key={option}
                variant={mode === option ? "default" : "outline"}
                size="sm"
                onClick={() => setMode(option)}
                className="capitalize"
              >
                {mode === option ? <Check /> : null}
                {option}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Theme</Label>
          <div className="flex flex-wrap gap-2">
            {THEMES.map((option) => (
              <Button
                key={option.id}
                variant={themeId === option.id ? "default" : "outline"}
                size="sm"
                onClick={() => setThemeId(option.id)}
              >
                {themeId === option.id ? <Check /> : null}
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Accent</Label>
          <div className="flex flex-wrap gap-1.5">
            {ACCENTS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setAccentId(option.id)}
                aria-label={option.label}
                aria-pressed={accentId === option.id}
                title={option.label}
                className={cn(
                  "size-7 rounded-md border transition-colors",
                  "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
                  accentId === option.id
                    ? "border-foreground"
                    : "border-border/60",
                )}
                style={
                  option.hex
                    ? { backgroundColor: option.hex }
                    : // "Theme default" has no colour of its own, so it shows the
                      // one it would inherit rather than a blank square.
                      { backgroundColor: "hsl(var(--primary))" }
                }
              />
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared plumbing for the two replaceable writes                              */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

const PROFILE_FIELDS: readonly {
  key: keyof ProfileFields;
  label: string;
  hint?: string;
}[] = [
  { key: "display_name", label: "Display name" },
  { key: "name", label: "Username" },
  { key: "about", label: "About" },
  { key: "picture", label: "Avatar URL" },
  { key: "banner", label: "Banner URL" },
  { key: "website", label: "Website" },
  {
    key: "nip05",
    label: "NIP-05 identifier",
    hint: "Verified against your own domain before any badge is shown.",
  },
  { key: "lud16", label: "Lightning address" },
];

function ProfileSection() {
  const { session } = useSession();
  const { publish, state } = usePublish();
  const { event, absenceConfirmed } = useOwnReplaceable(Kind.Metadata);
  const [draft, setDraft] = useState<ProfileFields | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Seed the form once the profile lands, and never again — re-seeding on every
  // store tick would overwrite what the reader is typing.
  const loaded = profileFields(event);
  const seedKey = event?.id ?? (absenceConfirmed ? "none" : "");
  const [seeded, setSeeded] = useState("");
  if (seedKey !== "" && seedKey !== seeded) {
    setSeeded(seedKey);
    setDraft(loaded);
  }

  const busy = state.status === "signing" || state.status === "publishing";
  const ready = draft !== undefined;

  const save = useCallback(async () => {
    if (!draft) return;
    const result = editProfile({
      current: event,
      absenceConfirmed,
      fields: draft,
    });
    if (!result.ok) {
      setError(
        result.reason === "no-change"
          ? "Nothing has changed."
          : "Setu has not finished checking for your existing profile. Saving now could replace one it has not seen yet.",
      );
      return;
    }
    setError(undefined);
    await publish(result.template);
  }, [draft, event, absenceConfirmed, publish]);

  return (
    <Panel title="Profile">
      <div className="flex flex-col gap-3 px-4 pb-4">
        {!ready ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Spinner size={16} aria-hidden />
            Loading your profile from the relays.
          </div>
        ) : (
          <>
            {PROFILE_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`profile-${field.key}`}>{field.label}</Label>
                <Input
                  id={`profile-${field.key}`}
                  value={draft[field.key] ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, [field.key]: e.target.value })
                  }
                />
                {field.hint ? (
                  <p className="text-2xs text-muted-foreground">{field.hint}</p>
                ) : null}
              </div>
            ))}

            {/* Stated because it is not obvious and it is the whole safety story
                for this form. */}
            <p className="text-2xs text-muted-foreground">
              Fields other clients set that Setu does not show — anything from a
              birthday to a custom field — are preserved when you save.
            </p>

            <SaveRow
              busy={busy}
              error={error}
              state={state}
              onSave={() => void save()}
              onDismiss={() => setError(undefined)}
            />
          </>
        )}
        {!session?.canSign ? (
          <p className="text-xs text-muted-foreground">
            This session cannot sign, so changes cannot be published.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
