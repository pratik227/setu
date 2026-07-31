import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from "@setu/ui";
import { Smile } from "lucide-react";
import { EMOJI_GROUPS } from "./emoji";

/**
 * Emoji picker for the composer.
 *
 * Built on the dropdown rather than a bespoke popover so it inherits the focus
 * trap, the escape handling and the outside-click dismissal that a hand-rolled
 * panel gets wrong. The grid is plain buttons: an emoji is a character, and a
 * character is a button's job.
 *
 * Each button is labelled with the emoji itself and nothing else, which is a
 * deliberate limit rather than an oversight — a screen reader announces the
 * emoji's own Unicode name, which is more accurate than any label written here
 * and is already localised.
 *
 * Opening the menu moves focus into it, which Radix does for every dropdown and
 * which keyboard users need. The caret is unaffected: a textarea keeps its
 * `selectionStart` while unfocused, so the composer reads the caret position at
 * insert time and puts the emoji where it was, not at the end.
 */

export interface EmojiPickerProps {
  onPick(emoji: string): void;
  /**
   * Fired on pointer-down, before the menu opens and takes focus.
   *
   * The composer uses it to snapshot where the caret is. Reading the selection
   * later does not work: opening a modal menu moves focus and re-renders, and
   * React's synthetic `select` event is not a reliable substitute — it does not
   * fire for every way a caret can move. Pointer-down is the last instant at
   * which the textarea is still the focused element, so it is the only moment the
   * answer is certainly right.
   */
  onBeforeOpen?(): void;
  disabled?: boolean;
}

export function EmojiPicker({
  onPick,
  onBeforeOpen,
  disabled,
}: EmojiPickerProps) {
  return (
    <DropdownMenu>
      <Tooltip label="Emoji">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Insert emoji"
            disabled={disabled}
            onPointerDown={() => onBeforeOpen?.()}
            className="text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            <Smile />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        // Capped and scrollable: the grid is longer than any popover should be
        // tall, and a panel that grows past the viewport puts its last group out
        // of reach.
        className="setu-scroll max-h-72 w-72 overflow-y-auto p-2"
      >
        {EMOJI_GROUPS.map((group) => (
          <div key={group.name} className="mb-2 last:mb-0">
            <p className="mb-1 px-1 text-2xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              {group.name}
            </p>
            <div className="grid grid-cols-8 gap-0.5">
              {group.emoji.map((emoji) => (
                <DropdownMenuItem
                  key={emoji}
                  // Real menu items, not bare buttons. A plain `<button>` inside
                  // the menu is not something Radix knows about, so clicking one
                  // neither closed the menu nor counted as a selection — and
                  // because the menu is modal, everything outside it stayed inert.
                  // Picking one emoji left the whole app unresponsive until
                  // Escape. Items also bring arrow-key navigation with them.
                  //
                  // `preventDefault` in `onSelect` keeps the menu open, because
                  // people pick emoji in twos and threes and reopening the picker
                  // between each one is worse than a menu that lingers.
                  onSelect={(event) => {
                    event.preventDefault();
                    onPick(emoji);
                  }}
                  className="size-8 justify-center p-0 text-lg"
                >
                  {emoji}
                </DropdownMenuItem>
              ))}
            </div>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
