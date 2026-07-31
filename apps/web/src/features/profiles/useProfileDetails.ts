/**
 * One author's kind-0, read from the store.
 *
 * `useAuthors` deliberately narrows a profile to what a feed row needs. A profile
 * screen needs the rest — banner, about, website, lightning address — so this
 * hook reads the same event through the same parser and hands back every field.
 * It does not become a second cache: the store is still the source, and the
 * result is derived on each change rather than accumulated.
 */

import { Kind } from "@setu/protocol";
import { useEffect, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import {
  EMPTY_PROFILE_DETAILS,
  type ProfileDetails,
  parseProfileContent,
} from "./profileContent";

export interface ProfileMetadata {
  readonly details: ProfileDetails;
  /** False until a kind-0 for this author has actually arrived. */
  readonly loaded: boolean;
  /** `created_at` of the event shown, so a header can date the profile. */
  readonly updatedAt?: number;
}

const EMPTY: ProfileMetadata = {
  details: EMPTY_PROFILE_DETAILS,
  loaded: false,
};

/**
 * Observe an author's profile metadata.
 *
 * `loaded` is separate from "details has fields" on purpose: an author who
 * published an empty kind-0 and an author whose kind-0 has not arrived yet
 * produce the same empty object but need opposite UI — the first is a real, bare
 * profile, the second is still loading.
 */
export function useProfileDetails(pubkey: string): ProfileMetadata {
  const engine = useEngine();
  const [metadata, setMetadata] = useState<ProfileMetadata>(EMPTY);

  useEffect(() => {
    setMetadata(EMPTY);
    if (pubkey.length === 0) return;

    // The batcher fetches kind 0 *and* kind 10002 together, and routes through
    // the outbox router. Asking it rather than opening a subscription here is
    // what keeps a profile visit from costing a dedicated relay subscription.
    engine.profiles.request([pubkey]);

    const unobserve = engine.store.observe(
      { kinds: [Kind.Metadata], authors: [pubkey] },
      (events) => {
        // The store enforces replaceable last-write-wins, so row 0 is newest.
        const newest = events[0]?.event;
        if (!newest) return;
        setMetadata({
          details: parseProfileContent(newest.content),
          loaded: true,
          updatedAt: newest.created_at,
        });
      },
    );

    return unobserve;
  }, [engine, pubkey]);

  return metadata;
}
