/**
 * NIP-11 relay information: what a relay can actually do.
 *
 * Until a client reads this, every relay is treated as interchangeable — and they
 * are not. They differ in what NIPs they implement, how many subscriptions they
 * will hold open, how large a `limit` they will honour, how far back they keep
 * events, whether they want payment, and whether they want NIP-42 AUTH. A client
 * that ignores all of that behaves badly in ways that are invisible from the
 * outside, because **relays mostly fail silently**:
 *
 *  - Ask for `limit: 500` from a relay whose `max_limit` is 100 and you get 100.
 *    No error. You conclude there are 100 events; there are more.
 *  - Open a ninth subscription on a relay that allows eight and the ninth is
 *    ignored or the connection is dropped. The screen it belonged to just stays
 *    empty.
 *  - Query a paid relay you have not paid, or an AUTH relay without authenticating,
 *    and you get an empty result set that is indistinguishable from "nothing
 *    matched". This is the single most common reason a Nostr client looks like it
 *    is working while showing nothing.
 *  - Ask a relay that does not implement NIP-45 for a COUNT and it will not answer;
 *    ask for NIP-50 search and you get either nothing or an unfiltered firehose.
 *
 * So the point of this module is not to collect trivia. It is to turn each of those
 * silent failures into a fact the rest of the app can act on: clamp the limit, cap
 * the subscriptions, route the query to a relay that supports it, and *say* when a
 * relay is empty because it wants payment rather than because the network is quiet.
 *
 * Everything here is parsing and policy over data a relay volunteered, so it is
 * pure and tested. Fetching lives in `relayInfoCache.ts`.
 */

/** NIPs whose support changes what we may ask a relay for. */
export const NIP = {
  /** NIP-42 client authentication. */
  Auth: 42,
  /** NIP-45 COUNT — the only honest way to get a total without downloading it. */
  Count: 45,
  /** NIP-50 search. */
  Search: 50,
  /** NIP-11 relay information document. */
  RelayInfo: 11,
  /** NIP-40 expiration timestamps. */
  Expiration: 40,
  /** NIP-70 protected events. */
  Protected: 70,
  /** NIP-59 gift wrap — needed for private messages to be deliverable. */
  GiftWrap: 59,
  /** NIP-17 private direct messages. */
  PrivateDirectMessages: 17,
} as const;

/** What a relay says about the ceilings it enforces. */
export interface RelayLimitation {
  /** Largest `limit` the relay will honour. Larger requests are silently capped. */
  readonly maxLimit?: number;
  /** Concurrent subscriptions per connection. */
  readonly maxSubscriptions?: number;
  /** Filters allowed in one REQ. */
  readonly maxFilters?: number;
  readonly maxMessageLength?: number;
  readonly maxEventTags?: number;
  readonly maxContentLength?: number;
  /** Proof-of-work difficulty required to publish. */
  readonly minPowDifficulty?: number;
  /** The relay will answer nothing useful until NIP-42 AUTH completes. */
  readonly authRequired?: boolean;
  /** The relay will answer nothing useful without a paid account. */
  readonly paymentRequired?: boolean;
  /** Reads are restricted even if writes are not. */
  readonly restrictedWrites?: boolean;
  /** Oldest and newest `created_at` the relay accepts, relative to now. */
  readonly createdAtLowerLimit?: number;
  readonly createdAtUpperLimit?: number;
}

export interface RelayInfo {
  /** Normalised relay URL this document describes. */
  readonly url: string;
  readonly name?: string;
  readonly description?: string;
  /** Operator's pubkey, if published. */
  readonly pubkey?: string;
  readonly contact?: string;
  readonly software?: string;
  readonly version?: string;
  readonly supportedNips: readonly number[];
  readonly limitation: RelayLimitation;
  /** Free-form policy links the operator published. */
  readonly paymentsUrl?: string;
  readonly icon?: string;
  /** Languages the relay says its content is in, as BCP-47 tags. */
  readonly languageTags?: readonly string[];
  /** Topics the operator says the relay is for. */
  readonly tags?: readonly string[];
}

/** A number, or undefined if the value was absent or not a usable number. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}

/** Only defined keys, so `undefined` never overwrites a later default. */
function defined<T extends object>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * Parse a relay's NIP-11 document.
 *
 * Every field is optional and every field is untrusted: this is JSON from a server
 * we do not control, and a relay that returns `max_limit: "lots"` or
 * `supported_nips: null` must not break the client. Anything unusable is dropped
 * rather than defaulted, because "the relay did not say" and "the relay said zero"
 * lead to opposite decisions — a missing `max_limit` means use our own bound, while
 * `max_limit: 0` would mean ask for nothing.
 */
