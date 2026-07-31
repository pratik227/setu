import {
  APP_DATA_KIND,
  AppDataError,
  appDataTemplate,
  decryptAppData,
  encryptAppData,
  type NostrEvent,
} from "@setu/protocol";
import { useTheme } from "@setu/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePublish } from "../compose/usePublish";
import { useSession } from "../identity/SessionProvider";
import { useOwnAddressable } from "../settings/settingsShared";
import {
  readBaseline,
  setDeviceSettings,
  useDeviceSettings,
  writeBaseline,
} from "./localSettings";
import {
  parseSettingsDocument,
  SETTINGS_IDENTIFIER,
  type SyncedSettings,
  serializeSettingsDocument,
} from "./settingsDocument";
import {
  decideSync,
  planSettingsWrite,
  type RemoteDocument,
  type SyncBaseline,
  type SyncStatus,
} from "./syncDecision";

/**
 * The sync engine: one account's settings document, read, merged and written.
 *
 * Everything about *what* to write is in `syncDecision.ts`, which is pure. This hook
 * is the moving parts around it — the subscription, the decryption, and the two
 * writes (relay, and local storage) — and it exists to keep those out of the panel.
 *
 * ## Read-only sessions and extensions without NIP-44
 *
 * A read-only session has no key, and a NIP-07 extension that does not implement
 * `nip44` cannot decrypt either. Neither can read the document, and that is a stated
 * limitation rather than an empty screen: `readability` says which of the two it is,
 * and the panel prints it. The alternative — showing "no settings stored" to someone
 * whose settings are stored and merely unreadable — invites them to press Save and
 * overwrite the real document with this device's defaults.
 *
 * ## Nothing here syncs a secret
 *
 * The only thing published is a `SyncedSettings`, which is six scalars. See the
 * header of `settingsDocument.ts` before adding a seventh.
 */

/**
 * How many copies of the document to ask each relay for.
 *
 * Same reasoning as `REPLACEABLE_LIST_LIMIT`: only one can be current, but a relay
 * answering `limit: 1` with a stale copy would strand this device on an old
 * baseline, and being wrong about which document is newest is what makes a write
 * destructive. A handful costs nothing.
 */
const SETTINGS_DOCUMENT_LIMIT = 4;

export type SyncReadability =
  /** Not attempted yet, or no document to read. */
  | { readonly kind: "idle" }
  | { readonly kind: "reading" }
  | { readonly kind: "ok" }
  /** This session cannot decrypt at all — read-only, or no NIP-44 support. */
  | { readonly kind: "unsupported" }
  /** A document exists and this key could not open it. */
  | { readonly kind: "undecryptable" }
  /** Decrypted, but the body was not a versioned settings document. */
  | { readonly kind: "unreadable" };

export interface SettingsSync {
  readonly status: SyncStatus;
  readonly readability: SyncReadability;
  /** The document's timestamp, when we have one. */
  readonly documentAt: number | undefined;
  /** False for a session that cannot sign, so cannot publish. */
  readonly canPublish: boolean;
  readonly publishState: ReturnType<typeof usePublish>["state"];
  readonly busy: boolean;
  readonly error: string | undefined;
  /** Publish this device's settings, merged over the newest document we hold. */
  save(): Promise<void>;
  /** Resolve a conflict by taking the other device's values for every field. */
  useTheirs(): void;
  /** Resolve a conflict by keeping this device's values, ready to be saved. */
  keepOurs(): void;
  dismissError(): void;
}

/**
 * The settings this device is actually rendering, assembled from the two places
 * they live: the theme context and the device store.
 *
 * Exported because the panel displays the same snapshot it would publish. Two
 * separate assemblies of "what this device thinks its settings are" would be two
 * answers to the same question, and the panel would eventually show one while
 * saving the other.
 */
export function useEffectiveSettings(): SyncedSettings {
  const device = useDeviceSettings();
  const { mode, themeId, accentId } = useTheme();
  return useMemo(
    () => ({ ...device, themeMode: mode, themeId, accentId }),
    [device, mode, themeId, accentId],
  );
}

