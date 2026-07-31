/**
 * Compact relative timestamps ("4m", "3h", "2d").
 *
 * A timeline shows dozens of these at once, so they must be short and
 * non-jittery. Anything older than a week becomes an absolute date — "63d" is
 * not information anyone uses.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function relativeTime(
  createdAtSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const delta = Math.max(0, nowSeconds - createdAtSeconds);
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d`;

  const date = new Date(createdAtSeconds * 1000);
  const sameYear =
    date.getFullYear() === new Date(nowSeconds * 1000).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full timestamp for the hover title — the exact time must stay reachable. */
export function absoluteTime(createdAtSeconds: number): string {
  return new Date(createdAtSeconds * 1000).toLocaleString();
}

/**
 * A count for an action row, marked as a floor when it may be short.
 *
 * Relay queries are bounded, so a note with more interactions than we asked for
 * yields a number that is genuinely "at least this many". Rendering that as an
 * exact total is fabricated precision — the `+` is the whole difference between a
 * count we can defend and one we cannot.
 */
export function countLabel(n: number, approximate = false): string {
  return approximate ? `${compactCount(n)}+` : compactCount(n);
}

/** Compact count formatting for action rows: 1.2k, 15k, 1.1M. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
