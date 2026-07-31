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
import { Eye, KeyRound, Puzzle, ShieldCheck, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { useSession } from "./SessionProvider";

type Mode = "choose" | "extension" | "key" | "create" | "readonly" | "backup";

function Field({
  label,
  hint,
  id,
  ...props
}: React.ComponentProps<"input"> & { label: string; hint?: string }) {
  // A generated id rather than nesting the input inside the label: a `hint`
  // sitting inside the label element would be read out as part of the label.
  const fieldId = id ?? `field-${label.toLowerCase().replace(/\s+/g, "-")}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  return (
    <div className="space-y-1">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input id={fieldId} aria-describedby={hintId} {...props} />
      {hint ? (
        <p id={hintId} className="text-2xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

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
      <Shell title="Save your key">
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
      </Shell>
    );
  }

  if (mode === "choose") {
    return (
      <Shell title="Sign in to Setu">
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
      </Shell>
    );
  }

  if (mode === "key") {
    return (
      <Shell title="Paste a private key" onBack={() => setMode("choose")}>
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
      </Shell>
    );
  }

  if (mode === "create") {
    return (
      <Shell title="Create a new identity" onBack={() => setMode("choose")}>
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
      </Shell>
    );
  }

  return (
    <Shell title="Browse read-only" onBack={() => setMode("choose")}>
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
    </Shell>
  );
}

function Shell({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack?(): void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Setu verifies every event locally. Nothing is trusted because a
            server said so.
          </p>
        </div>
        {children}
        {onBack ? (
          <Button variant="ghost" size="sm" className="w-full" onClick={onBack}>
            Back
          </Button>
        ) : null}
      </div>
    </div>
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
 */
export interface UnlockDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function UnlockDialog({ open, onOpenChange }: UnlockDialogProps) {
  const { locked, unlock, signOut } = useSession();
  const [passphrase, setPassphrase] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!locked) return null;

  const isExtension = locked.kind === "nip07";

  const submit = () => {
    setBusy(true);
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
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {isExtension ? "Extension not responding" : "Unlock to post"}
          </DialogTitle>
          <DialogDescription>
            {isExtension
              ? "Reading works without it. Signing a note needs your extension to answer."
              : "Your key is stored encrypted on this device. Setu needs the passphrase to sign, and never to read."}
          </DialogDescription>
        </DialogHeader>

        {isExtension ? (
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs">
            <Puzzle className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">
              Check that the extension is enabled for this site, then try again.
            </span>
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
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && passphrase && !busy) submit();
              }}
              id="unlock-passphrase"
              aria-invalid={failed || undefined}
              aria-describedby={failed ? "unlock-error" : undefined}
              className={failed ? "border-destructive" : undefined}
            />
            {failed ? (
              <p id="unlock-error" className="text-xs text-destructive">
                That passphrase did not work.
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={signOut}>
            Sign out
          </Button>
          {isExtension ? (
            <Button disabled={busy} onClick={() => void unlock("")}>
              Try again
            </Button>
          ) : (
            <Button disabled={busy || !passphrase} onClick={submit}>
              {busy ? "Unlocking…" : "Unlock"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
