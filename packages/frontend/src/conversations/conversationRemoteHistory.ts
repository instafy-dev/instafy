// How many conversations a space's chat list loads, most recently active first.
export const CONTROLLER_CONVERSATION_LIST_LIMIT = 50;

export function controllerConversationHasRemoteMessages(summary: {
  lastMessageId?: string | null;
  lastMessageAt?: string | null;
}): boolean {
  return (
    (typeof summary.lastMessageId === "string" && summary.lastMessageId.trim().length > 0) ||
    (typeof summary.lastMessageAt === "string" && summary.lastMessageAt.trim().length > 0)
  );
}
