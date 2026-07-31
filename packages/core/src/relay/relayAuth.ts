import type { EventTemplate, NostrEvent } from "@setu/protocol";
import { buildAuthEvent, isAuthEventFor } from "@setu/protocol";

/**
 * NIP-42 authentication state for one relay pool.
 *
 * Split from the pool because it is a small state machine with its own rules —
 * challenge in, signature out, retry what was refused — and because those rules are
 * the ones worth reading on their own.
 *
 * ## Authentication is per connection, not per relay
 *
 * A reconnected socket is a fresh anonymous session. Keeping the flag across a
 * reconnect leaves the client believing it is logged in while every gated query
 * silently returns nothing, which is the hardest version of this bug to notice.
 * {@link reset} is called on every disconnect.
 *
 * ## Answering is a choice
 *
 * A signed AUTH event tells the relay exactly who is reading. A client that answers
 * every challenge hands its user's pubkey to any relay that thinks to ask — including
 * relays reached incidentally through outbox routing. `allowed` is how the caller
 * limits that to relays the account actually chose.
 */

export interface RelayAuthenticatorOptions {
  /** Sends a frame to one relay. */
  readonly send: (relay: string, frame: readonly unknown[]) => void;
  /** Signs the challenge answer. Absent means never authenticate. */
  readonly sign?: (template: EventTemplate) => Promise<NostrEvent>;
  /** Whether to identify to this relay at all. Default: yes. */
  readonly allowed?: (relay: string) => boolean;
  /** Called once AUTH succeeds, with the subscriptions to re-send. */
  readonly onAuthenticated: (relay: string, subIds: readonly string[]) => void;
  readonly onError?: (relay: string, error: unknown) => void;
}

export class RelayAuthenticator {
  /** Relays authenticated on their *current* connection. */
  private readonly authenticated = new Set<string>();
  /** The newest unanswered challenge per relay. */
  private readonly challenges = new Map<string, string>();
  /** Subscriptions refused with `auth-required`, to retry once authenticated. */
  private readonly deferred = new Map<string, Set<string>>();

  constructor(private readonly options: RelayAuthenticatorOptions) {}

  isAuthenticated(relay: string): boolean {
    return this.authenticated.has(relay);
  }

  /** `["AUTH", <challenge>]` — the relay is asking who we are. */
  onChallenge(relay: string, challenge: unknown): void {
    if (typeof challenge !== "string" || challenge === "") return;
    this.challenges.set(relay, challenge);
    void this.authenticate(relay);
  }

  /**
   * A relay refused a subscription with `auth-required:`.
   *
   * Not a refusal but a precondition, so the subscription is remembered rather
   * than failed, and the relay is not penalised for it. Treating it as a refusal
   * is exactly how a client shows an empty screen against a working paid relay.
   */
  deferSubscription(relay: string, subId: string): void {
    const waiting = this.deferred.get(relay) ?? new Set<string>();
    waiting.add(subId);
    this.deferred.set(relay, waiting);
    void this.authenticate(relay);
  }

  /** Forget everything about a relay whose socket went away. */
  reset(relay: string): void {
    this.authenticated.delete(relay);
    this.challenges.delete(relay);
    this.deferred.delete(relay);
  }

  private async authenticate(relay: string): Promise<void> {
    if (this.authenticated.has(relay)) return;
    const challenge = this.challenges.get(relay);
    const sign = this.options.sign;
    if (challenge === undefined || sign === undefined) return;
    if (this.options.allowed?.(relay) === false) return;

    // Claim the challenge before awaiting. A relay may challenge and refuse a REQ
    // in the same tick, and signing twice would prompt a browser extension twice
    // for one login.
    this.challenges.delete(relay);
    try {
      const signed = await sign(buildAuthEvent({ relay, challenge }));

      /*
       * Verify before sending.
       *
       * A signed AUTH event is a bearer proof for one relay and one challenge. If
       * a signer returned one naming a different relay — a bug, or a hostile
       * remote signer under NIP-46 — sending it would hand this relay a working
       * credential for another. The signature already exists by this point;
       * refusing to transmit it is the last moment that matters.
       */
      if (!isAuthEventFor(signed, relay, challenge)) {
        this.options.onError?.(
          relay,
          new Error("signer returned an AUTH event for a different relay"),
        );
        return;
      }

      this.options.send(relay, ["AUTH", signed]);
      this.authenticated.add(relay);

      const waiting = this.deferred.get(relay);
      if (waiting !== undefined) {
        this.deferred.delete(relay);
        this.options.onAuthenticated(relay, [...waiting]);
      }
    } catch (error) {
      // A declined or failed signature is not fatal — the relay stays anonymous
      // and whatever it gates stays empty. Put the challenge back so a later
      // attempt (an unlocked key, a retried REQ) can still use it.
      this.challenges.set(relay, challenge);
      this.options.onError?.(relay, error);
    }
  }
}
