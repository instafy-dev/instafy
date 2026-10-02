import type { ConversationState } from "./conversationState";

/** Follow cached ancestry from controller-authorized internal identities. */
export function collectInternalConversationIds(
  conversations: readonly Pick<ConversationState, "localId" | "controllerId" | "parentConversationId">[],
  internalControllerIds: Iterable<string>,
): Set<string> {
  const identities = new Map<string, (typeof conversations)[number]>();
  const children = new Map<string, (typeof conversations)[number][]>();
  conversations.forEach((conversation) => {
    identities.set(conversation.localId, conversation);
    if (conversation.controllerId) identities.set(conversation.controllerId, conversation);
    if (conversation.parentConversationId) {
      const siblings = children.get(conversation.parentConversationId) ?? [];
      siblings.push(conversation);
      children.set(conversation.parentConversationId, siblings);
    }
  });
  const internal = new Set(internalControllerIds);
  const pending = [...internal];
  const remember = (id: string | null) => {
    if (id && !internal.has(id)) {
      internal.add(id);
      pending.push(id);
    }
  };
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const id = pending[cursor];
    const conversation = identities.get(id);
    if (conversation) {
      remember(conversation.localId);
      remember(conversation.controllerId);
    }
    children.get(id)?.forEach((child) => {
      remember(child.localId);
      remember(child.controllerId);
    });
  }
  return internal;
}
