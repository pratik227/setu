import type { NostrEvent } from "@setu/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@setu/ui";
import { Composer } from "./Composer";

/**
 * Writing a note, in a modal.
 *
 * This used to be an input permanently parked above the timeline. Two reasons it
 * moved:
 *
 *  - It is the one control on the screen that wants the reader's whole attention,
 *    and it was competing with the feed for it. Parked inline it is a wide empty
 *    box most of the time — visual weight spent on nothing.
 *  - It pushed the first note of the feed below the fold, so the screen opened on
 *    an empty form rather than on content.
 *
 * A reply stays inline in its thread, because a reply's context *is* the thread
 * and lifting it into a modal hides what is being replied to.
 */

export interface ComposeDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onPosted?(event: NostrEvent): void;
}

export function ComposeDialog({
  open,
  onOpenChange,
  onPosted,
}: ComposeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New note</DialogTitle>
          <DialogDescription>
            Published to the relays you write to.
          </DialogDescription>
        </DialogHeader>
        {/* Remounted on each open, so a dismissed draft does not reappear. The
            Composer keeps its own draft state, and reviving an abandoned one is
            how a client posts something the author thought they had thrown
            away. */}
        {open ? (
          <Composer
            autoFocus
            onCancel={() => onOpenChange(false)}
            onPosted={(event) => {
              onPosted?.(event);
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
