/**
 * NIP-05 verification as React state.
 *
 * Render is never blocked and never suspended on this: a badge is an
 * embellishment, and a name that waits for a third-party domain before painting
 * is a worse client than one with a late checkmark. So the hooks return a status
 * immediately — `"unverified"` when nothing has been asked for, `"verifying"`
 * while a check is in flight — and re-render when it settles.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { cachedNip05, verifyNip05 } from "./nip05Cache";

/**
 * Verification state for one (pubkey, identifier) pair.
 *
 * `"unverified"` and `"failed"` are deliberately distinct: the first means no
 * claim was made or none has been checked, the second means a claim was checked
 * and did not hold. Collapsing them would make a revoked identifier
 * indistinguishable from a profile that never had one.
 */
export type Nip05Status = "unverified" | "verifying" | "verified" | "failed";

export interface Nip05Candidate {
  readonly pubkey: string;
  /** The identifier as published in kind 0. */
  readonly identifier: string;
}

const EMPTY: ReadonlyMap<string, Nip05Status> = new Map();

/**
 * Verify many identifiers at once, keyed by pubkey.
 *
 * Each pair is attempted exactly once per mount and never re-armed, so there is
 * no timer to push back and no way for a growing candidate list to starve the
 * work — the failure mode `useAuthors` documents does not arise here. Ordering
 * and throttling live in `nip05Cache`, which is module-scoped, so two screens
 * asking for the same author share one request.
 *
 * `candidates` must be a stable reference (memoize it); a new array every render
 * is harmless for correctness but re-runs the effect body for nothing.
 */
export function useNip05Batch(
  candidates: readonly Nip05Candidate[],
): ReadonlyMap<string, Nip05Status> {
  const [statuses, setStatuses] =
    useState<ReadonlyMap<string, Nip05Status>>(EMPTY);

  const publish = useCallback((pubkey: string, status: Nip05Status) => {
    setStatuses((prev) => {
      if (prev.get(pubkey) === status) return prev;
      const next = new Map(prev);
      next.set(pubkey, status);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    for (const candidate of candidates) {
      const { pubkey, identifier } = candidate;
      if (identifier.trim().length === 0) continue;

      const cached = cachedNip05(pubkey, identifier);
      if (cached !== undefined) {
        publish(pubkey, cached);
        continue;
      }

      publish(pubkey, "verifying");
      void verifyNip05(pubkey, identifier).then((outcome) => {
        if (!cancelled) publish(pubkey, outcome);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [candidates, publish]);

  return statuses;
}

/**
 * Verify one identifier. Returns `"unverified"` when no identifier is claimed.
 */
export function useNip05(pubkey: string, identifier?: string): Nip05Status {
  const candidates = useMemo(
    () =>
      identifier && identifier.trim().length > 0
        ? [{ pubkey, identifier }]
        : [],
    [pubkey, identifier],
  );
  const statuses = useNip05Batch(candidates);
  return statuses.get(pubkey) ?? "unverified";
}
