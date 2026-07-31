/**
 * NIP-38 user statuses: the short line an account sets about itself right now.
 *
 * Kind 30315, addressable, with the `d` tag naming *which* status this is —
 * `general` for a free-text line and `music` for what they are listening to. The
 * content is the line; a `r` tag may carry a link that goes with it.
 *
 * ## Why expiry is the interesting part
 *
 * A status is a claim about the present tense, and the spec's answer to staleness is
 * NIP-40: the author sets an `expiration` and the status stops being true. A client
 * that ignores it shows "at the airport ✈️" for eight months, which is worse than
 * showing nothing — it is the profile stating something false on the author's behalf.
 *
 * Setu gets most of this for free: the store already refuses expired events at ingest
 * and hides them from reads (`expiration.ts`), so an expired status never reaches a
 * screen. {@link isStatusExpired} exists anyway, for the case the store cannot cover —
 * an event held since before its deadline passed, in a tab left open.
 *
 * ## What is deliberately not trusted
 *
 * **An empty status is a cleared status, not a missing one.** Clearing is done by
 * publishing a kind-30315 with empty content, because deletion of a replaceable event
 * is unreliable. So `""` has to be distinguishable from "we hold no status", and
 * {@link parseUserStatus} returns `undefined` for the second while returning a parsed
 * status with `content: ""` for the first — the caller renders nothing either way, but
 * only one of them should stop it looking.
 *
 * **The `r` tag is not rendered as a link without being checked.** It is an arbitrary
 * string from a stranger, and `javascript:` in an `href` is the oldest trick there is.
 */

import { Kind } from "./kinds";
import type { NostrEvent } from "./types";

/** The status kinds NIP-38 names. Others are ignored rather than guessed at. */
export type UserStatusKind = "general" | "music";

const STATUS_KINDS: readonly UserStatusKind[] = ["general", "music"];

export interface UserStatus {
  /** Which status this is, from the `d` tag. */
  readonly kind: UserStatusKind;
  /** The line itself. Empty string means the author cleared it. */
  readonly content: string;
  /** A safe `https:`/`http:` link from the `r` tag, when there is one. */
  readonly link?: string;
  /** NIP-40 deadline in unix seconds, when the author set one. */
  readonly expiresAt?: number;
  readonly createdAt: number;
}

/** `https:` and `http:` only. See the module doc on the `r` tag. */
function safeLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function asStatusKind(value: string | undefined): UserStatusKind | undefined {
  return STATUS_KINDS.includes(value as UserStatusKind)
    ? (value as UserStatusKind)
    : undefined;
}

/**
 * Parse a kind-30315 into a status, or `undefined` when it is not one.
 *
 * `undefined` means "this event is not a status we can render", which is not the same
 * as "this account has no status" — see the module doc. A status whose `d` tag names
 * something outside the spec is rejected rather than shown as `general`, because
 * displaying a music status in the general slot puts a line the author wrote for one
 * context into another.
 */
export function parseUserStatus(event: NostrEvent): UserStatus | undefined {
  if (event.kind !== Kind.UserStatus) return undefined;

  let dTag: string | undefined;
  let link: string | undefined;
  let expiresAt: number | undefined;
  for (const tag of event.tags) {
    switch (tag[0]) {
      case "d":
        dTag ??= tag[1];
        break;
      case "r":
        link ??= safeLink(tag[1]);
        break;
      case "expiration": {
        const parsed = Number(tag[1]);
        if (Number.isFinite(parsed) && parsed > 0) {
          expiresAt ??= Math.floor(parsed);
        }
        break;
      }
      default:
        break;
    }
  }

  const kind = asStatusKind(dTag);
  if (kind === undefined) return undefined;

  return {
    kind,
    // Trimmed: a status is one line, and trailing newlines from a composer would
    // otherwise change the layout of a profile header.
    content: event.content.trim(),
    ...(link !== undefined ? { link } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    createdAt: event.created_at,
  };
}

/**
 * True when a status has passed its own deadline.
 *
 * `now` is passed in rather than read, so this stays pure and so a test does not have
 * to sleep. A status with no `expiration` never expires — that is the author saying it
 * is open-ended, not an omission to fill in with a default.
 */
export function isStatusExpired(status: UserStatus, now: number): boolean {
  return status.expiresAt !== undefined && status.expiresAt <= now;
}

/**
 * The status worth showing, from every kind-30315 held for one account.
 *
 * Picks the newest *per `d` tag*, then prefers `general` over `music`: the general
 * line is the one the author wrote deliberately, while a music status is usually
 * written by a player on their behalf. Expired and empty statuses are dropped here so
 * a caller cannot render one by forgetting to check.
 */
export function currentUserStatus(
  events: readonly NostrEvent[],
  now: number,
): UserStatus | undefined {
  const newest = new Map<UserStatusKind, UserStatus>();
  for (const event of events) {
    const status = parseUserStatus(event);
    if (status === undefined) continue;
    if (status.content === "") continue;
    if (isStatusExpired(status, now)) continue;
    const held = newest.get(status.kind);
    if (held === undefined || status.createdAt > held.createdAt) {
      newest.set(status.kind, status);
    }
  }
  return newest.get("general") ?? newest.get("music");
}
