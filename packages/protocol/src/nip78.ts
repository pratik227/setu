import { dTag } from "./tags";
import type { EventTemplate, Filter, Hex32, NostrEvent } from "./types";

/**
 * NIP-78 application data (kind 30078): a client's own state, kept on relays.
 *
 * The whole point is that there is no server. A client that wants a preference to
 * follow its user to another device has three options: run a backend, ask the user
 * to re-type it, or write it to the relays the user already has. Kind 30078 is the
 * third — addressable, so `(pubkey, kind, d)` names exactly one document and the
 * newest one wins, which is what a settings blob wants.
 *
 * Three decisions in here that are easy to get wrong, and cost real data when they
 * are:
 *
 *  1. **The version lives in `content`, never in the `d` tag.** A `d` of
 *     `setu/settings/v2` is a *different address*, so the moment a build bumps it,
 *     the old build keeps writing to the old address and the two silently diverge —
 *     the user changes a setting on their laptop, their phone never sees it, and
 *     nothing anywhere reports a problem. One address forever; the version inside
 *     tells a reader how to interpret what it finds.
 *  2. **Unknown keys survive a write.** A newer build's document will be opened by
 *     an older build, and an older build that rebuilds the object from the fields it
 *     knows deletes everything it does not. Same hazard as editing a kind 0, same
 *     rule: merge, never rebuild.
 *  3. **`content` is encrypted.** Kind 30078 is a public event. Which relays you
 *     read, what you have muted, how you have configured your client is a
 *     behavioural fingerprint, and publishing it in the clear hands anyone watching
 *     the relay a profile of a user who only asked for their theme to follow them
 *     around. NIP-44 to *yourself* is the standard trick: the conversation key from
 *     your own key to your own pubkey is derivable by nobody else.
 *
 * This module is the mechanism only. It has no opinion about what an application
 * puts in the document — that belongs to the application, which is the only layer
 * that knows what its own keys mean.
 */

/** NIP-78 arbitrary application data. Addressable: newest per `(pubkey, d)`. */
export const APP_DATA_KIND = 30078;

/**
 * The key carrying the document's schema version.
 *
 * Short because it is written on every save, and reserved: an application must
 * never use `v` for one of its own fields, or a version bump becomes unreadable.
 */
export const APP_DATA_VERSION_KEY = "v";

export class AppDataError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AppDataError";
    this.code = code;
  }
}

/**
 * A REQ for one account's copy of one document.
 *
 * `limit` is a required argument rather than a default. A filter without one asks
 * the relay for everything it has matching, and there is no such thing as a query
 * in this app that is allowed to be unbounded.
 */
export function appDataFilter(
  pubkey: Hex32,
  identifier: string,
  limit: number,
): Filter {
  return {
    kinds: [APP_DATA_KIND],
    authors: [pubkey],
    "#d": [identifier],
    limit,
  };
}

/** True when `event` is this application's document and not somebody else's. */
export function isAppData(event: NostrEvent, identifier: string): boolean {
  return event.kind === APP_DATA_KIND && dTag(event) === identifier;
}

/**
 * Which of two candidates a relay will keep for an addressable coordinate.
 *
 * Newest `created_at` wins, and on a tie the **lowest id** wins — that is NIP-01's
 * rule, not an arbitrary one, and reproducing it locally matters: a client that
 * tie-breaks the other way believes it holds the current document while every relay
 * serves the other one, so its next write is built from a copy that no longer
 * exists anywhere.
 */
export function replacesAppData(
  candidate: NostrEvent,
  current: NostrEvent | undefined,
): boolean {
  if (!current) return true;
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at;
  }
  return candidate.id < current.id;
}

/**
 * Build the kind-30078 for a document.
 *
 * `previous` is carried through for everything but the `d` tag. Tags on an app-data
 * event are not currently used by Setu, which is exactly why they must be preserved:
 * a tag this build does not understand belongs to something else, and dropping it on
 * save is the same silent deletion as dropping an unknown content key.
 */