export function parseRelayInfo(url: string, body: unknown): RelayInfo {
  const doc =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const rawLimitation =
    typeof doc.limitation === "object" && doc.limitation !== null
      ? (doc.limitation as Record<string, unknown>)
      : {};

  const limitation: RelayLimitation = defined({
    maxLimit: num(rawLimitation.max_limit),
    maxSubscriptions: num(rawLimitation.max_subscriptions),
    maxFilters: num(rawLimitation.max_filters),
    maxMessageLength: num(rawLimitation.max_message_length),
    maxEventTags: num(rawLimitation.max_event_tags),
    maxContentLength: num(rawLimitation.max_content_length),
    minPowDifficulty: num(rawLimitation.min_pow_difficulty),
    authRequired: bool(rawLimitation.auth_required),
    paymentRequired: bool(rawLimitation.payment_required),
    restrictedWrites: bool(rawLimitation.restricted_writes),
    createdAtLowerLimit: num(rawLimitation.created_at_lower_limit),
    createdAtUpperLimit: num(rawLimitation.created_at_upper_limit),
  });

  const nips = Array.isArray(doc.supported_nips)
    ? [
        ...new Set(
          doc.supported_nips.filter(
            (nip): nip is number => typeof nip === "number",
          ),
        ),
      ].sort((a, b) => a - b)
    : [];

  return defined({
    url,
    name: str(doc.name),
    description: str(doc.description),
    pubkey: str(doc.pubkey),
    contact: str(doc.contact),
    software: str(doc.software),
    version: str(doc.version),
    supportedNips: nips,
    limitation,
    paymentsUrl: str(doc.payments_url),
    icon: str(doc.icon),
    languageTags: strings(doc.language_tags),
    tags: strings(doc.tags),
  });
}

/** Does the relay claim this NIP? Unknown documents claim nothing. */
export function supports(info: RelayInfo | undefined, nip: number): boolean {
  return info?.supportedNips.includes(nip) ?? false;
}

/**
 * Clamp a requested limit to what the relay will actually honour.
 *
 * The reason this exists rather than being left to the relay: a relay that caps
 * silently gives you a *truncated* result set with no indication it was truncated.
 * Asking for exactly what you can get means a short answer means "that is all there
 * is", which is the only way `exhausted` can be trusted for pagination.
 */
export function clampLimit(
  requested: number,
  info: RelayInfo | undefined,
): number {
  const ceiling = info?.limitation.maxLimit;
  if (ceiling === undefined || ceiling <= 0) return requested;
  return Math.min(requested, ceiling);
}

/** Our own ceiling on concurrent subscriptions when a relay names none. */
export const DEFAULT_MAX_SUBSCRIPTIONS = 10;

/**
 * How many subscriptions we may hold on this relay.
 *
 * One is reserved below the relay's stated maximum. Relays count AUTH challenges
 * and internal subscriptions against the same budget in some implementations, and
 * the failure mode for going over is not an error — it is the relay dropping the
 * connection or ignoring the REQ, which reads to the user as a screen that never
 * loads.
 */
export function subscriptionBudget(info: RelayInfo | undefined): number {
  const stated = info?.limitation.maxSubscriptions;
  if (stated === undefined || stated <= 0) return DEFAULT_MAX_SUBSCRIPTIONS;
  return Math.max(1, Math.min(stated - 1, DEFAULT_MAX_SUBSCRIPTIONS));
}

/** Why a relay might return nothing despite being reachable. */
export type RelayGate = "payment-required" | "auth-required" | "none";

/**
 * The reason this relay may be answering with silence.
 *
 * Worth surfacing verbatim in the UI. "No notes yet" is the wrong thing to show
 * someone whose relay is waiting for them to log in or pay, and it is the single
 * most misleading state a Nostr client can present — the network looks dead when
 * in fact one door is shut.
 */
export function relayGate(info: RelayInfo | undefined): RelayGate {
  if (info?.limitation.authRequired) return "auth-required";
  if (info?.limitation.paymentRequired) return "payment-required";
  return "none";
}

/** What a relay is well suited to, from what it advertises. */
export interface RelaySuitability {
  /** Answers COUNT, so it can give totals without downloading them. */
  readonly counts: boolean;
  /** Implements NIP-50, so `Filter.search` means something there. */
  readonly search: boolean;
  /** Can carry gift-wrapped private messages. */
  readonly privateMessages: boolean;
  /** Reachable without paying or authenticating first. */
  readonly openToRead: boolean;
}

export function suitability(info: RelayInfo | undefined): RelaySuitability {
  return {
    counts: supports(info, NIP.Count),
    search: supports(info, NIP.Search),
    // A relay must handle NIP-59 wrapping to be useful for DMs; NIP-17 support is
    // the stronger signal and implies it.
    privateMessages:
      supports(info, NIP.PrivateDirectMessages) || supports(info, NIP.GiftWrap),
    openToRead: relayGate(info) === "none",
  };
}

/**
 * Pick relays for a purpose, best-suited first.
 *
 * Relays that advertise the capability come first, then relays we know nothing
 * about, and relays we know *cannot* do it are dropped entirely. Unknown relays are
 * kept rather than excluded because a missing NIP-11 document is common — plenty of
 * working relays do not serve one — and treating silence as refusal would shrink
 * the usable set to whichever relays happen to be chatty about themselves.
 */
export function relaysFor(
  purpose: keyof RelaySuitability,
  urls: readonly string[],
  infos: ReadonlyMap<string, RelayInfo>,
): readonly string[] {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const url of urls) {
    const info = infos.get(url);
    if (info === undefined) {
      unknown.push(url);
      continue;
    }
    if (suitability(info)[purpose]) known.push(url);
  }
  return [...known, ...unknown];
}
