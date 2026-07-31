/**
 * Kind-0 metadata parsing.
 *
 * A profile is arbitrary user JSON published to a relay: every field is
 * optional, every field is untrusted, and none of it is guaranteed to be a
 * string. So this is a validator, not a cast — `JSON.parse` results are read
 * field by field and anything of the wrong type is dropped rather than rendered.
 *
 * It lives in one place because two screens need different subsets of the same
 * event (a feed row wants a name and an avatar; a profile header wants a banner,
 * an about and a website), and two parsers for one event shape drift.
 */

/** Raw shape as published. Every field is `unknown` on purpose. */
interface RawProfile {
  readonly name?: unknown;
  readonly display_name?: unknown;
  readonly displayName?: unknown;
  readonly about?: unknown;
  readonly picture?: unknown;
  readonly banner?: unknown;
  readonly nip05?: unknown;
  readonly website?: unknown;
  readonly lud16?: unknown;
  readonly lud06?: unknown;
}

/** Validated kind-0 fields. Absent means "not published or not a string". */
export interface ProfileDetails {
  /** `display_name`/`displayName`, whichever the author published. */
  readonly displayName?: string;
  /** The short `name` field, kept separate — it is the @-handle-ish one. */
  readonly name?: string;
  readonly about?: string;
  readonly picture?: string;
  readonly banner?: string;
  readonly nip05?: string;
  readonly website?: string;
  /** Lightning address (`lud16`) or LNURL (`lud06`), whichever is present. */
  readonly lightning?: string;
}

const EMPTY: ProfileDetails = {};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Only http(s) URLs are accepted for images and links.
 *
 * A profile can put `javascript:` or a `data:` payload in `picture`; handing
 * either to `src`/`href` is a script-injection and a fingerprinting vector
 * respectively. Rejecting at the parser means no call site has to remember.
 */
function asHttpUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a kind-0 `content` string. Returns `{}` for anything unusable. */
export function parseProfileContent(content: string): ProfileDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY;
  const raw = parsed as RawProfile;

  const displayName =
    asString(raw.display_name) ?? asString(raw.displayName) ?? undefined;

  return {
    ...(displayName ? { displayName } : {}),
    ...(asString(raw.name) ? { name: asString(raw.name) } : {}),
    ...(asString(raw.about) ? { about: asString(raw.about) } : {}),
    ...(asHttpUrl(raw.picture) ? { picture: asHttpUrl(raw.picture) } : {}),
    ...(asHttpUrl(raw.banner) ? { banner: asHttpUrl(raw.banner) } : {}),
    ...(asString(raw.nip05) ? { nip05: asString(raw.nip05) } : {}),
    ...(asHttpUrl(raw.website) ? { website: asHttpUrl(raw.website) } : {}),
    ...((asString(raw.lud16) ?? asString(raw.lud06))
      ? { lightning: asString(raw.lud16) ?? asString(raw.lud06) }
      : {}),
  };
}

/** Best display name from parsed details, or undefined when none was published. */
export function preferredName(details: ProfileDetails): string | undefined {
  return details.displayName ?? details.name;
}

export { EMPTY as EMPTY_PROFILE_DETAILS };
