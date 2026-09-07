import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ConversationState } from "./conversationState";

interface ConversationMessageMetadata {
  extraAgentHandles: string[];
  resolveConversationLocalId: (controllerId: string) => string | null;
}

const emptyMetadata: ConversationMessageMetadata = {
  extraAgentHandles: [],
  resolveConversationLocalId: () => null,
};
const ConversationMessageMetadataContext = createContext(emptyMetadata);

type MessageConversation = Pick<ConversationState, "localId" | "controllerId" | "extraAgentHandles">;

/** Message bodies need navigation and mention metadata, never composer or history state. */
export function ConversationMessageMetadataProvider({
  conversations,
  activeConversationId,
  children,
}: {
  conversations: readonly MessageConversation[];
  activeConversationId: string | null;
  children: ReactNode;
}) {
  // Projecting these small fields once keeps the context stable when a draft,
  // unread counter, run, or message changes the full conversation objects.
  const navigationKey = JSON.stringify(conversations.map(({ controllerId, localId }) => [controllerId, localId]));
  const handlesKey = JSON.stringify(
    conversations.find((conversation) => conversation.localId === activeConversationId)?.extraAgentHandles ?? [],
  );
  const resolveConversationLocalId = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const [controllerId, localId] of JSON.parse(navigationKey) as Array<[string | null, string]>) {
      if (controllerId && !lookup.has(controllerId)) lookup.set(controllerId, localId);
    }
    return (controllerId: string) => lookup.get(controllerId) ?? null;
  }, [navigationKey]);
  const extraAgentHandles = useMemo(() => JSON.parse(handlesKey) as string[], [handlesKey]);
  const value = useMemo(() => ({ extraAgentHandles, resolveConversationLocalId }), [extraAgentHandles, resolveConversationLocalId]);
  return <ConversationMessageMetadataContext.Provider value={value}>{children}</ConversationMessageMetadataContext.Provider>;
}

export function useConversationMessageMetadata(): ConversationMessageMetadata {
  return useContext(ConversationMessageMetadataContext);
}
