/**
 * Minimal BOLT11 amount reader, for zap totals.
 *
 * A zap receipt (kind 9735) carries the paid invoice in a `bolt11` tag, and the
 * amount is encoded in the human-readable prefix — no bech32 decode needed to
 * read it. We deliberately do not pull in a full BOLT11 parser: the only field
 * a timeline needs is the amount, and a zap total is the one number a reader
 * should never see inflated.
 *
 * Prefix grammar: `ln` + currency (`bc`, `tb`, `bcrt`, …) + optional amount +
 * optional multiplier, terminated by the bech32 separator `1`.
 */

/** Multiplier suffixes, as a fraction of one bitcoin. */
const MULTIPLIERS: Record<string, number> = {
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
};

const SATS_PER_BTC = 100_000_000;

/** Human-readable-part matcher: currency, then an optional amount. */
const HRP_RE = /^ln(?:bcrt|bc|tbs|tb|sb)(\d*)([munp]?)$/i;

/**
 * Sats encoded in a BOLT11 invoice, or `undefined` when the invoice carries no
 * amount (a donation-style open invoice) or cannot be read.
 *
 * The amount must be read from the human-readable part *only*, and the HRP ends
 * at the bech32 separator — which is the **last** `1` in the string, because the
 * bech32 data charset deliberately excludes `1`. Matching the amount with a
 * leading-anchored regex instead is subtly wrong: in `lnbc1pvjluez` the `1` is
 * the separator and the invoice has no amount, but a naive `(\d+)` reads it as
 * 1 BTC and reports 100,000,000 sats for a zap of nothing.
 */
export function bolt11Sats(invoice: string): number | undefined {
  const trimmed = invoice.trim();
  const separator = trimmed.lastIndexOf("1");
  if (separator <= 0) return undefined;

  const match = HRP_RE.exec(trimmed.slice(0, separator));
  if (!match) return undefined;

  const digits = match[1];
  if (!digits) return undefined;

  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix ? MULTIPLIERS[suffix] : 1;
  if (multiplier === undefined) return undefined;

  // `p` can encode sub-satoshi amounts; floor rather than round so a displayed
  // total is never larger than what was actually paid.
  return Math.floor(value * multiplier * SATS_PER_BTC);
}

/**
 * Sats for a zap receipt, preferring the invoice over the request's `amount`
 * tag.
 *
 * The `amount` tag lives in the *requested* zap and is chosen by the sender's
 * client, so it states an intent; the invoice is what the wallet actually paid.
 * When they disagree, the invoice is the truth.
 */
export function zapReceiptSats(tags: readonly (readonly string[])[]): number {
  let fromInvoice: number | undefined;
  let fromAmountTag: number | undefined;

  for (const tag of tags) {
    if (tag[0] === "bolt11" && tag[1]) {
      fromInvoice = bolt11Sats(tag[1]);
    } else if (tag[0] === "amount" && tag[1]) {
      const millisats = Number(tag[1]);
      if (Number.isFinite(millisats) && millisats > 0) {
        fromAmountTag = Math.floor(millisats / 1000);
      }
    }
  }

  return fromInvoice ?? fromAmountTag ?? 0;
}
