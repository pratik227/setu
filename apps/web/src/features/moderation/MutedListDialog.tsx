import type { MuteRules } from "@setu/core";
import { encodeNpub, truncateNpub } from "@setu/protocol";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
} from "@setu/ui";
import { Hash, Type, VolumeX } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useSession } from "../identity/SessionProvider";
import type { AuthorView } from "../notes/types";
import { useAuthors } from "../profiles/useAuthors";
import {
  checkMuteDraft,
  groupMuteEntries,
  type MuteSection,
  mutedListSummary,
} from "./mutedListModel";
import type { MuteTarget } from "./muteList";
import { useMuteAction, useMuteRules } from "./useMuteList";

/**
 * Everything the reader has muted, with a way out of each of it.
 *
 * ## Why this screen has to exist
 *
 * A mute list is the only preference in the app that is invisible by construction:
 * every other setting shows you its current value, but the effect of a mute is a
 * *note that is not there*. Without a list of the rules, three of the four NIP-51
 * entry kinds were unreachable — a word mute added months ago could be quietly
 * hiding people the reader wants to read, and there was no surface in the app that
 * could even name it, let alone remove it. "The feed looks broken" is the shape that
 * failure arrives in, and the reader has no way to connect it to a rule.
 *
 * So the unmute affordance is the point of this dialog, and adding words and
 * hashtags is secondary: a rule you cannot see is worse than a rule you cannot add.
 *
 * ## Why account names are resolved and hashtags are not
 *
 * A `p` entry is 64 hex characters. Listing those is technically complete and
 * practically useless — nobody recognises their own mutes as npubs — so kind-0s are
 * fetched for them and the row shows a name with the truncated key beside it. The
 * key stays visible because two accounts may share a display name, and unmuting the
 * wrong one of them is not recoverable from this dialog.
 *
 * Rows for threads show the event id and nothing else. Resolving a thread's root
 * note would mean a second live query for a list the reader opens rarely, and the
 * honest label is available without one.
 */

export interface MutedListDialogProps {
  onClose(): void;
}

/** Stable per-entry key, matching the dedupe key `publicMuteEntries` uses. */
function entryKey(target: MuteTarget): string {
  return `${target.kind}:${target.value}`;
}

