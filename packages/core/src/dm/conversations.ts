import { type ChatMessage, conversationId, type Hex32 } from "@setu/protocol";

/**
 * Grouping decrypted chat messages into conversations.
 *
 * Pure, and separate from the inbox that decrypts them, because this is where the
 * ordering and dedup rules live and those are the parts worth testing without a
 * relay in the loop.
 *
 * Messages arrive out of order and more than once — the same message reaches us
 * once per relay that carries it, and a conversation loaded from history
 * interleaves with one arriving live. Both are handled by keying on the rumor id,
 * which is content-addressed and therefore identical across every copy.
 */

export interface Conversation {
  /** Derived from the participant set. See `conversationId`. */
  readonly id: string;
  /** Everyone in it, sorted, including the viewer. */
  readonly participants: readonly Hex32[];
  /** Everyone except the viewer — who the conversation is *with*. */
  readonly others: readonly Hex32[];
  /** Oldest first, which is how a conversation is read. */
  readonly messages: readonly ChatMessage[];
  readonly lastMessage: ChatMessage;
  /** `created_at` of the newest message, for sorting the list. */
  readonly updatedAt: number;
  /** Newest `subject` anyone set, when one was set. */
  readonly subject?: string;
}

/**
 * Group messages into conversations, newest conversation first.
 *
 * Deduplicates by rumor id: the same message arrives once per relay carrying it,
 * and a conversation that shows every copy is unusable on a well-connected client.
 *
 * Sorting is by the *rumor's* `created_at`, never the gift wrap's. Wrapper
 * timestamps are deliberately jittered by up to two days to defeat correlation, so
 * sorting by one would shuffle a conversation into nonsense.
 */
export function groupConversations(
  messages: readonly ChatMessage[],
  viewer: Hex32 | undefined,
): readonly Conversation[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of messages) byId.set(message.id, message);

  const groups = new Map<string, ChatMessage[]>();
  for (const message of byId.values()) {
    const id = conversationId(message.participants);
    const bucket = groups.get(id);
    if (bucket) bucket.push(message);
    else groups.set(id, [message]);
  }

  const out: Conversation[] = [];
  for (const [id, bucket] of groups) {
    bucket.sort((a, b) =>
      a.createdAt === b.createdAt
        ? // Ties broken by id so the order is stable across renders rather than
          // depending on which relay answered first.
          a.id.localeCompare(b.id)
        : a.createdAt - b.createdAt,
    );
    const last = bucket[bucket.length - 1];
    if (!last) continue;
    const participants = last.participants;
    // Newest subject wins: renaming a thread should take effect, and the newest
    // message is the most recent statement of what it is called.
    let subject: string | undefined;
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (bucket[i]?.subject) {
        subject = bucket[i]?.subject;
        break;
      }
    }
    out.push({
      id,
      participants,
      others: participants.filter((pubkey) => pubkey !== viewer),
      messages: bucket,
      lastMessage: last,
      updatedAt: last.createdAt,
      ...(subject ? { subject } : {}),
    });
  }

  return out.sort((a, b) =>
    a.updatedAt === b.updatedAt
      ? a.id.localeCompare(b.id)
      : b.updatedAt - a.updatedAt,
  );
}

/**
 * A display name for a conversation, given resolved names.
 *
 * Falls back to the count rather than to a list of truncated pubkeys: "3 people" is
 * more useful than three unreadable hex fragments, and it does not shift as names
 * resolve one at a time.
 */
export function conversationTitle(
  conversation: Conversation,
  nameOf: (pubkey: Hex32) => string | undefined,
): string {
  if (conversation.subject) return conversation.subject;
  const names = conversation.others.map(nameOf);
  const resolved = names.filter((name): name is string => Boolean(name));
  if (conversation.others.length === 0) return "Notes to self";
  if (resolved.length === conversation.others.length) {
    return resolved.join(", ");
  }
  if (conversation.others.length === 1) return "";
  return `${conversation.others.length} people`;
}

/** Conversations with a message the viewer has not seen, by newest first. */
export function unreadConversations(
  conversations: readonly Conversation[],
  viewer: Hex32 | undefined,
  lastReadAt: ReadonlyMap<string, number>,
): readonly Conversation[] {
  return conversations.filter((conversation) => {
    // Our own message never counts as unread — sending something is reading it.
    if (conversation.lastMessage.sender === viewer) return false;
    return conversation.updatedAt > (lastReadAt.get(conversation.id) ?? 0);
  });
}