/** The decrypted state of one event id, so a re-render does not re-decrypt. */
interface DecryptedState {
  readonly eventId: string;
  readonly remote: RemoteDocument | undefined;
  readonly readability: SyncReadability;
}

export function useSettingsSync(): SettingsSync {
  const { session } = useSession();
  const pubkey = session?.pubkey;
  const local = useEffectiveSettings();
  const { setAppearance } = useTheme();
  const { publish, state: publishState } = usePublish();
  const [error, setError] = useState<string | undefined>();

  const { event, absenceConfirmed } = useOwnAddressable(
    APP_DATA_KIND,
    SETTINGS_IDENTIFIER,
    SETTINGS_DOCUMENT_LIMIT,
  );

  const [decrypted, setDecrypted] = useState<DecryptedState | undefined>();
  useEffect(() => {
    if (!event || !session) {
      setDecrypted(undefined);
      return;
    }
    if (decrypted?.eventId === event.id) return;
    let cancelled = false;
    void readDocument(event, session.signer).then((next) => {
      if (!cancelled) setDecrypted({ eventId: event.id, ...next });
    });
    return () => {
      cancelled = true;
    };
  }, [event, session, decrypted?.eventId]);

  // Only trust the decrypted copy while it still describes the event we hold; a
  // newer document arriving mid-decryption must not be read through the old body.
  const remote =
    decrypted && event && decrypted.eventId === event.id
      ? decrypted.remote
      : undefined;

  // The baseline is persisted, but it is also read on every comparison, so it is
  // mirrored into state and written through one function. Re-reading storage on each
  // render would work; a second writer would not, which is why `recordBaseline` is
  // the only path.
  const [baseline, setBaseline] = useState<SyncBaseline | undefined>(() =>
    pubkey ? readBaseline(pubkey) : undefined,
  );
  useEffect(() => {
    setBaseline(pubkey ? readBaseline(pubkey) : undefined);
  }, [pubkey]);

  const recordBaseline = useCallback(
    (next: SyncBaseline) => {
      if (!pubkey) return;
      writeBaseline(pubkey, next);
      setBaseline(next);
    },
    [pubkey],
  );

  const status = useMemo(
    () => decideSync({ local, baseline, remote, absenceConfirmed }),
    [local, baseline, remote, absenceConfirmed],
  );

  /** Apply settings to the two stores that hold them, then record the baseline. */
  const apply = useCallback(
    (settings: SyncedSettings, at: RemoteDocument | undefined) => {
      setAppearance({
        mode: settings.themeMode,
        themeId: settings.themeId,
        accentId: settings.accentId,
      });
      setDeviceSettings({
        homeFeed: settings.homeFeed,
        trendingWindowSeconds: settings.trendingWindowSeconds,
        mediaHost: settings.mediaHost,
      });
      if (at) {
        recordBaseline({
          createdAt: at.createdAt,
          eventId: at.eventId,
          settings: at.document.settings,
        });
      }
    },
    [recordBaseline, setAppearance],
  );

  // Adopting is automatic, and only ever when nothing is contested — that is the
  // conflict rule in `syncDecision.ts` and the reason this effect is allowed to run
  // without asking. A conflict falls through to the panel.
  useEffect(() => {
    if (status.kind !== "adopt" || !remote) return;
    apply(status.settings, remote);
  }, [status, remote, apply]);

  const save = useCallback(async () => {
    // A document we hold but could not open must never be overwritten. This is the
    // read-only-session and no-NIP-44 case, and the destructive version of it is
    // subtle: the panel would otherwise offer a save built from this device's
    // defaults, which replaces real settings — including every key a newer build put
    // there — with a document written by someone who could not see the old one.
    if (event && !remote) {
      setError(
        "Setu could not read the settings already stored for this account, so it will not replace them.",
      );
      return;
    }

    const result = planSettingsWrite({
      local,
      baseline,
      remote,
      absenceConfirmed,
    });
    if (!result.ok) {
      setError(
        result.reason === "no-change"
          ? "Nothing has changed."
          : "Setu has not finished checking whether your account already has stored settings. Saving now could replace ones it has not seen yet.",
      );
      return;
    }
    if (!session?.canSign) {
      setError("This session cannot sign, so nothing can be published.");
      return;
    }

    setError(undefined);
    const body = serializeSettingsDocument(result.plan.document);
    let content: string;
    try {
      content = await encryptAppData(session.signer, body);
    } catch (cause) {
      setError(
        cause instanceof AppDataError
          ? cause.message
          : "Setu could not encrypt your settings, so nothing was published.",
      );
      return;
    }

    try {
      const outcome = await publish(
        appDataTemplate({
          identifier: SETTINGS_IDENTIFIER,
          content,
          previous: event,
        }),
      );
      if (!outcome.accepted) return;
      // The baseline records the event we actually published — its `created_at` and
      // `id`, not `Date.now()` — because that is what the next comparison against a
      // remote document has to be commensurate with.
      recordBaseline({
        createdAt: outcome.event.created_at,
        eventId: outcome.event.id,
        settings: result.plan.document.settings,
      });
    } catch {
      // `publish` already reports signing failures through `publishState`; a
      // declined extension prompt is the user saying no, not an error.
    }
  }, [
    local,
    baseline,
    remote,
    absenceConfirmed,
    session,
    publish,
    event,
    recordBaseline,
  ]);

  const useTheirs = useCallback(() => {
    if (!remote) return;
    setError(undefined);
    apply(remote.document.settings, remote);
  }, [remote, apply]);

  const keepOurs = useCallback(() => {
    if (!remote || status.kind !== "conflict") return;
    setError(undefined);
    // Applies the *merge*, not this device's snapshot, and this is the part that is
    // easy to get wrong: their document becomes the merge base, so any field they
    // changed and this device did not would read as a deliberate local change
    // afterwards and the next Save would revert it. Taking their uncontested
    // changes first leaves exactly the contested fields as ours to re-assert.
    apply(status.ours, remote);
  }, [remote, status, apply]);

  // Keyed on the event we hold, not merely on having decrypted something: a newer
  // document arriving must read as "reading" rather than reporting the previous
  // document's verdict about a body we have not opened.
  const readability: SyncReadability = !session
    ? { kind: "idle" }
    : !event
      ? { kind: "idle" }
      : decrypted?.eventId === event.id
        ? decrypted.readability
        : { kind: "reading" };

  return {
    status,
    readability,
    documentAt: remote?.createdAt,
    canPublish: session?.canSign === true,
    publishState,
    busy:
      publishState.status === "signing" || publishState.status === "publishing",
    error,
    save,
    useTheirs,
    keepOurs,
    dismissError: () => setError(undefined),
  };
}

/** Decrypt and parse one document, classifying every way it can fail. */
async function readDocument(
  event: NostrEvent,
  signer: { nip44Decrypt?(peer: string, ciphertext: string): Promise<string> },
): Promise<{
  remote: RemoteDocument | undefined;
  readability: SyncReadability;
}> {
  let body: string;
  try {
    body = await decryptAppData(signer, event);
  } catch (cause) {
    const code = cause instanceof AppDataError ? cause.code : "undecryptable";
    return {
      remote: undefined,
      readability: {
        kind: code === "no-nip44" ? "unsupported" : "undecryptable",
      },
    };
  }

  const document = parseSettingsDocument(body);
  if (!document) {
    // Decrypted but unversioned or not an object. Reported rather than ignored: the
    // panel must not offer a save that would replace a document we could not read.
    return { remote: undefined, readability: { kind: "unreadable" } };
  }
  return {
    remote: {
      createdAt: event.created_at,
      eventId: event.id,
      document,
    },
    readability: { kind: "ok" },
  };
}
