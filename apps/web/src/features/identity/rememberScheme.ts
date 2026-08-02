import type { RemoteConnection } from "./remoteSigner";
import { loadSession, saveSession } from "./storage";

/**
 * Write the observed encryption scheme back to the stored record, once known.
 *
 * Needed because the evidence can arrive *after* sign-in returns. A `bunker://`
 * connect resolves as soon as the signer answers `get_public_key`, and for a
 * legacy signer that answer is itself the first NIP-04 frame — but for one whose
 * reply is still in flight, `observedScheme()` is undefined at adopt time and the
 * probe would be paid again on the next reload.
 *
 * So this polls a handful of times over the first few seconds and writes once.
 * Polling rather than a callback because the alternative is another option
 * threaded from the protocol package through two layers for a value that changes
 * exactly once per connection and is not a secret.
 *
 * Failure is silence: this only ever saves a *performance* hint. A record that
 * never gains one behaves exactly as it did before the field existed.
 */
export function rememberScheme(connection: RemoteConnection): void {
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    const scheme = connection.observedScheme();
    if (scheme === undefined) {
      if (attempts < 6) setTimeout(tick, 1500);
      return;
    }
    const stored = loadSession();
    // Only the record this connection belongs to, and only when it would change:
    // an account switch between the connect and this tick must not rewrite the
    // *new* account's row with the old one's scheme.
    if (
      stored?.kind !== "nip46" ||
      stored.remoteSigner === undefined ||
      stored.pubkey !== connection.userPubkey ||
      stored.remoteSigner.pubkey !== connection.remoteSignerPubkey ||
      stored.remoteSigner.scheme === scheme
    ) {
      return;
    }
    saveSession({
      ...stored,
      remoteSigner: { ...stored.remoteSigner, scheme },
    });
  };
  setTimeout(tick, 1500);
}
