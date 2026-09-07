import { useCallback } from "react";
import { useStudioPerformanceContent } from "./useStudioPerformanceContent";
import { studioPerformance } from "./studioPerformance";

/** A local empty placeholder is not ready until destination discovery settles. */
export function useStudioChatPerformance({
  projectId,
  organizationId,
  conversationId,
  messageCount,
  projectInitialized,
  projectAccessPending,
  conversationListResolved,
  initialHistoryLoading,
  error,
  enabled,
  selectedConversationId = conversationId,
}: {
  projectId: string | null;
  organizationId: string | null;
  conversationId: string | null;
  messageCount: number;
  projectInitialized: boolean;
  projectAccessPending: boolean;
  conversationListResolved: boolean;
  initialHistoryLoading: boolean;
  error: boolean;
  enabled: boolean;
  selectedConversationId?: string | null;
}) {
  const selectionPending = selectedConversationId !== conversationId;
  useStudioPerformanceContent({
    projectId,
    organizationId,
    conversationId,
    messageCount,
    loading: selectionPending || !projectInitialized || projectAccessPending || !conversationListResolved || initialHistoryLoading,
    error: !selectionPending && projectInitialized && !projectAccessPending && error,
  }, enabled);
  return useCallback(() => {
    if (enabled && projectId && conversationId) studioPerformance.beginConversation(projectId, conversationId);
  }, [conversationId, enabled, projectId]);
}
