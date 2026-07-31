import type { NostrEvent } from "@setu/protocol";
import { Button, cn, Separator, Spinner } from "@setu/ui";
import { ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { REPLACEABLE_LIST_LIMIT } from "../../engine/queryLimits";
import { useSharedSubscription } from "../../engine/sharedSubscription";
import type { usePublish } from "../compose/usePublish";
import { useStoreEvents } from "../discover/useStoreEvents";
import { useSession } from "../identity/SessionProvider";
import type { RelayEditResult } from "./relayListEdit";

/**
 * The two pieces every settings section that writes a replaceable event needs.
 *
 * Shared rather than duplicated because the *rule* is shared: a kind-0 or
 * kind-10002 write replaces the previous one entirely, so no section may publish
 * until it knows whether one already exists.
 */

/** How long to wait before treating a missing list as genuinely absent. */
export const ABSENT_AFTER_MS = 8000;

/**
 * Load the account's newest copy of one replaceable kind, and say when we are
 * confident there is none.
 *
 * `absenceConfirmed` is the important half. Without it a form cannot distinguish
 * "you have no relay list" from "your relay list has not arrived yet", and writing
 * in the second case destroys the first.
 */
export function useOwnReplaceable(kind: number): {
  event: NostrEvent | undefined;
  absenceConfirmed: boolean;
} {
  const { session } = useSession();
  const pubkey = session?.pubkey;
  const filter = useMemo(
    () =>
      pubkey
        ? { kinds: [kind], authors: [pubkey], limit: REPLACEABLE_LIST_LIMIT }
        : undefined,
    [kind, pubkey],
  );
  useSharedSubscription(filter);
  const rows = useStoreEvents(filter ?? { ids: [], kinds: [], limit: 1 });

  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), ABSENT_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return {
    event: rows[0]?.event,
    absenceConfirmed: waited && rows.length === 0,
  };
}

/** Copy for a refusal, so every section explains a blocked save the same way. */
export function refusalMessage(
  result: RelayEditResult,
  subject: string,
): string {
  if (result.ok) return "";
  switch (result.reason) {
    case "unverified-absence":
      return `Setu has not finished checking whether you already have ${subject}. Saving now could replace one it has not seen yet.`;
    case "would-empty":
      return "A list with no relays is not the same as no preference — it tells other clients you can be reached nowhere. Add at least one.";
    default:
      return "Nothing has changed.";
  }
}

export function SaveRow({
  busy,
  error,
  state,
  onSave,
  onDismiss,
}: {
  busy: boolean;
  error: string | undefined;
  state: ReturnType<typeof usePublish>["state"];
  onSave(): void;
  onDismiss(): void;
}) {
  const { session } = useSession();
  return (
    <>
      <Separator className="my-1" />
      {error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 underline hover:no-underline"
          >
            Dismiss
          </button>
        </p>
      ) : null}
      {state.status === "failed" ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}
      {state.status === "sent" ? (
        <p className="text-xs text-muted-foreground">
          Saved to {state.results.filter((r) => r.ok).length} of{" "}
          {state.results.length} relays.
        </p>
      ) : null}
      <div className={cn("flex justify-end")}>
        <Button size="sm" disabled={busy || !session?.canSign} onClick={onSave}>
          {busy ? <Spinner size={14} aria-hidden /> : null}
          Save
        </Button>
      </div>
    </>
  );
}
