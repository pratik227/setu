import { computeEventId } from "./event";
import { Kind } from "./kinds";
import { generateSecretKey, LocalSigner } from "./signers/local";
import type { EventTemplate, Hex32, NostrEvent, NostrSigner } from "./types";

/**
 * NIP-59 gift wrap: hiding who is talking to whom.
 *
 * Three layers, and the reason for each:
 *
 *  1. **Rumor** — the real message (a kind-14 chat message), *unsigned*. It has no
 *     signature because a signature is a permanent, publishable proof that you
 *     wrote something. A private message should not come with one: if a recipient
 *     leaks the conversation, an unsigned rumor is deniable and a signed event is
 *     not.
 *  2. **Seal** (kind 13) — the rumor, encrypted to the recipient and *signed by the
 *     sender*. This is where authenticity lives. The seal never touches a relay on
 *     its own.
 *  3. **Gift wrap** (kind 1059) — the seal, encrypted with a fresh throwaway key
 *     and signed by that key. This is the only layer a relay sees, and its
 *     `pubkey` belongs to a key used once and discarded, so the sender is invisible.
 *     Only the recipient's `p` tag is exposed, because delivery requires it.
 *
 * ## The check that matters
 *
 * `unwrap` verifies that **the rumor's `pubkey` equals the seal's `pubkey`**. Skip
 * it and the whole scheme collapses: the seal proves who sealed it, but the rumor
 * inside is just JSON, so a sender could seal a rumor claiming any author they
 * like and the message would display as coming from someone else. That is the
 * standard implementation mistake in gift-wrap code, and it turns private
 * messaging into an impersonation tool.
 *
 * ## Timestamps
 *
 * Both the seal and the wrap get a `created_at` randomised *backwards* by up to two
 * days. Not decoration: relays and anyone watching them can otherwise correlate a
 * wrap to a recipient's wrap of the same message by the second they arrived, which
 * re-identifies both ends of a conversation the encryption just hid.
 */

/** How far back a seal or wrap timestamp may be nudged, in seconds. */
export const MAX_TIMESTAMP_JITTER_SECONDS = 2 * 24 * 60 * 60;

/**
 * An unsigned event. `id` is computed so the recipient can reference it; there is
 * deliberately no `sig`.
 */
export interface Rumor extends EventTemplate {
  readonly id: Hex32;
  readonly pubkey: Hex32;
  readonly created_at: number;
  /**
   * Required here, unlike on `EventTemplate`.
   *
   * `toRumor` always materialises the array, and readers walk it for participants
   * and reply targets. Leaving it optional pushed a `| undefined` into every
   * caller for a case that cannot occur.
   */
  readonly tags: readonly (readonly string[])[];
}

export class GiftWrapError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GiftWrapError";
    this.code = code;
  }
}

/** A timestamp jittered into the past. Injected randomness keeps this testable. */
export function jitteredTimestamp(
  now: number,
  random: () => number = Math.random,
): number {
  return Math.floor(now - random() * MAX_TIMESTAMP_JITTER_SECONDS);
}

/** Turn a template into a rumor: authored, addressable, unsigned. */
export function toRumor(
  template: EventTemplate,
  pubkey: Hex32,
  createdAt: number,
): Rumor {
  const base = {
    kind: template.kind,
    content: template.content,
    tags: (template.tags ?? []).map((tag) => [...tag]),
    created_at: template.created_at ?? createdAt,
    pubkey,
  };
  return { ...base, id: computeEventId(base) };
}

export interface SealInput {
  readonly rumor: Rumor;
  readonly recipient: Hex32;
  readonly signer: NostrSigner;
  readonly now: number;
  readonly random?: () => number;
}

/**
 * Seal a rumor to one recipient.
 *
 * Requires a signer that can do NIP-44. A signer without it cannot participate in
 * private messaging at all, and saying so plainly beats failing later with a
 * decryption error the reader cannot interpret.
 */
export async function seal({
  rumor,
  recipient,
  signer,
  now,
  random,
}: SealInput): Promise<NostrEvent> {
  if (!signer.nip44Encrypt) {
    throw new GiftWrapError(
      "no-nip44",
      "This signer cannot encrypt private messages.",
    );
  }
  const content = await signer.nip44Encrypt(recipient, JSON.stringify(rumor));
  return signer.signEvent({
    kind: Kind.Seal,
    content,
    // No tags at all. A seal that named its recipient would leak the one thing
    // the wrap exists to hide, to anyone who ever decrypts the wrap.
    tags: [],
    created_at: jitteredTimestamp(now, random),
  });
}

export interface WrapInput {
  readonly seal: NostrEvent;
  readonly recipient: Hex32;
  readonly now: number;
  readonly random?: () => number;
  /** Injected for tests; production uses a fresh random key every call. */
  readonly ephemeralSecret?: Uint8Array;
}

/**
 * Wrap a seal for one recipient.
 *
 * A new ephemeral key per wrap, never reused — reusing one would link every
 * message sent with it back into a single identity, which is exactly what the
 * ephemeral key exists to prevent.
 */
export async function wrap({
  seal: sealEvent,
  recipient,
  now,
  random,
  ephemeralSecret,
}: WrapInput): Promise<NostrEvent> {
  const secret = ephemeralSecret ?? generateSecretKey();
  const ephemeral = LocalSigner.fromSecretKey(secret);
  const content = await ephemeral.nip44Encrypt(
    recipient,
    JSON.stringify(sealEvent),
  );
  return ephemeral.signEvent({
    kind: Kind.GiftWrap,
    content,
    tags: [["p", recipient]],
    created_at: jitteredTimestamp(now, random),
  });
}

