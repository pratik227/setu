/**
 * Signing in with a remote signer (NIP-46), in both directions.
 *
 * `bunker://` — the signer made a URI and the user pastes it here.
 * `nostrconnect://` — Setu makes one and the user shows it to their signer.
 *
 * ## Why a passphrase is asked for either way
 *
 * A NIP-46 connection is authorised under a *client key* Setu generates, and whoever
 * holds that key can ask the bunker to sign as the account. It is therefore stored the
 * same way a pasted `nsec` is: encrypted with a passphrase, so a reload asks for the
 * passphrase rather than restoring signing ability from disk. The alternative —
 * keeping the client key in the clear so the session resumes silently — would put a
 * standing signing capability in `localStorage`, which is the one thing
 * `identity/storage.ts` exists to refuse.
 *
 * ## The URI is masked
 *
 * A `bunker://` URI carries a `secret=` parameter that grants signing. It is typed
 * into a password field for the same reason the `nsec` field is one, and the parse
 * preview below it shows the signer key and the relay count so the user can still
 * confirm they pasted the right thing.
 */

import { Button, cn } from "@setu/ui";
import { Link2, QrCode, Radio } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthShell, Field } from "./authLayout";
import { DEFAULT_INVITE_RELAYS } from "./remoteSigner";
import { type RemoteInviteHandle, useSession } from "./SessionProvider";

type Step = "choose" | "paste" | "invite";

/** What a pasted URI parses to, with nothing secret in it. */
function useUriPreview(uri: string): string | undefined {
  const [preview, setPreview] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    if (uri.trim() === "") {
      setPreview(undefined);
      return;
    }
    // Imported lazily so the login screen does not pull the parser in for the
    // majority of users who never open this surface.
    void import("@setu/protocol").then(({ parseBunkerUri }) => {
      if (cancelled) return;
      const parsed = parseBunkerUri(uri);
      setPreview(
        parsed
          ? `Signer ${parsed.remoteSignerPubkey.slice(0, 12)}… over ${
              parsed.relays.length
            } relay${parsed.relays.length === 1 ? "" : "s"}`
          : "Not a usable bunker:// URI yet.",
      );
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);
  return preview;
}

export function BunkerSignIn({ onBack }: { onBack(): void }) {
  const { signInWithBunker, beginRemoteInvite } = useSession();
  const [step, setStep] = useState<Step>("choose");
  const [uri, setUri] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [relayInput, setRelayInput] = useState(
    DEFAULT_INVITE_RELAYS.join(", "),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [invite, setInvite] = useState<RemoteInviteHandle | undefined>();
  const preview = useUriPreview(uri);

  /*
   * The outstanding invitation, cancelled on unmount.
   *
   * Held in a ref as well as in state because the cleanup runs after the last
   * render: reading it from state would cancel whatever the *previous* render saw,
   * which for a fast create-then-navigate is nothing, leaving relay sockets and a
   * subscription open for the life of the tab.
   */
  const inviteRef = useRef<RemoteInviteHandle | undefined>(undefined);
  inviteRef.current = invite;
  useEffect(
    () => () => {
      inviteRef.current?.cancel();
    },
    [],
  );

  const paste = useCallback(() => {
    setBusy(true);
    setError(undefined);
    void signInWithBunker(uri, passphrase)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "that did not work");
      })
      .finally(() => setBusy(false));
  }, [signInWithBunker, uri, passphrase]);

  const createInvite = useCallback(() => {
    setError(undefined);
    const relays = relayInput
      .split(/[,\s]+/)
      .map((relay) => relay.trim())
      .filter((relay) => relay.length > 0);
    if (relays.length === 0) {
      setError("name at least one relay your signer can reach");
      return;
    }
    let handle: RemoteInviteHandle;
    try {
      handle = beginRemoteInvite(passphrase, relays);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "that did not work");
      return;
    }
    setInvite(handle);
    handle.completed.catch((cause: unknown) => {
      setInvite(undefined);
      setError(cause instanceof Error ? cause.message : "no signer answered");
    });
  }, [beginRemoteInvite, passphrase, relayInput]);

  if (step === "choose") {
    return (
      <AuthShell title="Use a remote signer" onBack={onBack}>
        <p className="text-xs text-muted-foreground">
          Your key stays in the signer. Setu asks it to sign and never sees the
          key — the same trade as a browser extension, over relays instead of a
          page API.
        </p>
        <Option
          icon={<Link2 />}
          title="Paste a bunker link"
          description="Your signer showed you a bunker:// URI."
          onClick={() => setStep("paste")}
        />
        <Option
          icon={<QrCode />}
          title="Let your signer scan Setu"
          description="Setu creates a nostrconnect:// link for it to pick up."
          onClick={() => setStep("invite")}
        />
      </AuthShell>
    );
  }

  if (step === "paste") {
    return (
      <AuthShell title="Paste a bunker link" onBack={() => setStep("choose")}>
        <Field
          label="Bunker URI"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="bunker://…"
          hint="Masked because it carries a connection secret that grants signing."
          value={uri}
          onChange={(e) => setUri(e.target.value)}
        />
        {preview ? (
          <p className="text-2xs text-muted-foreground">{preview}</p>
        ) : null}
        <Field
          label="Passphrase"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          hint="Encrypts this connection on this device. Setu will ask for it after a reload rather than keeping a standing ability to sign."
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button
          className="w-full"
          disabled={busy || !uri || passphrase.length < 8}
          onClick={paste}
        >
          <Radio />
          {busy ? "Waiting for your signer…" : "Connect"}
        </Button>
        {busy ? (
          <p className="text-2xs text-muted-foreground">
            Your signer may be asking you to approve this. Setu stops waiting
            after a minute and a half rather than spinning indefinitely.
          </p>
        ) : null}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Let your signer find Setu"
      onBack={() => {
        invite?.cancel();
        setInvite(undefined);
        setStep("choose");
      }}
    >
      {invite ? (
        <>
          <p className="text-xs text-muted-foreground">
            Open this in your signer. Setu is listening on the relays below and
            will connect as soon as it answers.
          </p>
          <code className="block max-h-32 overflow-auto rounded-lg border border-border bg-muted/60 p-3 font-mono text-xs break-all">
            {invite.uri}
          </code>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              void navigator.clipboard?.writeText(invite.uri).catch(() => {});
            }}
          >
            Copy link
          </Button>
          <p className="text-2xs text-muted-foreground">
            Waiting for a signer to answer. The link contains a one-time secret,
            so treat it like a password and do not paste it anywhere else.
          </p>
        </>
      ) : (
        <>
          <Field
            label="Passphrase"
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            hint="Encrypts this connection on this device."
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <Field
            label="Relays"
            autoComplete="off"
            spellCheck={false}
            placeholder="wss://…, wss://…"
            hint="Both ends must use the same relay, and your signer is the end Setu cannot configure — so these are editable."
            value={relayInput}
            onChange={(e) => setRelayInput(e.target.value)}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button
            className="w-full"
            disabled={passphrase.length < 8}
            onClick={createInvite}
          >
            <QrCode />
            Create a connection link
          </Button>
        </>
      )}
      {invite && error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
    </AuthShell>
  );
}

function Option({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border border-border/60 p-3 text-left",
        "transition-colors hover:bg-muted/60",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "[&_svg]:size-4 [&_svg]:shrink-0",
      )}
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}
