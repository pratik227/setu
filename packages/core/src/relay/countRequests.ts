import type { Filter } from "@setu/protocol";

/**
 * In-flight NIP-45 COUNT requests.
 *
 * Split out of the pool because it shares nothing with the EVENT/EOSE path: its
 * own subscription ids, its own pending map, its own timeouts, and a lifecycle
 * that ends on the first reply rather than on CLOSE. The pool routes three frame
 * types here and is otherwise unaware of it.
 *
 * The reason a timeout is mandatory rather than defensive: a relay that does not
 * implement NIP-45 does not answer and does not error. Nothing distinguishes "still
 * thinking" from "will never reply", so without a deadline the promise never
 * settles and the caller's loading state is permanent.
 */

/** One relay's answer to a COUNT, or why it has none. */
export type RelayCountResult =
  | {
      readonly relay: string;
      readonly ok: true;
      readonly count: number;
      /** The relay said this is an estimate rather than an exact figure. */
      readonly approximate: boolean;
    }
  | { readonly relay: string; readonly ok: false; readonly reason: string };

interface Pending {
  readonly relay: string;
  readonly settle: (result: RelayCountResult) => void;
}

/** Sends a frame to one relay. Injected so this stays free of socket details. */
type SendFrame = (relay: string, frame: readonly unknown[]) => void;

export class CountRequests {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly send: SendFrame,
    private readonly nextId: () => string,
  ) {}

  /** Ask one relay, resolving on its answer, a refusal, or the deadline. */
  ask(
    relay: string,
    filters: readonly Filter[],
    timeoutMs: number,
  ): Promise<RelayCountResult> {
    const id = this.nextId();
    return new Promise<RelayCountResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: RelayCountResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.pending.delete(id);
        // Close explicitly. A relay that answered still holds the subscription
        // open, and these are issued per screen — leaking one per profile visit
        // walks straight into `max_subscriptions`.
        try {
          this.send(relay, ["CLOSE", id]);
        } catch {
          // The socket may already be gone; the count is settled either way.
        }
        resolve(result);
      };
      timer = setTimeout(
        () => settle({ relay, ok: false, reason: "timeout" }),
        timeoutMs,
      );
      this.pending.set(id, { relay, settle });
      try {
        this.send(relay, ["COUNT", id, ...filters]);
      } catch (error) {
        settle({
          relay,
          ok: false,
          reason: error instanceof Error ? error.message : "send failed",
        });
      }
    });
  }

  /** `["COUNT", <id>, {count, approximate?}]` from a relay. */
  handleCount(relay: string, subId: unknown, payload: unknown): void {
    if (typeof subId !== "string") return;
    const entry = this.pending.get(subId);
    // The relay check matters: subscription ids are ours, but a misbehaving or
    // confused relay could echo one that belongs to a different connection.
    if (entry === undefined || entry.relay !== relay) return;
    const body =
      typeof payload === "object" && payload !== null
        ? (payload as { count?: unknown; approximate?: unknown })
        : {};
    if (typeof body.count !== "number" || !Number.isFinite(body.count)) {
      entry.settle({ relay, ok: false, reason: "malformed COUNT" });
      return;
    }
    entry.settle({
      relay,
      ok: true,
      count: Math.max(0, Math.floor(body.count)),
      // Relays are allowed to estimate. A number presented as exact when the
      // relay said otherwise is a number the reader cannot act on.
      approximate: body.approximate === true,
    });
  }

  /**
   * `["CLOSED", <id>, <reason>]` — a relay refusing the request.
   *
   * Settling here rather than waiting out the timeout turns a six-second stall
   * into an immediate, accurate "this relay cannot answer".
   */
  handleClosed(relay: string, subId: unknown, reason: string): void {
    if (typeof subId !== "string") return;
    const entry = this.pending.get(subId);
    if (entry === undefined || entry.relay !== relay) return;
    entry.settle({ relay, ok: false, reason });
  }

  /** Fail everything waiting on a relay that went away. */
  failAll(relay: string, reason: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.relay !== relay) continue;
      this.pending.delete(id);
      entry.settle({ relay, ok: false, reason });
    }
  }
}