export interface GiftWrapInput {
  readonly template: EventTemplate;
  /** Everyone who should receive it. The sender is included by the caller. */
  readonly recipients: readonly Hex32[];
  readonly signer: NostrSigner;
  readonly now: number;
  readonly random?: () => number;
}

/**
 * Seal and wrap one message for every recipient.
 *
 * One wrap *per recipient*, each sealed separately, because each is encrypted to a
 * different key. That includes the sender: a gift wrap addressed to anyone else is
 * unreadable to its own author, so without a copy wrapped to yourself your sent
 * messages vanish the moment you close the app. Clients that forgot this shipped
 * with write-only conversations.
 */
export async function giftWrap({
  template,
  recipients,
  signer,
  now,
  random,
}: GiftWrapInput): Promise<readonly NostrEvent[]> {
  const author = await signer.pubkey();
  const rumor = toRumor(template, author, now);
  const unique = [...new Set(recipients)];
  const wraps: NostrEvent[] = [];
  for (const recipient of unique) {
    const sealed = await seal({ rumor, recipient, signer, now, random });
    wraps.push(await wrap({ seal: sealed, recipient, now, random }));
  }
  return wraps;
}

/** Anything that arrived claiming to be a rumor, before we trust its shape. */
function parseRumor(raw: unknown): Rumor {
  if (typeof raw !== "object" || raw === null) {
    throw new GiftWrapError(
      "bad-rumor",
      "The decrypted payload is not an event.",
    );
  }
  const candidate = raw as Record<string, unknown>;
  const { kind, content, tags, created_at: createdAt, pubkey, id } = candidate;
  if (
    typeof kind !== "number" ||
    typeof content !== "string" ||
    !Array.isArray(tags) ||
    typeof createdAt !== "number" ||
    typeof pubkey !== "string" ||
    typeof id !== "string"
  ) {
    throw new GiftWrapError("bad-rumor", "The decrypted event is malformed.");
  }
  if ("sig" in candidate) {
    // A rumor with a signature is not a rumor. Accepting one would let a sender
    // hand the recipient a publishable, non-deniable event, which is the property
    // this scheme exists to remove.
    throw new GiftWrapError(
      "signed-rumor",
      "A private message arrived carrying a signature, which is not allowed.",
    );
  }
  return {
    kind,
    content,
    tags: (tags as unknown[]).map((tag) =>
      Array.isArray(tag) ? tag.map((part) => String(part)) : [],
    ),
    created_at: createdAt,
    pubkey,
    id,
  };
}

export interface UnwrapResult {
  readonly rumor: Rumor;
  /** The sender, taken from the seal — the only signed statement of authorship. */
  readonly sender: Hex32;
  /** `created_at` of the gift wrap, which is jittered and not the message time. */
  readonly wrapCreatedAt: number;
}

/**
 * Unwrap a gift wrap into the message inside it.
 *
 * The order of checks is the security argument:
 *
 *  1. Decrypt the wrap with the recipient's key. Failure here means it was not for
 *     us, which is normal and not an error worth surfacing.
 *  2. Verify the **seal's signature**. This is the only proof of who wrote the
 *     message; the wrap's signature only proves a throwaway key signed it, which
 *     tells us nothing.
 *  3. Verify **rumor.pubkey === seal.pubkey**. Without this a sender can attribute
 *     their message to anyone.
 */
export async function unwrap(
  giftWrapEvent: NostrEvent,
  signer: NostrSigner,
  verify: (event: NostrEvent) => Promise<boolean> | boolean,
): Promise<UnwrapResult> {
  if (!signer.nip44Decrypt) {
    throw new GiftWrapError(
      "no-nip44",
      "This signer cannot read private messages.",
    );
  }
  if (giftWrapEvent.kind !== Kind.GiftWrap) {
    throw new GiftWrapError("not-a-wrap", "That event is not a gift wrap.");
  }

  const sealJson = await signer.nip44Decrypt(
    giftWrapEvent.pubkey,
    giftWrapEvent.content,
  );
  let sealEvent: NostrEvent;
  try {
    sealEvent = JSON.parse(sealJson) as NostrEvent;
  } catch {
    throw new GiftWrapError("bad-seal", "The wrapped payload is not JSON.");
  }
  if (sealEvent?.kind !== Kind.Seal) {
    throw new GiftWrapError("bad-seal", "The wrapped payload is not a seal.");
  }

  // The seal's signature is the authorship proof. The wrap's is worthless here —
  // it proves only that some throwaway key signed the envelope.
  if (!(await verify(sealEvent))) {
    throw new GiftWrapError(
      "bad-seal-signature",
      "The seal inside that message has an invalid signature.",
    );
  }

  const rumorJson = await signer.nip44Decrypt(
    sealEvent.pubkey,
    sealEvent.content,
  );
  let rumor: Rumor;
  try {
    rumor = parseRumor(JSON.parse(rumorJson));
  } catch (error) {
    if (error instanceof GiftWrapError) throw error;
    throw new GiftWrapError("bad-rumor", "The sealed payload is not JSON.");
  }

  if (rumor.pubkey !== sealEvent.pubkey) {
    throw new GiftWrapError(
      "author-mismatch",
      "That message claims an author who did not seal it.",
    );
  }

  return {
    rumor,
    sender: sealEvent.pubkey,
    wrapCreatedAt: giftWrapEvent.created_at,
  };
}
