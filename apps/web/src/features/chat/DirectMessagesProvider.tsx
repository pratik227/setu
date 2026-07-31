import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useSession } from "../identity/SessionProvider";
import { countUnreadConversations } from "./unreadConversations";
import {
  type DirectMessagesApi,
  useDirectMessagesState,
  useReadMarks,
} from "./useDirectMessages";

/**
 * The private-message inbox, held open for the whole app.
 *
 * ## Why this is not a screen concern
 *
 * A subscription that only exists while its screen is mounted is not an inbox, it is a
 * refresh button. The gift-wrap REQ lived in `ChatScreen`, so:
 *
 *  - a message arriving while the user was on Home was not received at all until they
 *    navigated to Messages, which is why there was no unread badge anywhere else — the
 *    only surface that could have counted unread messages was the one you had to open
 *    to find out;
 *  - the decryption cache unmounted with the screen, so every visit to Messages
 *    re-opened the entire inbox from scratch. Two NIP-44 decryptions and a signature
 *    verification per wrap, up to 500 wraps, on every navigation.
 *
 * Both are fixed by the same move: one lease, at the root, for the session.
 *
 * ## What it costs to always be on
 *
 * One REQ to the inbox relays, and one decryption pass per wrap per session rather than
 * per visit. So this is *cheaper* than what it replaces for anyone who opens Messages
 * more than once, and the extra cost for someone who never opens it is a single
 * bounded subscription — the price of the badge being true.
 *
 * ## What is deliberately still local
 *
 * Read marks (`useReadMarks`) live here too, because the badge and the conversation
 * rows have to consult the same marks: a badge counting against its own copy would
 * stay lit after the user read the message. They are persisted per account and never
 * published — NIP-17 has no read receipt, and inventing one would tell a relay exactly
 * when each message was read, which is the metadata the gift wrap exists to hide.
 */

export interface DirectMessagesContextValue extends DirectMessagesApi {
  readonly lastReadAt: ReadonlyMap<string, number>;
  markRead(conversationId: string, at: number): void;
  /** Conversations with an unheard message. Drives the sidebar badge. */
  readonly unreadCount: number;
}

const DirectMessagesContext = createContext<
  DirectMessagesContextValue | undefined
>(undefined);

export function DirectMessagesProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const inbox = useDirectMessagesState();
  const { lastReadAt, markRead } = useReadMarks();

  const unreadCount = useMemo(
    () =>
      countUnreadConversations(
        inbox.conversations,
        session?.pubkey,
        lastReadAt,
      ),
    [inbox.conversations, session?.pubkey, lastReadAt],
  );

  const value = useMemo(
    () => ({ ...inbox, lastReadAt, markRead, unreadCount }),
    [inbox, lastReadAt, markRead, unreadCount],
  );

  return (
    <DirectMessagesContext.Provider value={value}>
      {children}
    </DirectMessagesContext.Provider>
  );
}

/**
 * The app's inbox.
 *
 * Throws without the provider rather than falling back to its own instance: a silent
 * second inbox would decrypt everything twice and keep its own read marks, and the
 * symptom — a badge that disagrees with the list — is subtle enough to ship.
 */
export function useDirectMessages(): DirectMessagesContextValue {
  const value = useContext(DirectMessagesContext);
  if (!value) {
    throw new Error("useDirectMessages requires <DirectMessagesProvider>");
  }
  return value;
}