export function appDataTemplate({
  identifier,
  content,
  previous,
}: {
  readonly identifier: string;
  readonly content: string;
  readonly previous?: NostrEvent | undefined;
}): EventTemplate {
  const preserved = (previous?.tags ?? [])
    .filter((tag) => tag[0] !== "d")
    .map((tag) => [...tag]);
  return {
    kind: APP_DATA_KIND,
    content,
    tags: [["d", identifier], ...preserved],
  };
}

/**
 * Encrypt a document to yourself.
 *
 * A signer without NIP-44 cannot do this, and that is reported as a distinct code
 * rather than an empty result: "your extension cannot encrypt this" and "you have no
 * settings stored" are different facts, and showing the second when the first is
 * true invites the user to overwrite a document they simply could not read.
 */
export async function encryptAppData(
  signer: {
    pubkey(): Promise<Hex32>;
    nip44Encrypt?(peer: Hex32, plaintext: string): Promise<string>;
  },
  plaintext: string,
): Promise<string> {
  const encrypt = signer.nip44Encrypt;
  if (!encrypt) {
    throw new AppDataError(
      "no-nip44",
      "This signer cannot encrypt, so settings cannot be saved to relays.",
    );
  }
  const self = await signer.pubkey();
  return encrypt.call(signer, self, plaintext);
}

/**
 * True for content that is a bare JSON object rather than a NIP-44 payload.
 *
 * A NIP-44 v2 payload is base64 of a leading version byte `0x02`, so it always
 * starts with `A`; JSON always starts with `{`. Cheap, unambiguous, and the reason
 * it exists is compatibility in one direction only: a document written in the clear
 * (by an older build, or by another client that never encrypted) is still *readable*
 * here rather than being reported as corrupt. Setu never writes one.
 */
export function looksLikePlaintextJson(content: string): boolean {
  return content.trimStart().startsWith("{");
}

/**
 * Decrypt a document written by this account, for this account.
 *
 * The peer is the event's own `pubkey` — self-encryption — so this only ever reads
 * documents the signed-in key wrote. There is no case where a NIP-78 document
 * belongs to somebody else and is ours to read.
 */
export async function decryptAppData(
  signer: {
    nip44Decrypt?(peer: Hex32, ciphertext: string): Promise<string>;
  },
  event: NostrEvent,
): Promise<string> {
  if (looksLikePlaintextJson(event.content)) return event.content;
  const decrypt = signer.nip44Decrypt;
  if (!decrypt) {
    throw new AppDataError(
      "no-nip44",
      "This signer cannot decrypt, so stored settings cannot be read.",
    );
  }
  try {
    return await decrypt.call(signer, event.pubkey, event.content);
  } catch {
    // The underlying error is not attached: it comes from a crypto library and
    // says nothing a reader can act on. What matters is *which* failure this is,
    // and the code carries that.
    throw new AppDataError(
      "undecryptable",
      "The stored settings could not be decrypted with this key.",
    );
  }
}

/** A parsed document: its version, and every key except the version. */
export interface ParsedAppData {
  readonly version: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Parse a document body.
 *
 * Returns `undefined` for anything that is not a JSON object, and for a missing or
 * non-integer version. A document with no version is not treated as version 1: we
 * would be guessing at the meaning of its keys, and guessing wrong writes a
 * plausible-looking document over a real one.
 */
export function parseAppDataJson(json: string): ParsedAppData | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const object = parsed as Record<string, unknown>;
  const version = object[APP_DATA_VERSION_KEY];
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return undefined;
  }
  const fields: Record<string, unknown> = { ...object };
  delete fields[APP_DATA_VERSION_KEY];
  return { version, fields };
}

/**
 * Serialize a document body.
 *
 * The version goes in first so a human looking at a decrypted blob sees it before
 * anything else; key order is otherwise whatever the caller built, and callers
 * compare *documents*, never their serializations, for that reason.
 */
export function serializeAppDataJson(
  version: number,
  fields: Readonly<Record<string, unknown>>,
): string {
  const body: Record<string, unknown> = { [APP_DATA_VERSION_KEY]: version };
  for (const [key, value] of Object.entries(fields)) {
    if (key === APP_DATA_VERSION_KEY) continue;
    body[key] = value;
  }
  return JSON.stringify(body);
}
