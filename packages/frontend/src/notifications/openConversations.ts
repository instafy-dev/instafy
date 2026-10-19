/**
 * Which conversations this tab is showing right now, and a signal that the
 * durable notification feed saw a reply in one of them.
 *
 * The open chat normally learns about a reply from one controller SSE event.
 * That stream has no replay, and the chat's own history poll pauses while the
 * tab is idle or hidden, so a single missed event used to leave the chat stale
 * while the notification poll (which keeps running) showed "There is a new
 * reply in your conversation." for the very conversation on screen. The
 * notification center now announces each new reply here so the open chat
 * re-reads its newest page once, and it does not toast a reply for a
 * conversation the user is already looking at.
 */
export const CONVERSATION_REPLY_NOTIFIED_EVENT = "instafy:conversation-reply-notified";

export interface ConversationReplyNotifiedDetail {
  conversationIds: string[];
}

const openCounts = new Map<string, number>();

function normalize(conversationId: string): string {
  return conversationId.trim().toLowerCase();
}

/** Marks a conversation as shown in a visible chat surface until the returned cleanup runs. */
export function registerOpenConversation(conversationId: string): () => void {
  const key = normalize(conversationId);
  if (!key) return () => {};
  openCounts.set(key, (openCounts.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (openCounts.get(key) ?? 1) - 1;
    if (next > 0) openCounts.set(key, next);
    else openCounts.delete(key);
  };
}

export function isConversationOpen(conversationId: string | null | undefined): boolean {
  return Boolean(conversationId) && openCounts.has(normalize(conversationId!));
}

export function announceConversationReplies(conversationIds: Iterable<string>): void {
  if (typeof window === "undefined") return;
  const unique = [...new Set([...conversationIds].map(normalize).filter(Boolean))];
  if (!unique.length) return;
  window.dispatchEvent(new CustomEvent<ConversationReplyNotifiedDetail>(CONVERSATION_REPLY_NOTIFIED_EVENT, {
    detail: { conversationIds: unique },
  }));
}

/** Test-only reset. */
export function resetOpenConversationsForTests(): void {
  openCounts.clear();
}
