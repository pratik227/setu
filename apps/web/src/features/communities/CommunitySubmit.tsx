import type { Community } from "@setu/protocol";
import { Button, cn } from "@setu/ui";
import { Send, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useSession } from "../identity/SessionProvider";
import type { CommunityWrites } from "./useCommunityWrites";

/**
 * Submitting a post to a community.
 *
 * A deliberately plain box rather than the full composer. The composer carries
 * uploads, emoji, content warnings and a draft — all reasonable in a timeline, all
 * noise on a form whose realistic outcome is "a moderator will look at this later".
 * If community posting turns out to want attachments, the composer is one prop away.
 *
 * ## The copy is the feature
 *
 * The one thing this screen must get right is that submitting is *not* posting. The
 * post is published, signed and public the moment the button is pressed — it simply
 * is not in the community until a moderator approves it. A user who is not told this
 * watches their post fail to appear and concludes Setu dropped it, which is both
 * wrong and the exact impression a moderation queue creates by design.
 *
 * So the button says "Submit", the confirmation says what happened and what has not,
 * and neither pretends a moderator is obliged to act.
 */
export function CommunitySubmit({
  community,
  writes,
}: {
  community: Community;
  writes: CommunityWrites;
}) {
  const { session } = useSession();
  const [content, setContent] = useState("");
  const busy = writes.submitState.status === "working";

  if (!session?.canSign) {
    return (
      <p className="border-b border-border/50 px-4 py-2.5 text-2xs text-muted-foreground">
        This is a read-only session, so you cannot post here or join. Both
        publish an event under your key. Reading a community needs no key.
      </p>
    );
  }

  const submit = async () => {
    if (await writes.submit(content)) setContent("");
  };

  return (
    <div className="border-b border-border/50 px-4 py-3">
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={`Post to ${community.name}…`}
        rows={2}
        className={cn(
          "w-full resize-none bg-transparent text-sm outline-hidden",
          "placeholder:text-muted-foreground",
        )}
      />

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <p className="min-w-0 text-2xs text-muted-foreground">
          Goes to this community's moderators. It is published either way — a
          moderator decides whether it appears here.
        </p>
        <Button
          size="xs"
          disabled={busy || content.trim() === ""}
          onClick={() => void submit()}
        >
          <Send />
          Submit
        </Button>
      </div>

      {writes.submitState.status === "submitted" ? (
        <p className="mt-1.5 text-2xs text-muted-foreground">
          Submitted. Your post is published and visible to anyone reading it
          directly, and it will appear in this community once a moderator
          approves it — which they are under no obligation to do.
        </p>
      ) : null}
      {writes.submitState.status === "error" ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-2xs text-destructive">
          <ShieldAlert className="mt-0.5 size-3 shrink-0" />
          <span className="flex-1">{writes.submitState.message}</span>
          <button
            type="button"
            onClick={writes.resetSubmit}
            className="shrink-0 underline hover:no-underline"
          >
            Dismiss
          </button>
        </p>
      ) : null}
    </div>
  );
}
