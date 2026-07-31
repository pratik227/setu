/**
 * Zapping, as far as it honestly goes without a wallet.
 *
 * Setu has no wallet and no server, so it cannot pay an invoice. What it *can*
 * do is every step up to the payment, correctly:
 *
 *   read the recipient's `lud16`/`lud06` from their kind-0
 *     → resolve the LNURL-pay endpoint and fetch it
 *     → confirm the service actually supports NIP-57 zaps
 *     → sign a kind-9734 zap request
 *     → ask the callback for an invoice
 *     → hand the invoice to whatever the reader uses to pay
 *
 * Two deliberate refusals:
 *
 *  - **The 9734 is never published.** It is signed and handed to the LNURL
 *    server, which embeds it in the receipt it publishes once the invoice is paid.
 *    Publishing it ourselves would put an unpaid zap on the network for other
 *    clients to count, which is a fabricated payment.
 *  - **No zap is ever reported as sent.** The furthest state here is
 *    "handed off": we produced an invoice and passed it on. Whether it was paid is
 *    something only the kind-9735 receipt can say, and that arrives through the
 *    store like any other event.
 *
 * The one thing that will commonly fail in a browser is the two `fetch` calls:
 * LNURL servers are under no obligation to send CORS headers, and many do not. So
 * a fetch failure falls back to opening the callback URL in a tab rather than
 * reporting a dead end, and says which happened.
 */

import { isHex32, Kind, type NostrEvent } from "@setu/protocol";
import { useCallback, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useSession } from "../identity/SessionProvider";
import { parseProfileContent } from "../profiles/profileContent";
import { lnurlPayEndpoint, lnurlRefusalMessage, zapCallbackUrl } from "./lnurl";
import { buildZapRequest, DEFAULT_ZAP_SATS } from "./zapRequest";

export type ZapState =
  | {
      readonly status: "working";
      readonly step: "resolving" | "signing" | "invoicing";
    }
  | {
      readonly status: "handed-off";
      /** The BOLT11 invoice, when we got one. Shown so it can be paid by hand. */
      readonly invoice?: string;
      readonly message: string;
    }
  | { readonly status: "error"; readonly message: string };

export interface ZapApi {
  /** In-flight, handed-off and failed zaps, keyed by note id. */
  readonly states: ReadonlyMap<string, ZapState>;
  zap(note: NostrEvent, options?: ZapOptions): Promise<boolean>;
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

/** Open a URL or a `lightning:` intent. False when the browser blocked it. */
function handOff(url: string): boolean {
  if (typeof window === "undefined") return false;
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  return opened !== null;
}

export function useZap(): ZapApi {
  const engine = useEngine();
  const { session } = useSession();
  const [states, setStates] = useState<ReadonlyMap<string, ZapState>>(
    new Map(),
  );
  const inFlight = useRef(new Set<string>());

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
    (noteId: string) => setState(noteId, undefined),
    [setState],
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
          const opened = handOff(`lightning:${invoice}`);
          setState(noteId, {
            status: "handed-off",
            invoice,
            message: opened
              ? "Invoice handed to your lightning wallet. The zap appears once the payment is made and the receipt is published."
              : "Setu could not open a wallet — copy the invoice below to pay it.",
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
    [engine, lightningFor, session, setState],
  );

  return { states, zap, clear };
}
