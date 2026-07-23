import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import {
  controllerClient,
  type ControllerConversationParticipant,
} from "../sdk/instafy";

export const CONVERSATION_PARTICIPANTS_REFRESH_INTERVAL_MS = 10_000;

export function conversationParticipantsQueryKey(conversationId: string | null) {
  return ["conversation-participants", conversationId] as const;
}

export function useConversationParticipants(
  conversationId: string | null,
  options: { enabled?: boolean } = {},
) {
  const normalizedConversationId = conversationId?.trim() || null;
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => conversationParticipantsQueryKey(normalizedConversationId),
    [normalizedConversationId],
  );
  const enabled =
    options.enabled !== false &&
    controllerClient.core.enabled &&
    Boolean(normalizedConversationId);
  const participantsQuery = useQuery<ControllerConversationParticipant[]>({
    queryKey,
    enabled,
    queryFn: async () => {
      if (!normalizedConversationId) {
        return [];
      }
      const participants = await controllerClient.conversations.listParticipants({
        conversationId: normalizedConversationId,
        accessToken: null,
      });
      if (participants === null) {
        throw new Error("Unable to refresh conversation participants.");
      }
      return participants;
    },
    refetchInterval: enabled
      ? CONVERSATION_PARTICIPANTS_REFRESH_INTERVAL_MS
      : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const refetchParticipants = participantsQuery.refetch;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }
    const handleControllerReconnect = () => {
      void refetchParticipants();
    };
    window.addEventListener(
      "instafy:controller-stream-reconnected",
      handleControllerReconnect,
    );
    return () => {
      window.removeEventListener(
        "instafy:controller-stream-reconnected",
        handleControllerReconnect,
      );
    };
  }, [enabled, refetchParticipants]);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!enabled) {
        return;
      }
      if (options?.force) {
        await queryClient.refetchQueries({ queryKey, exact: true, type: "active" });
        return;
      }
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
    [enabled, queryClient, queryKey],
  );
  const participantError =
    participantsQuery.error instanceof Error
      ? participantsQuery.error.message
      : null;

  return {
    // Participant names are scoped conversation data. React Query keeps the
    // last successful response after refetch errors, so explicitly fail closed
    // when access may have been revoked.
    participants: participantError ? [] : participantsQuery.data ?? [],
    loading: participantsQuery.isLoading,
    error: participantError,
    refresh,
  };
}
