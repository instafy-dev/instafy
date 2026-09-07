import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../providers/AuthProvider";
import { removeOtherAccountsConversationHistory, retainConversationHistoryCache } from "./conversationHistoryCache";
import { studioPerformance } from "../telemetry/studioPerformance";

/** Lives outside Studio so sign-out also releases history after Studio unmounts. */
export function ConversationHistoryCacheLifecycle() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const previousUserId = useRef(userId);
  useEffect(() => retainConversationHistoryCache(queryClient), [queryClient]);
  useEffect(() => {
    if (!loading) {
      if (previousUserId.current !== null && previousUserId.current !== userId) studioPerformance.clear();
      previousUserId.current = userId;
      removeOtherAccountsConversationHistory(queryClient, userId);
    }
  }, [loading, queryClient, userId]);
  return null;
}
