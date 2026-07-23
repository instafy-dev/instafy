import type { ConversationState } from "../../../conversations/ConversationsProvider";

export interface HomeRecentConversationNavigationEntry {
  projectId: string;
  conversationId: string | null;
  localConversationId: string | null;
}

export type HomeRecentConversationNavigationTarget =
  | { kind: "local"; localConversationId: string }
  | { kind: "route"; projectId: string; conversationControllerId: string | null };

export function resolveHomeRecentConversationNavigationTarget(params: {
  activeProjectId: string | null;
  conversations: ConversationState[];
  entry: HomeRecentConversationNavigationEntry;
}): HomeRecentConversationNavigationTarget {
  const { activeProjectId, conversations, entry } = params;

  if (entry.projectId === activeProjectId) {
    const explicitLocalId = entry.localConversationId?.trim() ?? "";
    if (explicitLocalId) {
      return { kind: "local", localConversationId: explicitLocalId };
    }

    const controllerId = entry.conversationId?.trim() ?? "";
    if (controllerId) {
      const localMatch =
        conversations.find((conversation) => (conversation.controllerId ?? "").trim() === controllerId) ?? null;
      if (localMatch) {
        return { kind: "local", localConversationId: localMatch.localId };
      }
      return {
        kind: "route",
        projectId: entry.projectId,
        conversationControllerId: controllerId,
      };
    }
  }

  return {
    kind: "route",
    projectId: entry.projectId,
    conversationControllerId: entry.conversationId?.trim() || null,
  };
}
