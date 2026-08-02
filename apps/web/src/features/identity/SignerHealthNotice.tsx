import { PlugZap } from "lucide-react";
import { useSession } from "./SessionProvider";

/**
 * Says when a remote signer has stopped answering.
 *
 * The keep-alive already turns a dead bunker into a *fast* failure — five seconds
 * with a reason rather than a twenty-second hang blaming the network. But a fast
 * failure is still only discovered by trying to do something, and the thing a user
 * tries is usually posting a note they have just written. Learning your signer went
 * away at that moment costs the note; learning it beforehand costs a reconnect.
 *
 * ## Why this states a fact and offers no button
 *
 * There is nothing Setu can press on the user's behalf. A bunker connection is
 * re-established by the *signer* — the phone or the service holding the key — coming
 * back or being reopened, and a "Reconnect" control here would either do nothing or
 * silently retry a connection whose secret was deliberately never persisted. Naming
 * the state and where to fix it is the honest whole of what this can do.
 *
 * ## Only ever `unreachable`
 *
 * `alive` renders nothing: a working connection is the expected state and a green
 * badge for it would be noise on every screen forever. `undefined` — every session
 * that is not a bunker — renders nothing either, because a local key cannot be
 * unreachable and a notice implying otherwise would be false.
 */
export function SignerHealthNotice() {
  const { signerHealth } = useSession();
  if (signerHealth !== "unreachable") return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-warning/40 bg-warning-bg px-4 py-2 text-xs"
    >
      <PlugZap className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0">
        <span className="font-medium">
          Your remote signer has stopped answering.
        </span>{" "}
        Nothing can be signed until it is back — open the app or service holding
        your key, then try again. Reading carries on as normal.
      </p>
    </div>
  );
}
