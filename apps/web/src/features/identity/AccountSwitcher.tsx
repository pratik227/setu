/**
 * The account switcher, and the place the switch/remove distinction is explained.
 *
 * ## One account is signed in; the rest are saved credentials
 *
 * There is one engine, one relay pool and one store, and all three are keyed to the
 * active pubkey. So this is not a multi-session UI and does not pretend to be: nothing
 * is fetched for an account that is not active, no notification arrives for it, and no
 * private message is received. Switching is genuinely "stop being this account, start
 * being that one" — which is why the menu says *saved on this device* rather than
 * anything that implies parallel activity we cannot deliver.
 *
 * ## Two verbs that must never be confused
 *
 * **Switch** keeps everything: the account's cached timeline, its profile cache, its
 * conversation read marks and its notification watermark all stay, so coming back is
 * instant and nothing is marked unread twice.
 *
 * **Remove** deletes all of it, on purpose, because on a shared computer an account
 * left behind is the previous user's whole timeline and a list of who they messaged
 * sitting under the login screen.
 *
 * They look adjacent in a menu and are opposite in effect, so removal lives behind a
 * separate dialog and an in-row confirmation that names what goes — a switcher whose
 * two neighbouring buttons are "come back later" and "destroy" is a switcher that will
 * eventually destroy something by accident.
 */

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@setu/ui";
import {
  Check,
  ChevronsUpDown,
  Lock,
  LogOut,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { AuthorView } from "../notes/types";
import { fallbackAuthor, useAuthors } from "../profiles/useAuthors";
import { needsPassphrase, type StoredAccount } from "./accounts";
import { useSession } from "./SessionProvider";

/** How this identity signs, in words a user can act on. */
function kindLabel(account: StoredAccount): string {
  switch (account.kind) {
    case "nip07":
      return "browser extension";
    case "encrypted":
      return "encrypted key";
    case "nip46":
      return "remote signer";
    default:
      return "read-only";
  }
}

function AccountFace({
  author,
  className,
}: {
  author: AuthorView;
  className?: string;
}) {
  return (
    <Avatar className={className ?? "size-6 shrink-0"}>
      {author.avatarUrl ? <AvatarImage src={author.avatarUrl} alt="" /> : null}
      <AvatarFallback>
        {author.displayName.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** The footer control: pick another identity, add one, or sign out. */
export function AccountMenu() {
  const { session, accounts, switchAccount, addAccount, signOut } =
    useSession();
  const [managing, setManaging] = useState(false);
  const authors = useAuthors(accounts.map((account) => account.pubkey));

  const others = accounts.filter(
    (account) => account.pubkey !== session?.pubkey,
  );

  return (
    <>
      <DropdownMenu>
        {/* A `title` rather than the shared `Tooltip`: that component's trigger
            takes exactly one child through Radix's Slot, and this component has to
            render the dropdown *and* the manage dialog, so wrapping it hands Slot a
            fragment and props end up cloned onto `React.Fragment`. */}
        <DropdownMenuTrigger asChild>
          <Button
            variant="chrome"
            size="icon-xs"
            aria-label="Accounts"
            title="Accounts"
          >
            <ChevronsUpDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-64">
          <DropdownMenuLabel>Saved on this device</DropdownMenuLabel>
          {accounts.map((account) => {
            const author =
              authors.get(account.pubkey) ?? fallbackAuthor(account.pubkey);
            const active = account.pubkey === session?.pubkey;
            return (
              <DropdownMenuItem
                key={account.pubkey}
                onSelect={() => {
                  if (!active) void switchAccount(account.pubkey);
                }}
              >
                <AccountFace author={author} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{author.displayName}</span>
                  <span className="block truncate text-2xs text-muted-foreground">
                    {kindLabel(account)}
                  </span>
                </span>
                {active ? (
                  <Check className="shrink-0 text-primary" />
                ) : needsPassphrase(account) ? (
                  // Flagged before the click, not after: a locked account lands
                  // read-only and asks for a passphrase, and being told that in
                  // advance is the difference between a step and a surprise.
                  <Lock
                    className="shrink-0 text-muted-foreground"
                    aria-label="needs your passphrase"
                  />
                ) : null}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={addAccount}>
            <UserPlus />
            Add another account
          </DropdownMenuItem>
          {accounts.length > 0 ? (
            <DropdownMenuItem onSelect={() => setManaging(true)}>
              <Users />
              Manage accounts…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={signOut}>
            <LogOut />
            Sign out and erase locally
          </DropdownMenuItem>
          {others.length > 0 ? (
            <p className="px-2 py-1.5 text-2xs text-muted-foreground">
              Signing out erases this account's cached notes from this device.
              Switching keeps them.
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ManageAccountsDialog open={managing} onOpenChange={setManaging} />
    </>
  );
}

/** Where removal happens, because removal deletes data and switching does not. */
function ManageAccountsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(next: boolean): void;
}) {
  const { session, accounts, switchAccount, removeAccount } = useSession();
  const authors = useAuthors(accounts.map((account) => account.pubkey));
  const [confirming, setConfirming] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const remove = useCallback(
    (pubkey: string) => {
      setBusy(true);
      void removeAccount(pubkey).finally(() => {
        setBusy(false);
        setConfirming(undefined);
      });
    },
    [removeAccount],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Accounts on this device</DialogTitle>
          <DialogDescription>
            One account is signed in at a time. Switching leaves the others'
            cached notes and read positions in place; removing an account
            deletes them.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1">
          {accounts.map((account) => {
            const author =
              authors.get(account.pubkey) ?? fallbackAuthor(account.pubkey);
            const active = account.pubkey === session?.pubkey;
            return (
              <li
                key={account.pubkey}
                className="rounded-lg border border-border/60 p-2"
              >
                <div className="flex items-center gap-2">
                  <AccountFace author={author} className="size-7 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {author.displayName}
                    </span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {active ? "signed in · " : ""}
                      {kindLabel(account)}
                    </span>
                  </span>
                  {active ? null : (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() => void switchAccount(account.pubkey)}
                    >
                      Switch
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${author.displayName} from this device`}
                    disabled={busy}
                    onClick={() => setConfirming(account.pubkey)}
                  >
                    <Trash2 />
                  </Button>
                </div>
                {confirming === account.pubkey ? (
                  <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                    <p className="text-2xs text-muted-foreground">
                      Deletes this account's cached notes, profile cache,
                      private-message wraps, conversation read marks and
                      notification position from this device. The account itself
                      is untouched — the relays still hold everything, and you
                      can sign in again.
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setConfirming(undefined)}
                      >
                        Keep it
                      </Button>
                      <Button
                        variant="destructive"
                        size="xs"
                        disabled={busy}
                        onClick={() => remove(account.pubkey)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
