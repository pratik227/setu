import { Kind } from "./kinds";
import type { Rumor } from "./nip59";
import type { EventTemplate, Hex32, NostrEvent } from "./types";

/**
 * NIP-17 private direct messages, on top of NIP-59 gift wrap.
 *
 * A chat message is a kind-14 *rumor* — an unsigned event that only ever exists
 * inside a seal inside a gift wrap. It never reaches a relay in the clear and it
 * never carries a signature, so a leaked conversation is deniable. `nip59.ts` owns
 * the wrapping; this module owns what goes inside it and how to read it back.
 *
 * Two shapes matter to the app:
 *
 *  - **Participants.** A kind-14 names every participant with `p` tags, *excluding*
 *    the author, who is identified by the rumor's own `pubkey`. Reconstructing the
 *    full set therefore means author + tags, and a client that forgets the author
 *    drops the sender out of their own conversation.
 *  - **Conversation identity.** There is no conversation id on the wire. A thread is
 *    the set of people in it, so the id has to be derived — see
 *    {@link conversationId}.
 */

/** A chat message, as the app sees it after unwrapping. */
export interface ChatMessage {
  /** The rumor's id. Stable, since the rumor is content-addressed. */
  readonly id: Hex32;
  readonly sender: Hex32;
  /** Everyone in the conversation, author included, sorted. */
  readonly participants: readonly Hex32[];
  readonly content: string;
  /** The author's own timestamp, not the jittered wrapper's. */
  readonly createdAt: number;
  /** Rumor id this replies to, when it is a reply. */
  readonly replyTo?: Hex32;
  /** NIP-17 `subject` tag — a thread title, when the sender set one. */
  readonly subject?: string;
  /** True for kind 15, which carries a file rather than prose. */
  readonly isFile: boolean;
}

/**
 * Stable identity for a conversation.
 *
 * Derived from the participant set, sorted, because nothing on the wire carries a
 * conversation id and the same group must resolve to the same thread no matter who
 * sent the message being read. Sorting is what makes it symmetric: without it, a
 * message from Alice to Bob and Bob's reply would land in two different threads.
 *
 * A consequence worth stating: adding or removing a participant produces a
 * *different* conversation. That is the honest reading — a group with a new member
 * is not the same group, and silently merging them would show the new member
 * messages sent before they joined.
 */
export function conversationId(participants: readonly Hex32[]): string {
  return [...new Set(participants)].sort().join(",");
}

/** Participants of a chat rumor: `p` tags plus the author. */
export function chatParticipants(rumor: {
  readonly pubkey: Hex32;
  readonly tags: readonly (readonly string[])[];
}): readonly Hex32[] {
  const out = new Set<Hex32>([rumor.pubkey]);
  for (const tag of rumor.tags) {
    if (tag[0] === "p" && tag[1]) out.add(tag[1] as Hex32);
  }
  return [...out].sort();
}

function tagValue(
  tags: readonly (readonly string[])[],
  name: string,
): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && tag[1]) return tag[1];
  }
  return undefined;
}

/** Is this rumor something this module knows how to display? */
export function isChatRumor(rumor: { readonly kind: number }): boolean {
  return rumor.kind === Kind.ChatMessage || rumor.kind === Kind.ChatFile;
}

/** Read an unwrapped rumor as a chat message, or `undefined` if it is not one. */
export function toChatMessage(rumor: Rumor): ChatMessage | undefined {
  if (!isChatRumor(rumor)) return undefined;
  const replyTo = tagValue(rumor.tags, "e");
  const subject = tagValue(rumor.tags, "subject");
  return {
    id: rumor.id,
    sender: rumor.pubkey,
    participants: chatParticipants(rumor),
    content: rumor.content,
    createdAt: rumor.created_at,
    ...(replyTo ? { replyTo: replyTo as Hex32 } : {}),
    ...(subject ? { subject } : {}),
    isFile: rumor.kind === Kind.ChatFile,
  };
}

export interface ChatMessageInput {
  readonly content: string;
  /** Everyone the message is addressed to. The author is added automatically. */
  readonly to: readonly Hex32[];
  readonly author: Hex32;
  /** Rumor id being replied to. */
  readonly replyTo?: Hex32;
  readonly subject?: string;
  readonly createdAt?: number;
}

/**
 * Build the kind-14 template for a message.
 *
 * The author is excluded from the `p` tags because NIP-17 identifies them by the
 * rumor's `pubkey`; including them as well makes them appear twice in every
 * participant list a naive reader builds.
 *
 * No `imeta`, no hashtag extraction, no mention parsing. A private message is not a
 * note: every tag added here is metadata that survives decryption, so a recipient
 * who leaks the conversation leaks it too. Only what NIP-17 defines goes in.
 */
export function buildChatMessage({
  content,
  to,
  author,
  replyTo,
  subject,
  createdAt,
}: ChatMessageInput): EventTemplate {
  const recipients = [...new Set(to)].filter((pubkey) => pubkey !== author);
  const tags: string[][] = recipients.map((pubkey) => ["p", pubkey]);
  if (replyTo) tags.push(["e", replyTo]);
  if (subject) tags.push(["subject", subject]);
  return {
    kind: Kind.ChatMessage,
    content,
    tags,
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
  };
}

/** Everyone a message must be delivered to: recipients *and* the author. */
export function deliveryTargets(
  author: Hex32,
  to: readonly Hex32[],
): readonly Hex32[] {
  // The author's own copy is not optional. A gift wrap is encrypted to exactly
  // one key, so without a copy addressed to yourself your sent messages are
  // unreadable to you and the conversation is write-only.
  return [...new Set([author, ...to])];
}

/**
 * Relays this account wants private messages delivered to (kind 10050).
 *
 * Deliberately distinct from NIP-65. Where you read public notes and where you
 * want DMs delivered are different questions, and answering the second with the
 * first broadcasts someone's private traffic to every relay they happen to follow
 * a hashtag on.
 *
 * Returns an empty list when there is no kind-10050, and callers must treat that as
 * "this person has not said where to reach them" rather than falling back to the
 * public relay set. Sending a gift wrap somewhere the recipient never reads is not
 * merely useless — it leaves an undeliverable envelope addressed to them on a relay
 * of the *sender's* choosing.
 */
export function parseDmRelayList(
  event: NostrEvent | undefined,
): readonly string[] {
  if (!event || event.kind !== Kind.DirectMessageRelays) return [];
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === "relay" && tag[1]) out.push(tag[1]);
  }
  return [...new Set(out)];
}

/** Build a kind-10050 template naming where to deliver our private messages. */
export function buildDmRelayList(relays: readonly string[]): EventTemplate {
  return {
    kind: Kind.DirectMessageRelays,
    content: "",
    tags: [...new Set(relays)].map((relay) => ["relay", relay]),
  };
}
