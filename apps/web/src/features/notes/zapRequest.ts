/**
 * The NIP-57 zap request (kind 9734).
 *
 * A 9734 is the one signed event in Setu that is **never published to a relay**.
 * It is signed and handed to the recipient's LNURL server, which embeds it in the
 * receipt (kind 9735) it publishes after the invoice is paid. Publishing the
 * request ourselves would put an unpaid "zap" on the network that other clients
 * may count — a fabricated payment. `usePublish` is therefore deliberately not
 * used for it.
 *
 * The `relays` tag is the only way the receipt finds its way back to us: it tells
 * the LNURL server where to publish the 9735. Omitting it produces a payment that
 * works and a zap that never appears anywhere.
 */

import type { EventTemplate, Hex32 } from "@setu/protocol";
import { Kind } from "@setu/protocol";

export interface ZapRequestInput {
  /** Who is being paid. */
  readonly recipient: Hex32;
  /** Amount in millisatoshis, echoed to the LNURL callback. */
  readonly amountMsat: number;
  /** Where the receipt should be published. */
  readonly relays: readonly string[];
  /** The note being zapped. Absent for a zap straight to a profile. */
  readonly noteId?: Hex32;
  /** The original `lnurl1…` when the profile carried a `lud06`. */
  readonly lnurl?: string;
  /** Optional message shown with the zap. */
  readonly comment?: string;
}

/**
 * Build the zap request template.
 *
 * Tag order follows NIP-57's example — `relays`, `amount`, `lnurl`, `p`, `e` — so
 * a request is diffable against the spec and against other clients' output.
 */
export function buildZapRequest(input: ZapRequestInput): EventTemplate {
  const tags: string[][] = [];

  // Deduped, and capped: some LNURL servers reject an oversized request, and a
  // receipt published to twenty relays is not more likely to reach us than one
  // published to a handful.
  const relays = [...new Set(input.relays)].slice(0, 8);
  if (relays.length > 0) tags.push(["relays", ...relays]);

  tags.push(["amount", String(Math.trunc(input.amountMsat))]);
  if (input.lnurl) tags.push(["lnurl", input.lnurl]);
  tags.push(["p", input.recipient]);
  if (input.noteId) tags.push(["e", input.noteId]);

  return {
    kind: Kind.ZapRequest,
    content: input.comment?.trim() ?? "",
    tags,
  };
}

/** Default zap, in sats. Small enough to be a gesture rather than a decision. */
export const DEFAULT_ZAP_SATS = 21;
