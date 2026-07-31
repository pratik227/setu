import type { Conversation } from "@setu/core";

/**
 * What counts as an unread conversation.
 *
 * Extracted because two surfaces now ask the question — the row in the conversation
 * list and the badge on the sidebar — and two copies of this rule would eventually
 * disagree, which shows up as a badge saying 1 above a list with nothing marked. The
 * badge is the more damaging half of that: a count that will not clear is a client
 * telling the user they have mail they cannot find.
 *
 * Two conditions, and the first is the one that is easy to forget:
 *
 *  - **Our own last message does not make a conversation unread.** Sending is reading.
 *    Without this every conversation the user has just replied in comes back bold, and
 *    the badge counts the user's own messages back to them.
 *  - **The mark is compared against the conversation's newest message**, not against
 *    each message. `Conversation.updatedAt` is that timestamp, and `markRead` is
 *    monotonic, so re-opening an old conversation cannot un-read a newer one.
 *
 * Note what is *not* consulted: the wrap's `created_at`. NIP-59 jitters it backwards
 * by up to two days on purpose, so it is not a reliable clock — and a gift wrap does
 * not name its sender, so nothing outside the decrypted rumor can tell an incoming
 * message from a copy of one we sent. That is why there is no cheap
 * count-the-wraps shortcut for this badge, and why the inbox has to be decrypted
 * before the number means anything.
 */
export function isConversationUnread(
  conversation: Conversation,
  viewerPubkey: string | undefined,
  lastReadAt: ReadonlyMap<string, number>,
): boolean {
  if (conversation.lastMessage.sender === viewerPubkey) return false;
  return conversation.updatedAt > (lastReadAt.get(conversation.id) ?? 0);
}

/** How many conversations are unread. Drives the sidebar badge. */
export function countUnreadConversations(
  conversations: readonly Conversation[],
  viewerPubkey: string | undefined,
  lastReadAt: ReadonlyMap<string, number>,
): number {
  let count = 0;
  for (const conversation of conversations) {
    if (isConversationUnread(conversation, viewerPubkey, lastReadAt)) {
      count += 1;
    }
  }
  return count;
}
