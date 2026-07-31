/**
 * React binding for {@link InterestSet}: a grow-only id set, published on a policy.
 *
 * The pattern this replaces is the one every id-driven query starts as — derive the
 * ids from what is on screen, put them in a filter, key an effect on the result. On
 * a live surface that closes and reopens the REQ faster than a relay can answer, so
 * the data the ids were for never arrives. See `InterestSet` for the two failure
 * modes either side of the fix.
 *
 * The returned array is reference-stable between publishes, so it is safe to build
 * a filter from it inside a `useMemo`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { type InterestPolicy, InterestSet } from "./interestSet";

/** How long a burst of new ids may accumulate before the set is published. */
const SETTLE_MS = 500;

const NONE: readonly string[] = [];

export function useInterestIds(
  ids: readonly string[],
  policy: InterestPolicy,
  /**
   * Identity of what the interest belongs to — an account pubkey, usually.
   * Changing it discards everything accumulated, because ids gathered for one
   * account are not interest the next one expressed.
   */
  scopeKey: string,
): readonly string[] {
  const interest = useMemo(
    () => new InterestSet(policy),
    // `policy` is a module constant at every call site; `scopeKey` is what
    // actually resets the accumulated set.
    [policy, scopeKey],
  );
  const [published, setPublished] = useState<readonly string[]>(NONE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset during render rather than in an effect: one paint showing the previous
  // account's ids is one paint of the wrong data.
  const [scope, setScope] = useState(scopeKey);
  if (scope !== scopeKey) {
    setScope(scopeKey);
    setPublished(NONE);
  }

  // Content identity, so a caller rebuilding its array every render does not
  // re-register the same interest.
  const key = useMemo(() => [...new Set(ids)].sort().join(","), [ids]);

  useEffect(() => {
    interest.want(key === "" ? NONE : key.split(","));

    // Leading schedule. A pending timer is left alone: re-arming it on every
    // change is a livelock on a busy surface, where ids arrive faster than the
    // delay.
    if (timer.current !== null) return;
    const delay = interest.delayUntilPublishable(Date.now());
    if (delay === undefined) return;
    timer.current = setTimeout(
      () => {
        timer.current = null;
        // The wait was computed for this moment, so it is publishable now; the
        // guard is for the case where the policy's requirement grew meanwhile.
        if (!interest.shouldPublish(Date.now())) return;
        setPublished(interest.publish(Date.now()));
      },
      Math.max(SETTLE_MS, delay),
    );
  }, [interest, key]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  return published;
}
