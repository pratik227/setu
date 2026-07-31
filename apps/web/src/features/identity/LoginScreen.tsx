import { encodeNpub, truncateNpub } from "@setu/protocol";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@setu/ui";
import {
  Eye,
  KeyRound,
  Lock,
  Puzzle,
  Radio,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { useCallback, useState } from "react";
import { needsPassphrase } from "./accounts";
import { AuthShell, Field } from "./authLayout";
import { BunkerSignIn } from "./BunkerSignIn";
import { useSession } from "./SessionProvider";

type Mode =
  | "choose"
  | "extension"
  | "key"
  | "create"
  | "readonly"
  | "bunker"
  | "backup";

function Choice({
  icon,
  title,
  description,
  onClick,
  disabled,
  recommended,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick(): void;
  disabled?: boolean;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border border-border/60 p-3 text-left",
        "transition-colors hover:bg-muted/60 disabled:opacity-50 disabled:hover:bg-transparent",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "[&_svg]:size-4 [&_svg]:shrink-0",
      )}
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {title}
          {recommended ? (
            <span className="text-2xs font-semibold tracking-[0.12em] text-primary uppercase">
              safest
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

/**
 * What the last sign-out could not remove from this device.
 *
 * Rendered here because this is where the person who needs it is looking. The
 * cleanup outcome was reported by `SessionProvider` and displayed nowhere, which
 * meant the one case worth telling a user about — "you signed out, and your notes,
 * profile cache and private-message wraps are still on this computer" — was silently
 * discarded. On a shared machine that is the difference between having handed the
 * browser back safely and not.
 *
 * Only the `left-behind` case renders. A successful cleanup is what the user asked
 * for and needs no receipt; announcing it would train them to ignore the box that
 * matters.
 */
function LeftBehindNotice() {
  const { lastSignOut } = useSession();
  if (lastSignOut?.status !== "left-behind") return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium">Some data stayed on this device</p>
        <p className="text-2xs text-muted-foreground">{lastSignOut.reason}</p>
        <p className="text-2xs text-muted-foreground">
          Closing every other Setu tab and signing out again usually finishes
          the job. On a shared computer, clearing this site's data in your
          browser settings removes it for certain.
        </p>
      </div>
    </div>
  );
}

/**
 * Identities this device already knows, offered as a way straight back in.
 *
 * Two jobs. It is the escape hatch from "Add another account" — that step clears the
 * active session so this screen can appear, and without a way back a user who changed
 * their mind would have to set an identity up again. And on a cold start it is how a
 * second account is reached at all, since only one session is restored.
 *
 * Deliberately no avatars or display names. With nobody signed in the store is
 * in-memory (see `EngineProvider`), so there is no profile cache to read and fetching
 * one would mean opening relay subscriptions from the login screen to render a
 * decoration. An npub is honest and needs no network.
 */
function RememberedAccounts() {
  const { accounts, switchAccount } = useSession();
  if (accounts.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-2xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        Continue as
      </p>
      {accounts.map((account) => {
        const npub = encodeNpub(account.pubkey);
        return (
          <Choice
            key={account.pubkey}
            icon={needsPassphrase(account) ? <Lock /> : <UserRound />}
            title={npub ? truncateNpub(npub, 10) : account.pubkey.slice(0, 16)}
            description={
              needsPassphrase(account)
                ? "Saved here. Setu will ask for your passphrase before it can sign."
                : "Saved on this device."
            }
            onClick={() => void switchAccount(account.pubkey)}
          />
        );
      })}
    </div>
  );
}

export function LoginScreen() {
  const {
    nip07Available,
    signInWithExtension,
    signInWithSecretKey,
    createIdentity,
    signInReadonly,
  } = useSession();

  const [mode, setMode] = useState<Mode>("choose");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [npub, setNpub] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [newNsec, setNewNsec] = useState<string | undefined>();

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "that did not work");
    } finally {
      setBusy(false);
    }
  }, []);

  if (mode === "backup" && newNsec) {
    return (
      <AuthShell title="Save your key">
        <p className="text-xs text-muted-foreground">
          This is the only time Setu can show you this key. It is encrypted with
          your passphrase on this device — without both, nobody (including you)
          can recover the account. Store it in a password manager now.
        </p>
        <code className="block overflow-x-auto rounded-lg border border-border bg-muted/60 p-3 font-mono text-xs break-all">
          {newNsec}
        </code>
        <Button
          className="w-full"
          onClick={() => {
            void navigator.clipboard?.writeText(newNsec).catch(() => {});
          }}
        >
          Copy key
        </Button>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            setNewNsec(undefined);
            setMode("choose");
          }}
        >
          I have saved it
        </Button>
      </AuthShell>
    );
  }

  if (mode === "bunker") {
    return <BunkerSignIn onBack={() => setMode("choose")} />;
  }

  if (mode === "choose") {
    return (
      <AuthShell title="Sign in to Setu">
        <LeftBehindNotice />
        <RememberedAccounts />
        <div className="space-y-2">
          <Choice
            icon={<Puzzle />}
            title="Browser extension"
            description={
              nip07Available
                ? "Your key stays in the extension. Setu never sees it."
                : "No NIP-07 extension detected in this browser."
            }
            recommended
            disabled={!nip07Available || busy}
            onClick={() => void run(signInWithExtension)}
          />
          <Choice
            icon={<Radio />}
            title="Remote signer"
            description="Your key stays in a NIP-46 signer on another device."
            recommended
            disabled={busy}
            onClick={() => setMode("bunker")}
          />
          <Choice
            icon={<KeyRound />}
            title="Paste a private key"
            description="Encrypted with a passphrase before it is stored."
            disabled={busy}
            onClick={() => setMode("key")}
          />
          <Choice
            icon={<Sparkles />}
            title="Create a new identity"
            description="Generates a keypair on this device."
            disabled={busy}
            onClick={() => setMode("create")}
          />
          <Choice
            icon={<Eye />}
            title="Browse read-only"
            description="Follow a public key without signing anything."
            disabled={busy}
            onClick={() => setMode("readonly")}
          />
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </AuthShell>
    );
  }

  if (mode === "key") {
    return (
      <AuthShell title="Paste a private key" onBack={() => setMode("choose")}>
        <Field
          label="Private key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="nsec1… or 64-char hex"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <Field
          label="Passphrase"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          hint="Encrypts the key on this device. Setu will ask for it after a reload — a session that unlocks itself is a session whose key is recoverable."
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button
          className="w-full"
          disabled={busy || !secret || passphrase.length < 8}
          onClick={() =>
            void run(() => signInWithSecretKey(secret, passphrase))
          }
        >
          <ShieldCheck />
          Encrypt and sign in
        </Button>
      </AuthShell>
    );
  }

  if (mode === "create") {
    return (
      <AuthShell title="Create a new identity" onBack={() => setMode("choose")}>
        <Field
          label="Passphrase"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          hint="Your new key is encrypted with this. There is no reset."
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button
          className="w-full"
          disabled={busy || passphrase.length < 8}
          onClick={() =>
            void run(async () => {
              const { nsec } = await createIdentity(passphrase);
              setNewNsec(nsec);
              setMode("backup");
            })
          }
        >
          <Sparkles />
          Generate keypair
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Browse read-only" onBack={() => setMode("choose")}>
      <Field
        label="Public key"
        autoComplete="off"
        spellCheck={false}
        placeholder="npub1… or 64-char hex"
        hint="You will be able to read everything and post nothing."
        value={npub}
        onChange={(e) => setNpub(e.target.value)}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button
        className="w-full"
        disabled={busy || !npub}
        onClick={() => void run(() => signInReadonly(npub))}
      >
        <Eye />
        Start browsing
      </Button>
    </AuthShell>
  );
}

