import type { EventTemplate, NostrEvent } from "@setu/protocol";
import { Kind } from "@setu/protocol";

/**
 * Editing a profile (kind 0) without discarding what you did not edit.
 *
 * Kind 0 is replaceable and its `content` is a JSON object with no fixed schema.
 * Clients invent fields freely — `lud16`, `banner`, `website`, `bot`, `birthday`,
 * `pronouns`, and plenty that only one client knows about. Rebuilding the object
 * from the fields *this* form happens to show deletes every one of them.
 *
 * That failure is quiet and permanent: a reader edits their display name in Setu,
 * and their lightning address and banner vanish everywhere, with no error and
 * nothing to undo. So the rule here is a **merge, never a rebuild** — parse what is
 * there, change only the keys the form owns, and write the rest back untouched.
 *
 * The same holds for tags. A kind 0 may carry tags (some clients put `alt` or
 * NIP-39 external identities there), and a rebuild that emits none deletes them.
 */

/** The fields this form owns. Anything else in the profile is passed through. */
export interface ProfileFields {
  readonly name?: string;
  readonly display_name?: string;
  readonly about?: string;
  readonly picture?: string;
  readonly banner?: string;
  readonly website?: string;
  readonly nip05?: string;
  readonly lud16?: string;
}

/** Keys the editor may change. Everything else is preserved verbatim. */
export const EDITABLE_KEYS = [
  "name",
  "display_name",
  "about",
  "picture",
  "banner",
  "website",
  "nip05",
  "lud16",
] as const satisfies readonly (keyof ProfileFields)[];

export type ProfileEditRefusal = "unverified-absence" | "no-change";

export type ProfileEditResult =
  | { readonly ok: true; readonly template: EventTemplate }
  | { readonly ok: false; readonly reason: ProfileEditRefusal };

/** Parse a kind-0's content, tolerating anything that is not a JSON object. */
export function parseProfileObject(
  event: NostrEvent | undefined,
): Record<string, unknown> {
  if (!event || event.kind !== Kind.Metadata) return {};
  try {
    const parsed: unknown = JSON.parse(event.content);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A profile with unparseable content still exists, and overwriting it is the
    // reader's decision to make by editing — not a silent consequence of us
    // failing to read it.
    return {};
  }
}

/** The editable fields of a profile, as strings for a form. */
export function profileFields(event: NostrEvent | undefined): ProfileFields {
  const object = parseProfileObject(event);
  const out: Record<string, string> = {};
  for (const key of EDITABLE_KEYS) {
    const value = object[key];
    if (typeof value === "string") out[key] = value;
  }
  return out as ProfileFields;
}

export interface ProfileEditInput {
  /** The newest kind-0 we could find, or undefined if none exists. */
  readonly current: NostrEvent | undefined;
  /**
   * True only when every queried relay answered and none held a profile.
   *
   * Without it, publishing from an empty form because the fetch had not landed
   * would erase a profile the reader never saw.
   */
  readonly absenceConfirmed: boolean;
  readonly fields: ProfileFields;
}

export function editProfile({
  current,
  absenceConfirmed,
  fields,
}: ProfileEditInput): ProfileEditResult {
  if (!current && !absenceConfirmed) {
    return { ok: false, reason: "unverified-absence" };
  }

  // Start from what is already published, so every key this form does not know
  // about survives the write.
  const merged = { ...parseProfileObject(current) };
  for (const key of EDITABLE_KEYS) {
    const value = fields[key];
    if (value === undefined) continue;
    const trimmed = value.trim();
    // An emptied field is a deletion, and deleting the key is cleaner than
    // publishing `""` — an empty string is a value other clients will render.
    if (trimmed === "") delete merged[key];
    else merged[key] = trimmed;
  }

  const content = JSON.stringify(merged);
  if (current && content === current.content) {
    return { ok: false, reason: "no-change" };
  }

  return {
    ok: true,
    template: {
      kind: Kind.Metadata,
      content,
      // Tags carried through: some clients keep `alt` or NIP-39 identities here,
      // and emitting none would delete them.
      tags: (current?.tags ?? []).map((tag) => [...tag]),
    },
  };
}
