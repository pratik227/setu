/**
 * Zapping: every step up to the payment, and the payment itself when a wallet is
 * connected.
 *
 * The steps never change, whoever pays:
 *
 *   read the recipient's `lud16`/`lud06` from their kind-0
 *     → resolve the LNURL-pay endpoint and fetch it
 *     → confirm the service actually supports NIP-57 zaps
 *     → sign a kind-9734 zap request
 *     → ask the callback for an invoice
 *     → pay it through the NIP-47 connection, or hand it to the reader's own wallet
 *
 * ## Which of the two, and why the fallback stays
 *
 * A paired *and unlocked* wallet connection turns the last step into `pay_invoice`.
 * Without one — no pairing, still locked, a wallet that does not advertise
 * `pay_invoice`, or an invoice that fails the checks in `wallet/zapPayment.ts` — the old
 * hand-off is used unchanged. The hand-off is not a legacy path being kept alive out of
 * politeness: most readers have no connection paired, and the two `fetch` calls here are
 * the thing that most commonly fails in a browser (LNURL servers are under no obligation
 * to send CORS headers, and many do not), so a fetch failure still falls back to opening
 * the callback URL in a tab and says which happened.
 *
 * ## Nothing is paid on one press
 *
 * When the wallet route is available the first press *prepares*: it fetches the invoice,
 * reads the amount out of the invoice itself, and stops with that amount on screen.
 * Paying takes a second, explicit press. A zap that spends money on a single click of a
 * small icon in a feed — with the amount only ever implied by a setting — is a footgun,
 * and the confirmation is the difference between an amount someone chose and an amount
 * they were charged.
 *
 * ## Three refusals that predate the wallet and survive it
 *
 *  - **The 9734 is never published.** It is signed and handed to the LNURL server, which
 *    embeds it in the receipt it publishes once the invoice is paid. Publishing it
 *    ourselves would put an unpaid zap on the network for other clients to count, which
 *    is a fabricated payment.
 *  - **A zap is reported as sent only when the wallet says so.** On the hand-off path
 *    the furthest state is still "handed off". On the wallet path a `pay_invoice` that
 *    the wallet answered with a result is a payment that happened, and it may be said so
 *    — but the *zap* still only appears once the kind-9735 receipt arrives, and the copy
 *    says that.
 *  - **A wallet that does not answer is never a failed payment, and never retried.** The
 *    request was published; the money may be gone. That outcome is reported as
 *    unresolved with the invoice kept, and pressing zap again starts a fresh, separate
 *    decision — it never re-sends the request that went unanswered. See
 *    `wallet/walletPayments.ts`.
 */

import { isHex32, Kind, type NostrEvent } from "@setu/protocol";
import { useCallback, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSession } from "../identity/SessionProvider";
import { parseProfileContent } from "../profiles/profileContent";
import { useWalletPayer } from "../wallet/useWalletPayer";
import type { PaymentResult } from "../wallet/walletPayments";
import { planWalletZap } from "../wallet/zapPayment";
import { lnurlPayEndpoint, lnurlRefusalMessage, zapCallbackUrl } from "./lnurl";
import { buildZapRequest, DEFAULT_ZAP_SATS } from "./zapRequest";

/** A prepared payment: an invoice and the amount read out of it. */
export interface ZapConfirmation {
  readonly invoice: string;
  /** Sats, from the invoice — not from what was requested. */
  readonly amountSats: number;
}

/**
 * How long a prepared payment stays armed.
 *
 * Two things go stale together. LNURL invoices commonly expire in minutes, so an old
 * confirmation is usually unpayable anyway — but the more important one is that
 * *intent* expires: a press three hours after the amount was on screen is not the
 * confirmation of that amount, it is someone pressing an icon on a note they were
 * looking at for other reasons. Past this age the next press fetches a fresh invoice
 * and asks again, which costs a round trip and removes a way to spend money by
 * accident.
 */
export const ZAP_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Whether a preparation is too old to act on. Pure, so the rule is testable. */
export function zapConfirmationExpired(
  preparedAt: number,
  now: number = Date.now(),
): boolean {
  return now - preparedAt > ZAP_CONFIRMATION_TTL_MS;
}

/** What the hook keeps per prepared note: the confirmation plus when it was made. */
interface PreparedZap extends ZapConfirmation {
  readonly preparedAt: number;
}

export type ZapState =
  | {
      readonly status: "working";
      readonly step: "resolving" | "signing" | "invoicing" | "paying";
    }
  | {
      readonly status: "handed-off";
      /** The BOLT11 invoice, when we got one. Shown so it can be paid by hand. */
      readonly invoice?: string;
      readonly message: string;
      /**
       * Present while a connected wallet is waiting to be told to pay.
       *
       * Deliberately part of the *handed-off* state rather than a status of its own: an
       * invoice exists and nothing has been paid, which is precisely what handed-off has
       * always meant, and every surface that already renders that state keeps working
       * without needing to know a wallet is involved.
       */
      readonly confirm?: ZapConfirmation;
    }
  | { readonly status: "error"; readonly message: string };

