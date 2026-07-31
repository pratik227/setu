/**
 * NIP-05 verification: the network half, with a TTL cache and a request gate.
 *
 * Three constraints shape this module.
 *
 * 1. **A feed wants dozens of verifications at once.** Each one is a request to
 *    a *different* third-party domain, so an unthrottled pass over a timeline is
 *    a burst of cross-origin requests that competes with relay traffic for
 *    sockets. Work goes through a small queue with a fixed concurrency.
 * 2. **A result must expire.** An identifier can be revoked, and a domain that
 *    was down should be retried. Successes are cached longer than failures,
 *    because a failure is more often transient (offline, CORS, 5xx) than a
 *    success is wrong.
 * 3. **Failure is never a pass.** Every path that cannot produce a confirmed
 *    round trip resolves `"failed"`. There is no "unknown, assume ok".
 *
 * The cache is module-scoped rather than per-component: verification is a
 * property of an (identifier, pubkey) pair, not of a screen, and re-checking on
 * every mount is exactly what makes verified badges flicker.
 */

import {
  type Nip05Address,
  nip05MatchesPubkey,
  nip05WellKnownUrl,
  parseNip05,
} from "./nip05";

/** Outcome of a completed check. Never "probably". */
export type Nip05Outcome = "verified" | "failed";

/** How long a confirmed round trip is trusted. */
const VERIFIED_TTL_MS = 30 * 60 * 1000;
/** How long a failure is remembered before retrying the domain. */
const FAILED_TTL_MS = 5 * 60 * 1000;
/** Per-request timeout: a hanging well-known must not pin a queue slot. */
const REQUEST_TIMEOUT_MS = 6000;
/** Concurrent well-known requests across the whole app. */
const MAX_CONCURRENCY = 4;
/** Cache ceiling, so a long session cannot grow it without bound. */
const MAX_ENTRIES = 2000;
/** Guard against a domain returning a huge body instead of a small JSON map. */
const MAX_BODY_BYTES = 256 * 1024;

interface CacheEntry {
  readonly outcome: Nip05Outcome;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Nip05Outcome>>();

let active = 0;
const queue: (() => void)[] = [];

/** Injection seam for tests and for callers that need a custom transport. */
export interface Nip05FetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

function cacheKey(pubkey: string, identifier: string): string {
  return `${pubkey.toLowerCase()}|${identifier.trim().toLowerCase()}`;
}

function remember(key: string, outcome: Nip05Outcome, now: number): void {
  if (cache.size >= MAX_ENTRIES) {
    // Insertion-ordered map: the oldest key is the first one. A precise LRU
    // would need per-read bookkeeping this does not earn.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, {
    outcome,
    expiresAt: now + (outcome === "verified" ? VERIFIED_TTL_MS : FAILED_TTL_MS),
  });
}

/** The cached outcome for a pair, or undefined when absent or expired. */
export function cachedNip05(
  pubkey: string,
  identifier: string,
  now: number = Date.now(),
): Nip05Outcome | undefined {
  const key = cacheKey(pubkey, identifier);
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry.outcome;
}

/** Drops every cached result. For tests and for account switches. */
export function clearNip05Cache(): void {
  cache.clear();
  inFlight.clear();
}

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      active += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  active -= 1;
  const next = queue.shift();
  if (next) next();
}

/** Reads a capped amount of text, so a hostile domain cannot stream forever. */
async function readCapped(response: Response): Promise<string | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return undefined;
  const body = await response.text();
  return body.length > MAX_BODY_BYTES ? undefined : body;
}

async function checkAddress(
  address: Nip05Address,
  pubkey: string,
  fetchImpl: typeof fetch,
): Promise<Nip05Outcome> {
  const signal =
    typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;

  const response = await fetchImpl(nip05WellKnownUrl(address), {
    // No credentials, ever: this is a public document, and sending cookies to a
    // third-party domain on a profile's instruction is a tracking vector.
    credentials: "omit",
    redirect: "follow",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) return "failed";

  const body = await readCapped(response);
  if (body === undefined) return "failed";
  return nip05MatchesPubkey(body, address.local, pubkey)
    ? "verified"
    : "failed";
}

/**
 * Verify that `identifier`'s domain maps back to `pubkey`.
 *
 * Resolves from cache when fresh, coalesces concurrent callers onto one request,
 * and never throws: a network error, timeout, CORS rejection or bad response all
 * resolve `"failed"`.
 */
export function verifyNip05(
  pubkey: string,
  identifier: string,
  options: Nip05FetchOptions = {},
): Promise<Nip05Outcome> {
  const now = options.now ?? Date.now;
  const key = cacheKey(pubkey, identifier);

  const cached = cachedNip05(pubkey, identifier, now());
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  const address = parseNip05(identifier);
  if (address === undefined) {
    // An unparseable identifier is a failed claim, not a missing one — the
    // profile asserted something that cannot be checked.
    remember(key, "failed", now());
    return Promise.resolve("failed");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    remember(key, "failed", now());
    return Promise.resolve("failed");
  }

  const work = (async (): Promise<Nip05Outcome> => {
    await acquireSlot();
    try {
      return await checkAddress(address, pubkey, fetchImpl);
    } catch {
      return "failed";
    } finally {
      releaseSlot();
    }
  })().then((outcome) => {
    remember(key, outcome, now());
    inFlight.delete(key);
    return outcome;
  });

  inFlight.set(key, work);
  return work;
}
