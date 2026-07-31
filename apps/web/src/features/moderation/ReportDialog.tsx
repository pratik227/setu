import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  Textarea,
} from "@setu/ui";
import { useId, useState } from "react";
import { usePublish } from "../compose/usePublish";
import { useSession } from "../identity/SessionProvider";
import {
  buildReport,
  MAX_REPORT_COMMENT,
  REPORT_TYPE_COPY,
  REPORT_TYPES,
  type ReportType,
} from "./report";

/**
 * Filing a NIP-56 report, without implying anything happened.
 *
 * The hard part of this dialog is the copy, not the form. A "Report" button carries
 * an expectation borrowed from centralized platforms — that a moderator will read it
 * and something will be removed — and on Nostr there is nobody on the other end
 * unless a relay operator has chosen to be. What actually happens is that a kind-1984
 * event is signed with the reader's own key and published to their own relays, where
 * it may be read, ignored, or never fetched by anyone.
 *
 * So the wording commits to exactly that and no more: the confirmation says the
 * report was *published*, never that the note was actioned, and the reader is told
 * before they send it that it is public and signed. The alternative — a checkmark and
 * "Thanks, we'll look into it" — is a lie a client tells to feel complete.
 */

export interface ReportDialogProps {
  /** The author being reported, or the author of the reported note. */
  pubkey: string;
  /** How to name the author to the reader. */
  name: string;
  /** The note being reported. Omit to report the account alone. */
  noteId?: string;
  onClose(): void;
}

export function ReportDialog({
  pubkey,
  name,
  noteId,
  onClose,
}: ReportDialogProps) {
  const { session } = useSession();
  const { publish } = usePublish();
  const groupName = useId();
  const commentId = useId();
  const [type, setType] = useState<ReportType>("spam");
  const [comment, setComment] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState<number | undefined>();

  const subject = noteId === undefined ? `${name}'s account` : "this note";

  const send = () => {
    setError(undefined);
    const built = buildReport({
      type,
      pubkey,
      ...(noteId !== undefined ? { event: { id: noteId } } : {}),
      comment,
      ...(session ? { reporter: session.pubkey } : {}),
    });
    if (!built.ok) {
      setError(
        built.reason === "self-report"
          ? "This is your own content, so there is nobody to report it to."
          : "This report could not be built — the target is not a valid Nostr reference.",
      );
      return;
    }
    setWorking(true);
    void (async () => {
      try {
        const outcome = await publish(built.template);
        if (outcome.accepted) {
          setSent(outcome.results.filter((result) => result.ok).length);
        } else {
          setError(
            outcome.results.find((result) => result.message)?.message ??
              "No relay accepted the report.",
          );
        }
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Signing was declined.",
        );
      } finally {
        setWorking(false);
      }
    })();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {sent === undefined ? `Report ${subject}` : "Report published"}
          </DialogTitle>
          <DialogDescription>
            {sent === undefined
              ? "A report is a public note, signed by your key, saying what you think is wrong. It does not remove anything and it does not block anyone."
              : `Accepted by ${sent} ${sent === 1 ? "relay" : "relays"}. Whether anyone acts on it is up to those relay operators and the clients that read reports — Setu cannot tell you, and nothing about ${name} has changed.`}
          </DialogDescription>
        </DialogHeader>

        {sent === undefined ? (
          <>
            <fieldset className="grid gap-0.5">
              <legend className="mb-1 text-xs font-medium text-muted-foreground">
                What is wrong with it?
              </legend>
              {REPORT_TYPES.map((option) => (
                // A native radio: the keyboard behaviour of a radio group (arrow
                // keys move within it, tab leaves it) is not worth reimplementing.
                <label
                  key={option}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent"
                >
                  <input
                    type="radio"
                    name={groupName}
                    value={option}
                    checked={type === option}
                    onChange={() => setType(option)}
                    className="mt-1 size-3.5 shrink-0 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {REPORT_TYPE_COPY[option].label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {REPORT_TYPE_COPY[option].hint}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="grid gap-1.5">
              <label
                htmlFor={commentId}
                className="text-xs font-medium text-muted-foreground"
              >
                Anything a relay operator would need to know (optional, public)
              </label>
              <Textarea
                id={commentId}
                value={comment}
                maxLength={MAX_REPORT_COMMENT}
                onChange={(event) => setComment(event.target.value)}
                placeholder="What should someone reading this report look at?"
                className="min-h-16"
              />
            </div>

            {error !== undefined ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : null}

            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={working}>
                Cancel
              </Button>
              <Button
                onClick={send}
                disabled={working || !session?.canSign}
                title={
                  session?.canSign
                    ? undefined
                    : "Read-only session — a report has to be signed"
                }
              >
                {working ? (
                  <Spinner aria-hidden className="size-4 border-2" />
                ) : null}
                Publish report
              </Button>
            </DialogFooter>
          </>
        ) : (
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
