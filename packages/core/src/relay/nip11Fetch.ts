import type { RelayLimitation } from "./relayInfo";

/** The subset of a NIP-11 document the connection cares about. */
export interface Nip11Document {
  readonly limitation?: {
    readonly max_subscriptions?: number;
    readonly max_filters?: number;
  };
}

export type FetchNip11 = (
  httpUrl: string,
) => Promise<Nip11Document | undefined>;

/**
 * Fetching a relay's NIP-11 document over HTTP.
 *
 * Kept apart from the pool because it is the one place the pool leaves WebSockets
 * for HTTP, and because the failure policy is different: a socket that will not
 * open is a problem worth reporting, whereas a relay with no NIP-11 endpoint is
 * simply a relay that did not volunteer anything about itself. Plenty of working
 * relays serve nothing here, and a CORS rejection is the norm rather than the
 * exception, so every failure is swallowed and the caller carries on with defaults.
 */

type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Default NIP-11 fetcher: `globalThis.fetch`, or a no-op where unavailable. */
export const defaultFetchNip11: FetchNip11 = async (httpUrl) => {
  const fetchImpl = (globalThis as { fetch?: FetchLike }).fetch;
  if (fetchImpl === undefined) return undefined;
  const response = await fetchImpl(httpUrl, {
    // Without this header most relays return their landing page instead.
    headers: { Accept: "application/nostr+json" },
  });
  if (!response.ok) return undefined;
  const body = await response.json();
  if (typeof body !== "object" || body === null) return undefined;
  return body as Nip11Document;
};

/**
 * Read the connection ceilings out of a relay's NIP-11 document and apply them.
 *
 * Only `max_subscriptions` and `max_filters` are taken here — they are the two the
 * *connection* enforces. The richer picture (supported NIPs, payment and auth
 * gates, `max_limit`) belongs to `RelayInfoCache`, which serves the UI and the
 * query planner rather than the socket.
 *
 * Every failure is swallowed. A relay that volunteers nothing about itself is a
 * relay we talk to with defaults, not one we stop talking to.
 */
export async function applyNip11Limits(options: {
  readonly httpUrl: string;
  readonly fetcher: FetchNip11;
  readonly apply: (limits: RelayLimitation) => void;
  readonly onError?: (error: unknown) => void;
}): Promise<void> {
  try {
    const info = await options.fetcher(options.httpUrl);
    const limitation = info?.limitation;
    if (limitation === undefined) return;
    const limits: { maxSubscriptions?: number; maxFilters?: number } = {};
    if (typeof limitation.max_subscriptions === "number") {
      limits.maxSubscriptions = limitation.max_subscriptions;
    }
    if (typeof limitation.max_filters === "number") {
      limits.maxFilters = limitation.max_filters;
    }
    options.apply(limits as RelayLimitation);
  } catch (error) {
    options.onError?.(error);
  }
}