export interface ZapApi {
  /** In-flight, handed-off and failed zaps, keyed by note id. */
  readonly states: ReadonlyMap<string, ZapState>;
  /**
   * Start a zap — or confirm one that is already prepared.
   *
   * The second meaning is not overloading for its own sake: a note row has exactly one
   * zap control, so the confirmation has to arrive through the same door. A press on a
   * note with a prepared payment pays it; any other press starts from the beginning.
   */
  zap(note: NostrEvent, options?: ZapOptions): Promise<boolean>;
  /** Pay a prepared zap. Only ever called because a person asked for it. */
  confirmPay(noteId: string): Promise<boolean>;
  /** Drop a prepared payment without paying it. */
  cancelPay(noteId: string): void;
  clear(noteId: string): void;
}

export interface ZapOptions {
  readonly amountSats?: number;
  readonly comment?: string;
}

/** The LNURL-pay response fields we use, after validation. */
interface PayParameters {
  readonly callback: string;
  readonly minSendable: number;
  readonly maxSendable: number;
  readonly commentAllowed: number;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Validate an LNURL-pay response.
 *
 * The server is a stranger's server, so every field is checked rather than cast.
 * `allowsNostr` and a valid `nostrPubkey` are required: without them the endpoint
 * can take a payment but will never publish a receipt, so calling the result a
 * zap would be wrong.
 */
function readPayParameters(
  body: unknown,
): { ok: true; params: PayParameters } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      message: "The lightning service sent an unreadable reply.",
    };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.status === "string" && raw.status.toUpperCase() === "ERROR") {
    const reason =
      typeof raw.reason === "string" ? raw.reason : "no reason given";
    return { ok: false, message: `The lightning service refused: ${reason}` };
  }
  if (raw.tag !== "payRequest" || typeof raw.callback !== "string") {
    return {
      ok: false,
      message: "That address is not an LNURL-pay endpoint.",
    };
  }
  if (raw.allowsNostr !== true || !isHex32(String(raw.nostrPubkey ?? ""))) {
    return {
      ok: false,
      message:
        "This lightning service does not support zaps (NIP-57), so a payment to it would never produce a zap receipt.",
    };
  }
  const minSendable = asFiniteNumber(raw.minSendable) ?? 1000;
  const maxSendable = asFiniteNumber(raw.maxSendable) ?? 100_000_000_000;
  return {
    ok: true,
    params: {
      callback: raw.callback,
      minSendable,
      maxSendable,
      commentAllowed: asFiniteNumber(raw.commentAllowed) ?? 0,
    },
  };
}

/**
 * The row state for a finished payment attempt.
 *
 * Pure and exported so the four outcomes can be asserted without a renderer, because the
 * distinction between them is the whole safety argument and it is invisible in a type:
 *
 *  - `paid` — the wallet answered with a result. Money moved, and it may be said so.
 *  - `refused` — the wallet said no. Nothing moved, and the reason belongs in the error
 *    slot where it is styled as a problem the reader can act on.
 *  - `unknown` — **no reply.** Not an error and not a success. It goes in the *notice*
 *    slot, not the error slot: a red "failed" beside a payment that may well have
 *    happened is the single most expensive thing this feature could tell someone. The
 *    message is the transport layer's own non-committal wording, passed through
 *    unchanged, and the invoice is kept because if the wallet did *not* pay it, it is
 *    still payable by hand.
 *  - `failed` — a local dead end. Nothing was published, so this is safe to call an
 *    error.
 */
export function zapPaymentState(
  result: PaymentResult,
  confirmation: ZapConfirmation,
): ZapState {
  switch (result.kind) {
    case "paid":
      return {
        status: "handed-off",
        message: `Your wallet paid ${confirmation.amountSats.toLocaleString()} sats. The zap itself appears once the recipient's service publishes the receipt.`,
      };
    case "unknown":
      return {
        status: "handed-off",
        invoice: confirmation.invoice,
        message: result.message,
      };
    case "refused":
    case "failed":
      return { status: "error", message: result.message };
  }
}

/** Open a URL or a `lightning:` intent. False when the browser blocked it. */
function handOff(url: string): boolean {
  if (typeof window === "undefined") return false;
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  return opened !== null;
}

