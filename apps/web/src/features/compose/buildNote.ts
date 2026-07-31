/**
 * Turning composer text into a signable event template.
 *
 * Kept as a pure function so the tag rules are testable without a signer, a
 * relay, or React. Every rule here is a protocol requirement that is invisible
 * in the UI but load-bearing for other clients:
 *
 *  - `t` tags are what make a hashtag findable. Text containing `#nostr` with no
 *    `t` tag is not in that hashtag's feed anywhere on the network.
 *  - `p` tags are what make a mention *notify* the person mentioned. Without
 *    them a `nostr:npub…` in the body is decoration.
 *  - `e` tags are the reply's position in its thread, and getting the
 *    root/reply markers wrong is what makes a reply appear as a top-level note
 *    in other clients.
 */

import {
  type EventTemplate,
  type Hex32,
  Kind,
  type NostrEvent,
  rootAndReplyIds,
  tokenizeContent,
} from "@setu/protocol";

export interface ReplyTarget {
  /** The note being replied to. */
  readonly parent: NostrEvent;
  /** Relay hint to advertise for the parent, if known. */
  readonly relayHint?: string;
}

export interface BuildNoteInput {
  readonly content: string;
  readonly reply?: ReplyTarget;
  /** Extra pubkeys to notify, e.g. everyone already in the thread. */
  readonly notify?: readonly Hex32[];
  /** NIP-36 warning reason. An empty string still means "warn". */
  readonly contentWarning?: string;
  /**
   * Tags the caller has already built — `imeta` for attached media, today.
   *
   * Appended rather than merged, and deliberately last: a caller cannot use this
   * to overwrite the `e`/`p` tags that place the note in its thread, because
   * getting those wrong breaks threading for everyone who reads the note.
   */
  readonly extraTags?: readonly (readonly string[])[];
  readonly createdAt?: number;
}

/** Lowercased, deduped hashtags found in the body. */
function hashtagsIn(content: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenizeContent(content)) {
    if (token.type === "hashtag") seen.add(token.tag.toLowerCase());
  }
  return [...seen];
}

/** Pubkeys referenced by `nostr:npub…`/`nostr:nprofile…` mentions in the body. */
function mentionedPubkeys(content: string): Hex32[] {
  const seen = new Set<Hex32>();
  for (const token of tokenizeContent(content)) {
    if (token.type !== "mention") continue;
    const ref = token.entity;
    if (ref.type === "npub" || ref.type === "nprofile") seen.add(ref.pubkey);
  }
  return [...seen];
}

/**
 * Build the `e` tags for a reply, per NIP-10's marked scheme.
 *
 * The parent's *own* thread position decides the root: replying to a reply keeps
 * that reply's root, while replying to a top-level note makes that note the root.
 * Emitting the parent as root in the second case is the common bug — it flattens
 * every sub-thread into one.
 */
function replyTags(reply: ReplyTarget): string[][] {
  const { parent, relayHint } = reply;
  const hint = relayHint ?? "";
  const parentRefs = rootAndReplyIds(parent);
  const rootId = parentRefs.root ?? parent.id;

  if (rootId === parent.id) {
    // Parent is the thread root: one tag, marked both ways per NIP-10.
    return [["e", rootId, hint, "root"]];
  }
  return [
    ["e", rootId, hint, "root"],
    ["e", parent.id, hint, "reply"],
  ];
}

/**
 * Assemble the event template.
 *
 * Tag order is deliberate: `e` tags first (thread position), then `p`, then `t`.
 * Nothing in the protocol requires it, but a stable order makes events
 * diffable and tests meaningful.
 */
export function buildNote(input: BuildNoteInput): EventTemplate {
  const content = input.content.trim();
  const tags: string[][] = [];

  if (input.reply) tags.push(...replyTags(input.reply));

  // Notify the parent's author, everyone the parent notified, anyone mentioned
  // in the body, and any explicit extras — deduped, and never ourselves twice.
  const people = new Set<Hex32>();
  if (input.reply) {
    people.add(input.reply.parent.pubkey);
    for (const tag of input.reply.parent.tags) {
      if (tag[0] === "p" && tag[1]) people.add(tag[1]);
    }
  }
  for (const pubkey of mentionedPubkeys(content)) people.add(pubkey);
  for (const pubkey of input.notify ?? []) people.add(pubkey);
  for (const pubkey of people) tags.push(["p", pubkey]);

  for (const tag of hashtagsIn(content)) tags.push(["t", tag]);

  if (input.contentWarning !== undefined) {
    tags.push(
      input.contentWarning
        ? ["content-warning", input.contentWarning]
        : ["content-warning"],
    );
  }

  // Last, so nothing a caller passes can displace the threading tags above.
  for (const tag of input.extraTags ?? []) tags.push([...tag]);

  return {
    kind: Kind.ShortTextNote,
    content,
    tags,
    ...(input.createdAt !== undefined ? { created_at: input.createdAt } : {}),
  };
}

/** Reaction event (NIP-25). `content` is the emoji, `+` by convention. */
export function buildReaction(target: NostrEvent, emoji = "+"): EventTemplate {
  return {
    kind: Kind.Reaction,
    content: emoji,
    tags: [
      ["e", target.id],
      ["p", target.pubkey],
      ["k", String(target.kind)],
    ],
  };
}

/**
 * Deletion request (NIP-09).
 *
 * Two things this cannot do, and neither is a gap to work around:
 *
 *  - It cannot delete someone else's event. A relay is expected to ignore a
 *    kind-5 whose author is not the target's author, so the *caller* must pass
 *    only events it signed. `useNoteActions` enforces that by finding the events
 *    to delete with `authors: [me]` rather than trusting a view model.
 *  - It cannot guarantee the event is gone. A deletion is a request: relays that
 *    honour it drop the event, relays that do not keep serving it. Setu's own
 *    store treats a tombstone as insert-blocking, so locally it stays gone even
 *    if a relay hands it back — but "deleted" on the network is a hope, not a
 *    fact, and no UI here should claim otherwise.
 *
 * The `k` tags are what let a relay apply the request without holding the target:
 * without them it must have the event to know its kind, and a relay that pruned
 * it cannot enforce the deletion at all.
 */
export function buildDeletion(
  targets: readonly NostrEvent[],
  reason = "",
): EventTemplate {
  const tags: string[][] = [];
  for (const target of targets) tags.push(["e", target.id]);
  for (const kind of new Set(targets.map((target) => target.kind))) {
    tags.push(["k", String(kind)]);
  }
  return { kind: Kind.EventDeletion, content: reason, tags };
}

/** Repost event (NIP-18). Kind 6 for notes, 16 for anything else. */
export function buildRepost(target: NostrEvent, relayHint = ""): EventTemplate {
  const isNote = target.kind === Kind.ShortTextNote;
  return {
    kind: isNote ? Kind.Repost : Kind.GenericRepost,
    // NIP-18 allows embedding the reposted event so clients can render it
    // without a second fetch.
    content: JSON.stringify(target),
    tags: [
      ["e", target.id, relayHint],
      ["p", target.pubkey],
      ...(isNote ? [] : [["k", String(target.kind)]]),
    ],
  };
}