export function MutedListDialog({ onClose }: MutedListDialogProps) {
  const { rules, entries, loaded, hasPrivateEntries } = useMuteRules();
  const { state, apply } = useMuteAction();
  const { session } = useSession();
  // Every edit here publishes a replacement kind-10000, so a read-only session can
  // read the list and change nothing. Stated on the controls rather than discovered
  // by pressing one and reading an error.
  const canSign = Boolean(session?.canSign);
  /*
   * Which row is mid-write, tracked here rather than read off `state`.
   *
   * `useMuteAction` holds one status for the whole dialog, so "working" alone
   * cannot say *which* unmute is in flight. Without this every row would spin at
   * once, which reads as the whole list being removed.
   */
  const [pending, setPending] = useState<string | undefined>();

  const mutedPubkeys = useMemo(
    () =>
      entries
        .filter((entry) => entry.kind === "pubkey")
        .map((entry) => entry.value),
    [entries],
  );
  const authors = useAuthors(mutedPubkeys);

  const sections = useMemo(() => groupMuteEntries(entries), [entries]);
  const total = entries.length;

  const unmute = (target: MuteTarget) => {
    const key = entryKey(target);
    setPending(key);
    void (async () => {
      await apply(target, "unmute");
      // Cleared whatever the outcome: on failure the message below the list is
      // what says so, and a row left spinning forever says nothing at all.
      setPending((current) => (current === key ? undefined : current));
    })();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>Muted</DialogTitle>
          <DialogDescription>
            {mutedListSummary({ entries, loaded, hasPrivateEntries })}
          </DialogDescription>
        </DialogHeader>

        <div className="setu-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <AddMuteForm
            onAdd={(target) => {
              const key = entryKey(target);
              setPending(key);
              void (async () => {
                await apply(target, "mute");
                setPending((current) =>
                  current === key ? undefined : current,
                );
              })();
            }}
            busy={state.status === "working"}
            rules={rules}
            canSign={canSign}
          />

          {/* Before the list has arrived there is nothing honest to show. An empty
              list here would read as "you have muted nobody", which is the one
              claim this dialog must not make on a guess. */}
          {loaded && total === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              Nothing is muted. Muting somebody from a note or a profile adds
              them here.
            </p>
          ) : null}

          {sections.map((section) =>
            section.targets.length === 0 ? null : (
              <MuteSectionBlock
                key={section.kind}
                section={section}
                authors={authors}
                pending={pending}
                canSign={canSign}
                onUnmute={unmute}
              />
            ),
          )}
        </div>

        {state.status === "error" ? (
          <p className="text-xs text-destructive">{state.message}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MuteSectionBlock({
  section,
  authors,
  pending,
  canSign,
  onUnmute,
}: {
  section: MuteSection;
  authors: ReadonlyMap<string, AuthorView>;
  pending: string | undefined;
  canSign: boolean;
  onUnmute(target: MuteTarget): void;
}) {
  return (
    <section className="mt-4 first:mt-2">
      <h3 className="text-xs font-semibold">
        {section.title}{" "}
        <span className="font-normal text-muted-foreground tabular-nums">
          {section.targets.length}
        </span>
      </h3>
      {/* The blurb is not decoration: it is the only place the reader learns that a
          word rule also hides people they follow. */}
      <p className="mt-0.5 text-2xs text-muted-foreground">{section.blurb}</p>
      <ul className="mt-1.5 grid gap-0.5">
        {section.targets.map((target) => (
          <MutedRow
            key={entryKey(target)}
            target={target}
            author={
              target.kind === "pubkey" ? authors.get(target.value) : undefined
            }
            busy={pending === entryKey(target)}
            canSign={canSign}
            onUnmute={onUnmute}
          />
        ))}
      </ul>
    </section>
  );
}

/** How to name one entry, and the secondary line that disambiguates it. */
function rowLabels(
  target: MuteTarget,
  author: AuthorView | undefined,
): { primary: string; secondary?: string } {
  switch (target.kind) {
    case "pubkey": {
      const npub = encodeNpub(target.value);
      const short = npub ? truncateNpub(npub, 8) : target.value.slice(0, 12);
      // The key is always shown alongside the name: display names are not unique,
      // and unmuting the wrong account of two with the same name is not something
      // this dialog can undo for you.
      return author?.resolved
        ? { primary: author.displayName, secondary: short }
        : { primary: short };
    }
    case "hashtag":
      return { primary: `#${target.value}` };
    case "word":
      return { primary: target.value };
    case "thread":
      return {
        primary: `Thread ${target.value.slice(0, 12)}…`,
        secondary: "and every reply in it",
      };
  }
}

function MutedRow({
  target,
  author,
  busy,
  canSign,
  onUnmute,
}: {
  target: MuteTarget;
  author: AuthorView | undefined;
  busy: boolean;
  canSign: boolean;
  onUnmute(target: MuteTarget): void;
}) {
  const { primary, secondary } = rowLabels(target, author);
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{primary}</span>
        {secondary ? (
          <span className="block truncate font-mono text-2xs text-muted-foreground">
            {secondary}
          </span>
        ) : null}
      </span>
      <Button
        variant="outline"
        size="xs"
        onClick={() => onUnmute(target)}
        disabled={busy || !canSign}
        title={
          canSign ? undefined : "Read-only session — an unmute has to be signed"
        }
      >
        {busy ? <Spinner aria-hidden className="size-3 border-2" /> : null}
        Unmute
      </Button>
    </li>
  );
}

const DRAFT_KINDS: readonly {
  readonly kind: "word" | "hashtag";
  readonly label: string;
  readonly Icon: typeof Hash;
  readonly placeholder: string;
}[] = [
  {
    kind: "word",
    label: "Word",
    Icon: Type,
    placeholder: "airdrop",
  },
  {
    kind: "hashtag",
    label: "Hashtag",
    Icon: Hash,
    placeholder: "politics",
  },
];

/**
 * Adding a word or a hashtag.
 *
 * Only these two kinds. An account is muted from its own note or profile, where the
 * reader can see who they are muting; a field that took 64 hex characters would be
 * a way to mute the wrong person by typo, with no way to tell that you had.
 */
function AddMuteForm({
  onAdd,
  busy,
  rules,
  canSign,
}: {
  onAdd(target: MuteTarget): void;
  busy: boolean;
  rules: MuteRules;
  canSign: boolean;
}) {
  const fieldId = useId();
  const [kind, setKind] = useState<"word" | "hashtag">("word");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | undefined>();

  const active = DRAFT_KINDS.find((option) => option.kind === kind);

  const submit = () => {
    const checked = checkMuteDraft(kind, value, rules);
    if (!checked.ok) {
      // Refused inline, before a relay round trip and a signing prompt. See
      // `mutedListModel` for why each refusal is worth catching here.
      setProblem(checked.message);
      return;
    }
    setProblem(undefined);
    setValue("");
    onAdd(checked.target);
  };

  return (
    <div className="rounded-lg border border-border/60 p-2.5">
      <div className="flex items-center gap-1">
        {DRAFT_KINDS.map(({ kind: option, label, Icon }) => (
          <Button
            key={option}
            type="button"
            variant={kind === option ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={kind === option}
            onClick={() => {
              setKind(option);
              setProblem(undefined);
            }}
          >
            <Icon />
            {label}
          </Button>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Input
          id={fieldId}
          value={value}
          placeholder={active?.placeholder}
          aria-label={kind === "word" ? "Word to mute" : "Hashtag to mute"}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
        />
        <Button
          onClick={submit}
          disabled={busy || !canSign || value.trim() === ""}
          title={
            canSign ? undefined : "Read-only session — a mute has to be signed"
          }
        >
          {busy ? <Spinner aria-hidden className="size-4 border-2" /> : null}
          <VolumeX />
          Mute
        </Button>
      </div>
      {problem !== undefined ? (
        <p className="mt-1 text-2xs text-destructive">{problem}</p>
      ) : (
        <p className="mt-1 text-2xs text-muted-foreground">
          {kind === "word"
            ? "Matched as a whole word, anywhere in a note's text — including notes from people you follow."
            : "Matched against a note's tags and against #hashtag in its text."}
        </p>
      )}
    </div>
  );
}