export function useZap(): ZapApi {
  const engine = useEngine();
  const { session } = useSession();
  const { canPay, pay } = useWalletPayer();
  const [states, setStates] = useState<ReadonlyMap<string, ZapState>>(
    new Map(),
  );
  const inFlight = useRef(new Set<string>());
  /*
   * Prepared payments live in a ref, not in `states`.
   *
   * They are also mirrored into the state so the row can show them, but the *decision*
   * path reads the ref — because `useNoteRowActions` documents, with measurements, that
   * a `zap` callback whose identity changes on every state update costs the feed its row
   * memoisation entirely. Reading pending confirmations out of state would put `states`
   * in this callback's dependencies and re-render every row on screen whenever one row
   * started a zap.
   */
  const prepared = useRef(new Map<string, PreparedZap>());

  const setState = useCallback(
    (noteId: string, state: ZapState | undefined) => {
      setStates((previous) => {
        const next = new Map(previous);
        if (state) next.set(noteId, state);
        else next.delete(noteId);
        return next;
      });
    },
    [],
  );

  const clear = useCallback(
    (noteId: string) => {
      // The prepared payment goes with the visible state. A confirmation the reader can
      // no longer see must not still be armed behind the zap button.
      prepared.current.delete(noteId);
      setState(noteId, undefined);
    },
    [setState],
  );

  const cancelPay = useCallback(
    (noteId: string) => {
      if (!prepared.current.delete(noteId)) return;
      setState(noteId, {
        status: "handed-off",
        message:
          "Zap cancelled. Nothing was paid, and the invoice was not used.",
      });
    },
    [setState],
  );

  const confirmPay = useCallback(
    async (noteId: string): Promise<boolean> => {
      const confirmation = prepared.current.get(noteId);
      if (!confirmation) return false;
      if (inFlight.current.has(noteId)) return false;
      if (zapConfirmationExpired(confirmation.preparedAt)) {
        // Disarmed rather than paid. `zap` restarts from the beginning in this case; a
        // caller coming straight here is told why nothing happened.
        prepared.current.delete(noteId);
        setState(noteId, {
          status: "handed-off",
          message:
            "That confirmation is too old to act on, so nothing was paid. Zap again to fetch a fresh invoice.",
        });
        return false;
      }
      /*
       * Consumed before the request goes out.
       *
       * Two presses in one tick would otherwise both find a prepared payment and both
       * publish a `pay_invoice` for the same invoice. Deleting first also means that
       * after an unanswered payment there is nothing armed: the next press starts a
       * fresh zap with a fresh invoice, which is a new decision by a person, not a
       * retry of a request whose fate is unknown.
       */
      prepared.current.delete(noteId);
      inFlight.current.add(noteId);
      setState(noteId, { status: "working", step: "paying" });

      try {
        const result = await pay(confirmation.invoice);
        setState(noteId, zapPaymentState(result, confirmation));
        return result.kind === "paid";
      } finally {
        inFlight.current.delete(noteId);
      }
    },
    [pay, setState],
  );

  /** The recipient's lightning field, from the kind-0 we already hold. */
  const lightningFor = useCallback(
    async (pubkey: string) => {
      const rows = await engine.store.query({
        kinds: [Kind.Metadata],
        authors: [pubkey],
      });
      const newest = rows[0]?.event;
      return newest ? parseProfileContent(newest.content).lightning : undefined;
    },
    [engine],
  );

  const zap = useCallback(
    async (note: NostrEvent, options: ZapOptions = {}) => {
      const noteId = note.id;
      /*
       * A press on a note with a prepared payment is the confirmation.
       *
       * Checked before everything else, including the signing check: paying is done by
       * the *connection* key, so a session that has since become read-only does not
       * invalidate an invoice the reader already approved the amount of. The 9734 was
       * signed on the first press.
       */
      const armed = prepared.current.get(noteId);
      if (armed) {
        if (!zapConfirmationExpired(armed.preparedAt))
          return confirmPay(noteId);
        // Stale: the invoice has probably expired and the intent certainly has. Drop it
        // and fall through, so this press starts a fresh zap and asks again.
        prepared.current.delete(noteId);
      }
      if (!session?.canSign) {
        setState(noteId, {
          status: "error",
          message:
            "This is a read-only session. Unlock or sign in with a key to zap.",
        });
        return false;
      }
      if (inFlight.current.has(noteId)) return false;
      inFlight.current.add(noteId);

      const fail = (message: string) => {
        setState(noteId, { status: "error", message });
        return false;
      };

      try {
        setState(noteId, { status: "working", step: "resolving" });

        const endpoint = lnurlPayEndpoint(await lightningFor(note.pubkey));
        if (!endpoint.ok) return fail(lnurlRefusalMessage(endpoint.reason));

        let body: unknown;
        try {
          const response = await fetch(endpoint.url, {
            headers: { accept: "application/json" },
          });
          if (!response.ok) {
            return fail(
              `The lightning service answered ${response.status}. Nothing was sent.`,
            );
          }
          body = await response.json();
        } catch {
          return fail(
            "Could not reach the recipient's lightning service from the browser. Many of them do not allow cross-origin requests, which Setu cannot work around without a server.",
          );
        }

        const parameters = readPayParameters(body);
        if (!parameters.ok) return fail(parameters.message);
        const { callback, minSendable, maxSendable, commentAllowed } =
          parameters.params;

        const requested = (options.amountSats ?? DEFAULT_ZAP_SATS) * 1000;
        // Raise to the minimum rather than fail — a service with a 1000 msat
        // floor and a 21 sat default is the common case, not an error.
        const amountMsat = Math.max(Math.trunc(requested), minSendable);
        if (amountMsat > maxSendable) {
          return fail(
            `This service accepts at most ${Math.floor(maxSendable / 1000)} sats.`,
          );
        }

        const comment = options.comment?.trim();
        setState(noteId, { status: "working", step: "signing" });

        const template = buildZapRequest({
          recipient: note.pubkey,
          amountMsat,
          // Where the receipt should be published, so it reaches this client.
          relays: engine.relays,
          noteId,
          ...(endpoint.lnurl ? { lnurl: endpoint.lnurl } : {}),
          ...(comment && comment.length <= commentAllowed ? { comment } : {}),
        });

        let signed: NostrEvent;
        try {
          // Signed, never published: see the module comment.
          signed = await session.signer.signEvent(template);
        } catch (cause) {
          return fail(
            cause instanceof Error ? cause.message : "Signing was declined.",
          );
        }

        const built = zapCallbackUrl({
          callback,
          amountMsat,
          zapRequest: signed,
          ...(endpoint.lnurl ? { lnurl: endpoint.lnurl } : {}),
        });
        if (!built.ok) return fail(lnurlRefusalMessage(built.reason));

        setState(noteId, { status: "working", step: "invoicing" });

        let invoice: string | undefined;
        try {
          const response = await fetch(built.url, {
            headers: { accept: "application/json" },
          });
          const payload: unknown = await response.json();
          if (typeof payload === "object" && payload !== null) {
            const record = payload as Record<string, unknown>;
            if (typeof record.pr === "string") invoice = record.pr;
            else if (typeof record.reason === "string") {
              return fail(`The lightning service refused: ${record.reason}`);
            }
          }
        } catch {
          // Left undefined; the callback URL itself is still a usable handoff.
        }

        if (invoice) {
          /*
           * With a connection available, the invoice is checked against what was asked
           * for before it is offered up for payment — see `wallet/zapPayment.ts` for the
           * three rules. A refusal there is not an error: it means a person should be the
           * one to approve this particular invoice, so it falls through to the hand-off
           * carrying the reason.
           */
          const plan = planWalletZap({
            invoice,
            requestedMsat: amountMsat,
            canPay: canPay(),
          });
          if (plan.route === "wallet") {
            prepared.current.set(noteId, {
              invoice,
              amountSats: plan.amountSats,
              preparedAt: Date.now(),
            });
            setState(noteId, {
              status: "handed-off",
              confirm: { invoice, amountSats: plan.amountSats },
              message: `Ready to pay ${plan.amountSats.toLocaleString()} sats from your connected wallet. Nothing has been sent yet — zap again to pay it.`,
            });
            return true;
          }

          const opened = handOff(`lightning:${invoice}`);
          const handedOff = opened
            ? "Invoice handed to your lightning wallet. The zap appears once the payment is made and the receipt is published."
            : "Setu could not open a wallet — copy the invoice below to pay it.";
          setState(noteId, {
            status: "handed-off",
            invoice,
            // The reason is prepended, not appended: when a connected wallet was
            // available and deliberately not used, that is the more important half of
            // the sentence and the row may truncate.
            message: plan.reason ? `${plan.reason} ${handedOff}` : handedOff,
          });
          return true;
        }

        // No invoice in hand: open the callback so a wallet page can complete it.
        const opened = handOff(built.url);
        setState(noteId, {
          status: "handed-off",
          message: opened
            ? "Opened the recipient's lightning service in a new tab to finish the payment."
            : "Setu could not fetch an invoice or open a tab. Nothing was paid.",
        });
        return opened;
      } finally {
        inFlight.current.delete(noteId);
      }
    },
    // Every entry is reference-stable: `canPay` and `confirmPay` are memoised over
    // nothing that changes per render, which is what keeps the assembled action object
    // in `useNoteRowActions` stable and the feed's rows memoised.
    [canPay, confirmPay, engine, lightningFor, session, setState],
  );

  return { states, zap, confirmPay, cancelPay, clear };
}
