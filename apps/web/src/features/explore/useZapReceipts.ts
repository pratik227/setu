import type { NostrEvent } from "@setu/protocol";
import { getTagValue, Kind } from "@setu/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { useStoreEvents } from "../discover/useStoreEvents";
import { zapReceiptSats } from "../notes/bolt11";

export interface ZapReceiptView {
  readonly id: string;
  readonly createdAt: number;
  /** Sats actually paid, read from the invoice. Zero when unreadable. */
  readonly sats: number;
  /** Recipient, from the receipt's `p` tag. */
  readonly recipient: string;
  /**
   * Sender as *claimed* by the zap request embedded in the receipt.
   *
   * A receipt is signed by the recipient's LNURL server, not by the sender, so
   * this is a claim relayed by a third party rather than something we verified.
   * `undefined` for an anonymous zap or an unparseable request.
   */
  readonly sender?: string;
  /** The zapped event id, if the receipt names one. */
  readonly targetId?: string;
  /** Optional comment the sender attached to the zap request. */
  readonly comment?: string;
}

/**
 * The zap request carried in the receipt's `description` tag.
 *
 * NIP-57 puts the whole signed kind-9734 in there as a JSON string. Anything in
 * it is attacker-controlled — the LNURL server could have written it — so it is
 * parsed defensively and used only for display.
 */
function senderFromDescription(event: NostrEvent): {
  pubkey?: string;
  comment?: string;
} {
  const raw = getTagValue(event, "description");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      pubkey?: unknown;
      content?: unknown;
    };
    const pubkey =
      typeof parsed.pubkey === "string" && parsed.pubkey.length === 64
        ? parsed.pubkey
        : undefined;
    const comment =
      typeof parsed.content === "string" && parsed.content.trim()
        ? parsed.content.trim()
        : undefined;
    return {
      ...(pubkey ? { pubkey } : {}),
      ...(comment ? { comment } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Who a zap receipt *claims* sent it, and any comment they attached.
 *
 * `P` (uppercase) is the sender pubkey when the server copies it out; the request
 * JSON is the fallback. Both are the same claim from the same source — the
 * recipient's LNURL server — so neither is verified by this client. Exported so
 * notifications read the sender through this one parser: a second implementation
 * is how two screens end up disagreeing about who zapped you.
 */
export function zapSenderClaim(event: NostrEvent): {
  readonly pubkey?: string;
  readonly comment?: string;
} {
  const described = senderFromDescription(event);
  const pubkey = getTagValue(event, "P") ?? described.pubkey;
  return {
    ...(pubkey ? { pubkey } : {}),
    ...(described.comment ? { comment: described.comment } : {}),
  };
}

function toView(event: NostrEvent): ZapReceiptView | undefined {
  const recipient = getTagValue(event, "p");
  if (!recipient) return undefined;

  const claim = zapSenderClaim(event);
  const sender = claim.pubkey;
  const targetId = getTagValue(event, "e");

  return {
    id: event.id,
    createdAt: event.created_at,
    // Reuses the one BOLT11 amount reader in the app. A second parser is how a
    // zap total ends up inflated by a factor of 100 million on one screen only.
    sats: zapReceiptSats(event.tags),
    recipient,
    ...(sender ? { sender } : {}),
    ...(targetId ? { targetId } : {}),
    ...(claim.comment ? { comment: claim.comment } : {}),
  };
}

export interface ZapReceipts {
  readonly receipts: readonly ZapReceiptView[];
  /** Zapped notes we happen to hold, by event id. */
  readonly targets: ReadonlyMap<string, NostrEvent>;
  readonly loading: boolean;
}

/**
 * Recent zap receipts from the local store, newest first.
 *
 * Receipts are the one payment fact on Nostr a client can read without trusting
 * a number: the invoice in the receipt states what was paid. What a client
 * *cannot* do is total up the network's zaps, so nothing here aggregates beyond
 * what we hold.
 */
export function useZapReceipts(limit = 40): ZapReceipts {
  const engine = useEngine();
  const filter = useMemo(() => ({ kinds: [Kind.Zap], limit }), [limit]);
  const events = useStoreEvents(filter, { subscribe: true });

  const receipts = useMemo(() => {
    const out: ZapReceiptView[] = [];
    for (const { event } of events) {
      const view = toView(event);
      if (view) out.push(view);
    }
    return out;
  }, [events]);

  // Zapped notes are fetched only for receipts on screen, and only from the
  // store: a receipt pointing at a note nobody handed us stays unresolved rather
  // than triggering a per-row REQ.
  const [targets, setTargets] = useState<ReadonlyMap<string, NostrEvent>>(
    new Map(),
  );
  const targetKey = useMemo(
    () =>
      [...new Set(receipts.map((r) => r.targetId).filter(Boolean))]
        .sort()
        .join(","),
    [receipts],
  );

  useEffect(() => {
    const ids = targetKey ? targetKey.split(",") : [];
    if (ids.length === 0) {
      setTargets(new Map());
      return;
    }
    let cancelled = false;
    void engine.store.query({ ids }).then((stored) => {
      if (cancelled) return;
      setTargets(new Map(stored.map(({ event }) => [event.id, event])));
    });
    return () => {
      cancelled = true;
    };
  }, [engine, targetKey]);

  return { receipts, targets, loading: events.length === 0 };
}
