/**
 * A NIP-88 poll, rendered and votable.
 *
 * The card's job is split three ways and only the middle part is arithmetic:
 * `nip88.ts` decodes and tallies, `pollViews.ts` decides what may honestly be said
 * about the tally, and this file draws it and publishes a vote. The division is
 * deliberate — the temptation in a poll UI is to compute a percentage right where
 * the bar is drawn, and doing it here would put the one claim we cannot support
 * next to the one element that makes it look authoritative.
 *
 * What the reader sees is a share of *the responses this device holds*, with the
 * denominator stated under the bars. There is no percentage text anywhere, and the
 * bar widths are the only place a ratio appears at all.
 *
 * Voting goes through `usePublish`, which writes the signed event to the local
 * store before any relay answers — so the reader's own vote arrives in the tally
 * through the same store observer a stranger's does. Nothing is optimistic, for the
 * reason `useNoteActions` gives: a parallel counter is a second source of truth,
 * and reconciliation is where "your vote counted" survives every relay rejecting it.
 */

import {
  buildPollResponse,
  type PollResponse,
  parsePoll,
  tallyPoll,
} from "@setu/protocol";
import { Button, cn } from "@setu/ui";
import { BarChart3, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { usePublish } from "../compose/usePublish";
import { useSession } from "../identity/SessionProvider";
import { EmojiText } from "./CustomEmoji";
import {
  optionCountLabel,
  type PollOptionRow,
  type PollView,
  pollView,
} from "./pollViews";
import { absoluteTime } from "./relativeTime";
import type { NoteView } from "./types";
import { usePollResponses } from "./usePollResponses";

const NO_EMOJI: ReadonlyMap<string, string> = new Map();

/**
 * The reader's own newest response, as a set of option ids.
 *
 * Newest wins for the same reason the tally collapses per voter: an account that
 * changed its answer has two kind-1018s, and highlighting both would show the
 * reader having voted for options they moved away from.
 */
function ownPicks(
  responses: readonly PollResponse[],
  pubkey: string | undefined,
): ReadonlySet<string> {
  if (pubkey === undefined) return new Set();
  let newest: PollResponse | undefined;
  for (const response of responses) {
    if (response.voter !== pubkey) continue;
    if (newest === undefined || response.createdAt > newest.createdAt) {
      newest = response;
    }
  }
  return new Set(newest?.optionIds ?? []);
}

export interface PollCardProps {
  note: NoteView;
  /** NIP-30 map for the question text, when the poll declared custom emoji. */
  emoji?: ReadonlyMap<string, string>;
}

export function PollCard({ note, emoji = NO_EMOJI }: PollCardProps) {
  const { session } = useSession();
  const { responses, bounded } = usePollResponses(note.id);
  const { publish } = usePublish();
  const [draft, setDraft] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<
    | { readonly status: "idle" | "working" }
    | { readonly status: "error"; readonly message: string }
  >({ status: "idle" });

  const poll = useMemo(
    () =>
      parsePoll({
        id: note.id,
        pubkey: note.author.pubkey,
        kind: note.kind,
        tags: note.tags,
        content: note.content,
        created_at: note.createdAt,
      }),
    [
      note.id,
      note.author.pubkey,
      note.kind,
      note.tags,
      note.content,
      note.createdAt,
    ],
  );

  // Pinned to the render rather than ticking: a card that re-derives `now` on a
  // timer would re-render every poll on screen once a second to move nothing.
  const now = Math.floor(Date.now() / 1000);

  const picks = useMemo(
    () => ownPicks(responses, session?.pubkey),
    [responses, session?.pubkey],
  );

  const view = useMemo(() => {
    if (!poll) return undefined;
    return pollView({
      poll,
      tally: tallyPoll(poll, responses),
      bounded,
      chosen: picks,
      now,
    });
  }, [poll, responses, bounded, picks, now]);

  if (!poll || !view) {
    // A kind-1068 with no options is not a ballot. Saying so beats an empty frame,
    // which reads as a card that failed to load.
    return (
      <p className="mt-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        This poll declares no options, so there is nothing to vote on.
      </p>
    );
  }

  const voted = picks.size > 0;
  const canVote = Boolean(session?.canSign) && !view.ended && !voted;
  const working = state.status === "working";

  const toggle = (optionId: string) => {
    setDraft((current) => {
      // Single choice replaces; multiple choice accumulates. Getting this backwards
      // builds a response naming two options that no tally will count as intended.
      if (!view.multiple) return new Set([optionId]);
      const next = new Set(current);
      if (!next.delete(optionId)) next.add(optionId);
      return next;
    });
  };

  const submit = () => {
    if (draft.size === 0 || working) return;
    setState({ status: "working" });
    void (async () => {
      try {
        const outcome = await publish(buildPollResponse(poll, [...draft]));
        if (!outcome.accepted) {
          setState({
            status: "error",
            message:
              outcome.results.find((result) => result.message)?.message ??
              "No relay accepted your vote.",
          });
          return;
        }
        // Cleared rather than marked "done": the vote arrives in the tally through
        // the store observer, so there is nothing left for this card to report.
        setState({ status: "idle" });
        setDraft(new Set());
      } catch (cause) {
        setState({
          status: "error",
          message:
            cause instanceof Error ? cause.message : "Signing was declined.",
        });
      }
    })();
  };

  return (
    <section className="mt-2 rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="text-base font-medium break-words">
        <EmojiText text={view.question} emoji={emoji} />
      </p>

      <ul className="mt-2 space-y-1.5">
        {view.options.map((row) => (
          <li key={row.id}>
            <PollOptionBar
              row={row}
              voters={view.voters}
              selectable={canVote}
              selected={canVote ? draft.has(row.id) : row.chosen}
              onSelect={() => toggle(row.id)}
            />
          </li>
        ))}
      </ul>

      {canVote ? (
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="xs"
            disabled={draft.size === 0 || working}
            onClick={submit}
          >
            {working ? <Loader2 className="animate-spin" /> : null}
            {view.multiple ? "Submit answers" : "Vote"}
          </Button>
          {view.multiple ? (
            <span className="text-2xs text-muted-foreground">
              Pick as many as apply.
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Every reason a reader cannot vote is stated, rather than the controls
          simply not responding — a ballot that silently ignores clicks is
          indistinguishable from one that is broken. */}
      {!canVote ? (
        <p className="mt-2 text-2xs text-muted-foreground">
          {view.ended
            ? "This poll has closed."
            : voted
              ? "You have answered this poll. Your newest response is the one that counts."
              : "Sign in with a key to vote."}
        </p>
      ) : null}

      <PollFooter view={view} />

      {state.status === "error" ? (
        <p className="mt-1 text-2xs text-destructive">{state.message}</p>
      ) : null}
    </section>
  );
}

/**
 * One option: a bar, its label, and its count as a fraction of the sample.
 *
 * The count reads "3 of 8" rather than "38%". A percentage of a sample nobody
 * enumerated is the poll's result as far as any reader is concerned, and a fraction
 * with the denominator visible is the same information without the claim.
 */
function PollOptionBar({
  row,
  voters,
  selectable,
  selected,
  onSelect,
}: {
  row: PollOptionRow;
  voters: number;
  selectable: boolean;
  selected: boolean;
  onSelect(): void;
}) {
  const content = (
    <>
      {/* Inline width because the ratio is data from the events: Tailwind can only
          emit classes it can see at build time. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 rounded-md bg-primary/15"
        style={{ width: `${Math.round(row.shareOfSample * 100)}%` }}
      />
      <span className="relative min-w-0 flex-1 truncate">{row.label}</span>
      <span className="relative setu-mono shrink-0 text-2xs text-muted-foreground tabular-nums">
        {optionCountLabel(row, voters)}
      </span>
    </>
  );

  const shell =
    "relative flex w-full items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 text-sm";

  if (!selectable) {
    return (
      <div
        className={cn(
          shell,
          row.chosen ? "border-primary/60" : "border-border/60",
        )}
      >
        {content}
        {row.chosen ? <span className="sr-only">your answer</span> : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      // `aria-pressed` for both poll types rather than a `radio` role for one of
      // them: a real radio group owes a screen reader arrow-key navigation between
      // its members, and claiming the role without implementing that is worse than
      // announcing an honest pair of toggle buttons. The "pick one" rule is stated
      // in the surrounding copy instead, and enforced by `toggle`.
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        shell,
        "cursor-pointer text-left transition-colors duration-(--motion-duration-instant)",
        "hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        selected ? "border-primary" : "border-border/60",
      )}
    >
      {content}
    </button>
  );
}

/** The line that makes the numbers above it mean something. */
function PollFooter({ view }: { view: PollView }) {
  return (
    <div className="mt-2 border-t border-border/40 pt-1.5">
      <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
        <BarChart3 className="mt-px size-3 shrink-0" />
        <span>{view.sampleNotice}</span>
      </p>
      {view.caveats.map((caveat) => (
        <p key={caveat} className="pl-4.5 text-2xs text-muted-foreground">
          {caveat}
        </p>
      ))}
      {view.endsAt !== undefined ? (
        <p className="pl-4.5 text-2xs text-muted-foreground">
          {view.ended ? "Closed" : "Closes"} {absoluteTime(view.endsAt)}
        </p>
      ) : null}
    </div>
  );
}
