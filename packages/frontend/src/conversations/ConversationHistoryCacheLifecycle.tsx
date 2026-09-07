import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../providers/AuthProvider";
import { removeOtherAccountsConversationHistory, retainConversationHistoryCache } from "./conversationHistoryCache";

/** Lives outside Studio so sign-out also releases history after Studio unmounts. */
export function ConversationHistoryCacheLifecycle() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  useEffect(() => retainConversationHistoryCache(queryClient), [queryClient]);
  useEffect(() => {
    if (!loading) removeOtherAccountsConversationHistory(queryClient, userId);
  }, [loading, queryClient, userId]);
  return null;
}
