import { parseRelayInfo, type RelayInfo } from "./relayInfo";

/**
 * Fetching and caching NIP-11 documents.
 *
 * Separated from `relayInfo.ts` so the parsing and policy stay pure and testable
 * while the network side stays small enough to read in one go.
 *
 * Three properties this has to have:
 *
 *  - **One request per relay, ever, per session.** The document changes about as
 *    often as the operator redeploys. Re-fetching it per query would add an HTTP
 *    round trip to every screen for information that does not move.
 *  - **Failure is cached too.** Most relays that do not serve a document will never
 *    serve one, and retrying on every call turns one missing endpoint into a steady
 *    stream of failed requests in the console. A miss is remembered as "asked, got
 *    nothing" — which is a different state from "not asked", and the difference is
 *    what stops the retry loop.
 *  - **A slow relay must not hold anything up.** Capability data makes queries
 *    better; it is never required to make them at all. Everything here is
 *    best-effort behind a timeout, and every consumer takes `undefined` for an
 *    answer.
 */

/** How long to wait for a relay's document before giving up on it. */
const FETCH_TIMEOUT_MS = 5000;

/** `wss://relay.example/` -> `https://relay.example/`, per NIP-11. */
export function infoUrl(relayUrl: string): string | undefined {
  try {
    const url = new URL(relayUrl);
    url.protocol = url.protocol === "ws:" ? "http:" : "https:";
    // The document lives at the relay's own root, not a sub-path.
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export interface RelayInfoCacheOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly onError?: (relay: string, error: unknown) => void;
}

/**
 * Session-lifetime cache of relay capabilities.
 *
 * `get` is synchronous and returns whatever is known right now, so a render path
 * can consult it without awaiting. `load` is the async side, and is safe to call
 * repeatedly — concurrent calls for one relay share a single request.
 */
export class RelayInfoCache {
  private readonly infos = new Map<string, RelayInfo>();
  /** Relays we asked and got nothing usable from. Not the same as never asked. */
  private readonly missing = new Set<string>();
  private readonly inFlight = new Map<string, Promise<RelayInfo | undefined>>();
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly onError?: (relay: string, error: unknown) => void;

  constructor(options: RelayInfoCacheOptions = {}) {
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    if (options.onError) this.onError = options.onError;
  }

  /** What is known now. Never blocks, never fetches. */
  get(relayUrl: string): RelayInfo | undefined {
    return this.infos.get(relayUrl);
  }

  /** Everything known, for a settings screen or a diagnostics panel. */
  all(): ReadonlyMap<string, RelayInfo> {
    return this.infos;
  }

  /** True once we have either a document or a definitive miss. */
  isResolved(relayUrl: string): boolean {
    return this.infos.has(relayUrl) || this.missing.has(relayUrl);
  }

  /** Fetch a relay's document unless it is already known or already failed. */
  async load(relayUrl: string): Promise<RelayInfo | undefined> {
    const known = this.infos.get(relayUrl);
    if (known) return known;
    if (this.missing.has(relayUrl)) return undefined;
    const pending = this.inFlight.get(relayUrl);
    if (pending) return pending;

    const request = this.fetchInfo(relayUrl).finally(() => {
      this.inFlight.delete(relayUrl);
    });
    this.inFlight.set(relayUrl, request);
    return request;
  }

  /** Load many at once. Resolves when all have settled, successful or not. */
  async loadAll(relayUrls: readonly string[]): Promise<void> {
    await Promise.all(relayUrls.map((url) => this.load(url)));
  }

  private async fetchInfo(relayUrl: string): Promise<RelayInfo | undefined> {
    const target = infoUrl(relayUrl);
    if (target === undefined) {
      this.missing.add(relayUrl);
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(target, {
        // The header is what distinguishes this from a request for the relay's
        // landing page; without it many relays return HTML.
        headers: { Accept: "application/nostr+json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.missing.add(relayUrl);
        return undefined;
      }
      const info = parseRelayInfo(relayUrl, await response.json());
      this.infos.set(relayUrl, info);
      return info;
    } catch (error) {
      // Remembered as a miss rather than left unresolved: most relays without a
      // document will never have one, and retrying turns one missing endpoint into
      // a steady stream of failed requests.
      this.missing.add(relayUrl);
      this.onError?.(relayUrl, error);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