/**
 * Unlock a stored identity, in a centred dialog.
 *
 * This was a thin strip above the timeline, and it did not work: it sat in the
 * scrolling content column, so it scrolled away, and at feed width it read as one
 * more row rather than the one thing standing between the reader and posting.
 * People did not see it.
 *
 * A dialog, but a **dismissible** one. Reading does not need the key — the
 * session browses fine while locked — so trapping someone in a passphrase prompt
 * to read their own timeline would be worse than the strip was. Dismiss and carry
 * on reading; the way back in is the compose button, which is where the intent to
 * post actually starts.
 *
 * Three locked states, not one, because the remedies are different: an extension
 * that is not answering, an encrypted key that needs its passphrase, and a remote
 * signer whose connection key needs the same passphrase *and* whose signer has to be
 * awake. The last one is why a failure here is not always "wrong passphrase" — see
 * `submit`.
 */
export interface UnlockDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function UnlockDialog({ open, onOpenChange }: UnlockDialogProps) {
  const { locked, unlock, signOut } = useSession();
  const [passphrase, setPassphrase] = useState("");
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  if (!locked) return null;

  const isExtension = locked.kind === "nip07";
  const isRemote = locked.kind === "nip46";

  /*
   * `false` means the passphrase was wrong. A thrown error means something else was.
   *
   * Kept separate deliberately. For a remote signer the common failure is a bunker
   * that is offline or has revoked this connection, and reporting that as "that
   * passphrase did not work" sends the user to retype a passphrase that was correct,
   * over and over, while the actual problem is on their phone.
   */
  const submit = () => {
    setBusy(true);
    setProblem(undefined);
    void unlock(passphrase)
      .then((ok) => {
        setFailed(!ok);
        // Close on success only. Closing on failure would hide the error along
        // with the field that produced it.
        if (ok) {
          setPassphrase("");
          onOpenChange(false);
        }
      })
      .catch((cause: unknown) => {
        setFailed(false);
        setProblem(
          cause instanceof Error ? cause.message : "that did not work",
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {isExtension
              ? "Extension not responding"
              : isRemote
                ? "Reconnect your signer"
                : "Unlock to post"}
          </DialogTitle>
          <DialogDescription>
            {isExtension
              ? "Reading works without it. Signing a note needs your extension to answer."
              : isRemote
                ? "Setu keeps this connection encrypted on this device, so it asks for your passphrase and then checks that your signer is awake."
                : "Your key is stored encrypted on this device. Setu needs the passphrase to sign, and never to read."}
          </DialogDescription>
        </DialogHeader>

        {isExtension ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs">
              <Puzzle className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">
                Check that the extension is enabled for this site and set to
                this account, then try again.
              </span>
            </div>
            {problem ? (
              <p className="text-xs text-destructive">{problem}</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="unlock-passphrase">Passphrase</Label>
            <Input
              // Autofocused: the dialog exists to receive this one value.
              autoFocus
              type="password"
              autoComplete="current-password"
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setFailed(false);
                setProblem(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && passphrase && !busy) submit();
              }}
              id="unlock-passphrase"
              aria-invalid={failed || undefined}
              aria-describedby={failed || problem ? "unlock-error" : undefined}
              className={failed ? "border-destructive" : undefined}
            />
            {failed ? (
              <p id="unlock-error" className="text-xs text-destructive">
                That passphrase did not work.
              </p>
            ) : problem ? (
              <p id="unlock-error" className="text-xs text-destructive">
                {problem}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={signOut}>
            Sign out
          </Button>
          {isExtension ? (
            // Through `submit` rather than calling `unlock` directly, so the "your
            // extension is set to a different account" refusal is displayed instead
            // of becoming an unhandled rejection and a button that does nothing.
            <Button disabled={busy} onClick={submit}>
              Try again
            </Button>
          ) : (
            <Button disabled={busy || !passphrase} onClick={submit}>
              {busy
                ? isRemote
                  ? "Reconnecting…"
                  : "Unlocking…"
                : isRemote
                  ? "Reconnect"
                  : "Unlock"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
