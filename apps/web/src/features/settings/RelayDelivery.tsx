import type { StoredEvent } from "@setu/core";
import {
  type ContentClass,
  type RelayScorecard,
  SCORED_KINDS,
  scorecardQueries,
  scoreRows,
} from "@setu/core";
import { useEffect, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import { compactCount } from "../notes/relativeTime";

/**
 * What a relay has actually delivered, on the relay settings row.
 *
 * The row already shows what a relay *advertises* (NIP-11 capabilities, payment
 * gates). This adds what it *did*: which of the events this device holds came
 * through it, broken down by content class, and how many came from it alone. The
 * two together are what managing a relay list actually needs — a relay can
 * advertise everything and deliver nothing, and the reader deciding whether to
 * keep it deserves the measured answer next to the claimed one.
 *
 * The numbers are a local sample and the caption under the list says so. They are
 * not network shares: "delivered 0 long-form" means none of the long-form *you
 * have* came from it, which for a reader whose Reads tab is empty is exactly the
 * actionable fact ("none of your relays carries articles"), not a judgement of
 * the relay.
 *
 * `only source for N` is the removal-cost figure — see `relayScorecard.ts` for why
 * total delivery overstates a relay's value when relays overlap.
 */

/** Reader-facing names, ordered as rendered. Chips render only when non-zero. */
const CLASS_LABELS: readonly (readonly [ContentClass, string])[] = [
  ["profiles", "profiles"],
  ["notes", "notes"],
  ["longform", "long-form"],
  ["media", "media"],
  ["reactions", "reactions"],
  ["zapReceipts", "zaps"],
  ["privateWraps", "private mail"],
  ["relayLists", "relay lists"],
];

/**
 * One scan for the whole panel, not one per relay row.
 *
 * A settings visit is a moment, not a live surface, so this is a one-shot query
 * on mount rather than a store observer — the numbers do not need to tick while
 * the user reads them, and eight observers per relay row would be real cost for
 * no legibility.
 */
export function useRelayDelivery(): RelayScorecard | undefined {
  const engine = useEngine();
  const [scorecard, setScorecard] = useState<RelayScorecard | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows: StoredEvent[] = [];
        for (const query of scorecardQueries()) {
          rows.push(
            ...(await engine.store.query({
              kinds: [...query.kinds],
              limit: query.limit,
            })),
          );
        }
        if (!cancelled) setScorecard(scoreRows(rows));
      } catch {
        // A store mid-teardown (account switch) leaves the line unrendered,
        // which is the right degradation for a diagnostic.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine]);

  return scorecard;
}

/** The measured line for one relay row. Renders nothing until the scan lands. */
export function RelayDeliveryLine({
  url,
  scorecard,
}: {
  url: string;
  scorecard: RelayScorecard | undefined;
}) {
  if (scorecard === undefined) return null;
  // The scorecard keys are normalised; try both spellings the settings row has.
  const score = scorecard.get(url) ?? scorecard.get(url.replace(/\/+$/, ""));

  if (score === undefined || score.total === 0) {
    return (
      <p className="mt-1 text-2xs text-muted-foreground/80">
        Delivered none of the events this device holds.
      </p>
    );
  }

  const chips = CLASS_LABELS.filter(
    ([cls]) => (score.byClass.get(cls) ?? 0) > 0,
  ).map(
    ([cls, label]) => `${compactCount(score.byClass.get(cls) ?? 0)} ${label}`,
  );

  return (
    <p className="mt-1 text-2xs text-muted-foreground">
      Delivered {chips.join(" · ")}
      {score.exclusive > 0 ? (
        <span className="text-foreground/80">
          {" "}
          — only source for {compactCount(score.exclusive)}
        </span>
      ) : (
        // Stated rather than omitted: "everything it delivered also arrived from
        // elsewhere" is the fact that makes removal safe, and it is invisible in
        // the per-class counts.
        <span> — nothing exclusive</span>
      )}
    </p>
  );
}

/** Caption for the list, naming what the numbers are and are not. */
export function RelayDeliveryCaption() {
  return (
    <p className="text-2xs text-muted-foreground/80">
      Delivery is measured from the newest events this device holds ({" "}
      {SCORED_KINDS.length} kinds sampled) — what each relay actually served,
      not what it advertises. It is a local sample, not a network share.
    </p>
  );
}
