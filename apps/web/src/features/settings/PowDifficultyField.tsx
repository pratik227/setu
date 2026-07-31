import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Label,
} from "@setu/ui";
import { ChevronDown } from "lucide-react";
import {
  difficultyChoiceLabel,
  formatDuration,
  MAX_ATTEMPTABLE_DIFFICULTY,
  MAX_MINING_MS,
  POW_CHOICES,
} from "../compose/pow";
import { setDeviceSettings, useDeviceSettings } from "../sync/localSettings";

/**
 * The proof-of-work difficulty (NIP-13), and the honesty it owes the reader.
 *
 * This is the only setting in Setu that costs the user *time* on every use, so the
 * screen says what each option costs before it is chosen rather than after. Three
 * things are stated on purpose:
 *
 *  - **What it buys.** Nothing, for most people. A handful of relays require work
 *    before they accept a write; the rest do not care, and a note is not more
 *    visible for having zeros in its id.
 *  - **Bits, not characters.** The NIP counts leading zero *bits*, and the two
 *    readings differ by a factor of four. Someone comparing this field against a
 *    relay's stated requirement needs to know which unit it is in.
 *  - **That mining is bounded and can fail.** Above about 20 bits, finishing is a
 *    coin flip; the note is published anyway, without the work, and the composer
 *    says so. Promising a difficulty the device cannot reach in a minute would make
 *    the setting a lie the user only discovers when a relay rejects them.
 *
 * A picker rather than a number field: difficulty is exponential, so a free-text
 * box's most likely typo — a stray extra digit — is the difference between a
 * moment and a geological age.
 */
export function PowDifficultyField() {
  const { powDifficulty } = useDeviceSettings();
  // A value from a build that mines more than this one. Kept, not clamped (the
  // document holds it verbatim), so the picker has to be able to show it.
  const unlisted = !POW_CHOICES.includes(powDifficulty);
  const beyondUs = powDifficulty > MAX_ATTEMPTABLE_DIFFICULTY;

  return (
    <div className="space-y-1">
      <Label id="sync-pow-label">Proof of work</Label>
      <div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-labelledby="sync-pow-label"
              className="gap-1"
            >
              {difficultyChoiceLabel(powDifficulty)}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            {POW_CHOICES.map((bits) => (
              <DropdownMenuItem
                key={bits}
                onSelect={() => setDeviceSettings({ powDifficulty: bits })}
                className={bits === powDifficulty ? "font-semibold" : ""}
              >
                {difficultyChoiceLabel(bits)}
              </DropdownMenuItem>
            ))}
            {unlisted ? (
              <DropdownMenuItem className="font-semibold" disabled>
                {difficultyChoiceLabel(powDifficulty)} (set elsewhere)
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {beyondUs ? (
        <p className="text-2xs text-destructive">
          Difficulty {powDifficulty} is more than this device will attempt
          inside {formatDuration(MAX_MINING_MS)}, so notes are published without
          the work. Pick a lower difficulty here to change that everywhere.
        </p>
      ) : (
        <p className="text-2xs text-muted-foreground">
          Leading zero <em>bits</em> mined into the id of everything you publish
          (NIP-13). A few relays require it; most do not, so this is off by
          default — mining spends time on your device before every note, and
          each extra bit doubles it. If mining does not finish within{" "}
          {formatDuration(MAX_MINING_MS)} the note is published without the work
          and the composer says so.
        </p>
      )}
    </div>
  );
}
