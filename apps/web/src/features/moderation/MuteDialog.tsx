import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@setu/ui";
import { type MuteTarget, muteRulesInclude } from "./muteList";
import { useMuteAction, useMuteRules } from "./useMuteList";

/**
 * Confirming a mute, and saying plainly what it does.
 *
 * A confirmation step for something reversible looks like friction, and it is here
 * for one reason: this is the only moment the reader is looking at the word "mute",
 * so it is the only moment they can be told what it is not. Every one of the three
 * sentences below is a belief people actually hold about muting on Nostr and none of
 * them is true:
 *
 *  - that it stops the other person seeing them (it does not — a mute list is a
 *    reading preference, and the muted account's relays, notes and replies are
 *    unaffected);
 *  - that it is private (it is not — the list is published to the reader's own
 *    relays as an ordinary unencrypted event, and Setu writes only that public half);
 *  - that it removes them from the network's counts (it does not — see the note on
 *    counts, which is the one part of this feature that stops at the row).
 *
 * Getting that wrong is not a cosmetic failure. Someone who mutes an account
 * believing it cannot reach them any more has made a safety decision on a false
 * premise, which is worse than not having the feature.
 */

export interface MuteDialogProps {
  /** What is being muted. Only `pubkey` targets are offered from a note row. */
  target: MuteTarget;
  /** How to name the target to the reader. */
  name: string;
  onClose(): void;
}

export function MuteDialog({ target, name, onClose }: MuteDialogProps) {
  const { rules, hasPrivateEntries } = useMuteRules();
  const { state, apply } = useMuteAction();
  const muted = muteRulesInclude(rules, target);
  const working = state.status === "working";

  const confirm = () => {
    void (async () => {
      const ok = await apply(target, muted ? "unmute" : "mute");
      // Left open on failure: the error is the only place the reason lives, and a
      // dialog that closes on a refused write reads as a mute that worked.
      if (ok) onClose();
    })();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {muted ? "Unmute" : "Mute"} {name}?
          </DialogTitle>
          <DialogDescription>
            {muted
              ? "Their notes, replies and reposts can appear in your feeds again."
              : "Setu stops showing you their notes, replies and reposts on this account."}
          </DialogDescription>
        </DialogHeader>

        <ul className="grid gap-2 text-xs text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">
              This is not a block.
            </span>{" "}
            {name} can still read your notes, reply to them and reach the same
            relays you use. Muting changes what this app shows you, nothing
            else.
          </li>
          <li>
            Your mute list is published to your relays as an ordinary,
            unencrypted event, so who you have muted is readable by anyone.
          </li>
          <li>
            Reply and reaction counts on notes you can still see include muted
            accounts. Setu hides their notes, not their arithmetic.
          </li>
          {hasPrivateEntries ? (
            <li>
              This list also holds private entries Setu cannot read. They are
              copied through untouched by this edit.
            </li>
          ) : null}
        </ul>

        {state.status === "error" ? (
          <p className="text-xs text-destructive">{state.message}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button
            variant={muted ? "default" : "destructive"}
            onClick={confirm}
            disabled={working}
          >
            {working ? (
              <Spinner aria-hidden className="size-4 border-2" />
            ) : null}
            {muted ? "Unmute" : "Mute"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
