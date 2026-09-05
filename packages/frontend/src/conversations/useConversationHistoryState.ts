import { useEffect, useMemo, useRef, useCallback } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { controllerClient } from "../sdk/instafy";
import type { RunRecord } from "../types";
import type { ChatMessage } from "../screens/studio/types";
import type { ConversationState } from "./ConversationsProvider";
import { mapControllerMessageToChat, mergeAndSortMessages } from "./conversationMessageUtils";

const ACTIVE_CONVERSATION_HISTORY_REFETCH_INTERVAL_MS = 10_000;
const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "canceled", "merged"]);
const { enabled: runtimeControllerEnabled } = controllerClient.core;
const { listMessages: fetchConversationMessagesFromController } = controllerClient.conversations;

type ConversationMessagesQueryPage = {
  messages: ChatMessage[];
  nextCursor: string | null;
  hasMore: boolean;
  notFound: boolean;
  accessDenied: boolean;
};

interface UseConversationHistoryStateArgs {
  activeConversation: ConversationState | null;
  currentUserId: string | null;
  runs: Record<string, RunRecord>;
  setConversationControllerId: (conversationId: string, controllerId: string | null) => void;
  replaceMessages: (conversationId: string, messages: ChatMessage[]) => void;
}

export function useConversationHistoryState({
  activeConversation,
  currentUserId,
  runs,
  setConversationControllerId,
  replaceMessages,
}: UseConversationHistoryStateArgs) {
  const queryClient = useQueryClient();
  const controllerConversationId = activeConversation?.controllerId ?? null;
  const controllerMessagesQuery = useInfiniteQuery<ConversationMessagesQueryPage>({
    queryKey: ["conversation-messages", currentUserId, controllerConversationId],
    enabled: runtimeControllerEnabled && Boolean(currentUserId) && Boolean(controllerConversationId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      if (!controllerConversationId || !currentUserId) {
        return { messages: [], nextCursor: null, hasMore: false, notFound: false, accessDenied: false };
      }
      const cursor =
        typeof pageParam === "string" && pageParam.trim().length > 0 ? pageParam : null;
      const page = await fetchConversationMessagesFromController({
        conversationId: controllerConversationId,
        cursor: cursor ?? undefined,
        accessToken: null,
      });
      if (page === "not_found" || page === "access_denied") {
        return {
          messages: [],
          nextCursor: null,
          hasMore: false,
          notFound: page === "not_found",
          accessDenied: page === "access_denied",
        };
      }
      if (!page) {
        // A transient auth/network failure is not an empty conversation. Keep
        // cached history visible and let the query's normal retry recover it.
        throw new Error("Unable to load conversation history.");
      }
      return {
        messages: (page.messages ?? []).map(mapControllerMessageToChat),
        nextCursor: page.nextCursor ?? null,
        hasMore: page.hasMore,
        notFound: false,
        accessDenied: false,
      };
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) {
        return undefined;
      }
      return lastPage.nextCursor ?? undefined;
    },
    staleTime: 0,
    refetchInterval:
      runtimeControllerEnabled && currentUserId && controllerConversationId
        ? ACTIVE_CONVERSATION_HISTORY_REFETCH_INTERVAL_MS
        : false,
    refetchIntervalInBackground: true,
  });

  const controllerHistoryNotFound = useMemo(() => {
    return (controllerMessagesQuery.data?.pages ?? []).some((page) => page.notFound);
  }, [controllerMessagesQuery.data?.pages]);
  const controllerHistoryAccessDenied = useMemo(() => {
    return (controllerMessagesQuery.data?.pages ?? []).some((page) => page.accessDenied);
  }, [controllerMessagesQuery.data?.pages]);

  useEffect(() => {
    if (!controllerHistoryNotFound && !controllerHistoryAccessDenied) {
      return;
    }
    if (!activeConversation?.controllerId) {
      return;
    }
    if (controllerHistoryAccessDenied) {
      // Clear every cached page and any local/SSE copies after an explicit
      // denial; a later network error must not resurrect revoked history.
      queryClient.removeQueries({
        queryKey: ["conversation-messages", currentUserId, activeConversation.controllerId],
        exact: true,
      });
      replaceMessages(activeConversation.localId, []);
    }
    setConversationControllerId(activeConversation.localId, null);
  }, [
    activeConversation?.controllerId,
    activeConversation?.localId,
    controllerHistoryNotFound,
    controllerHistoryAccessDenied,
    currentUserId,
    queryClient,
    replaceMessages,
    setConversationControllerId,
  ]);

  const messages = useMemo(() => {
    if (controllerHistoryAccessDenied || (controllerConversationId && !currentUserId)) {
      return [];
    }
    const localMessages = activeConversation?.messages ?? [];
    const historyMessages = (controllerMessagesQuery.data?.pages ?? []).flatMap((page) => page.messages ?? []);
    if (localMessages.length === 0 && historyMessages.length === 0) {
      return [];
    }
    return mergeAndSortMessages([...historyMessages, ...localMessages]);
  }, [
    activeConversation?.messages,
    controllerConversationId,
    controllerHistoryAccessDenied,
    controllerMessagesQuery.data?.pages,
    currentUserId,
  ]);

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      return;
    }
    if (!controllerConversationId) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }

    const handler = () => {
      void controllerMessagesQuery.refetch();
    };

    window.addEventListener("instafy:controller-stream-reconnected", handler);
    return () => {
      window.removeEventListener("instafy:controller-stream-reconnected", handler);
    };
  }, [controllerConversationId, controllerMessagesQuery]);

  const runStatusSeenRef = useRef<Map<string, string>>(new Map());
  const runStatusConversationRef = useRef<string | null>(controllerConversationId);

  useEffect(() => {
    if (runStatusConversationRef.current === controllerConversationId) {
      return;
    }
    runStatusConversationRef.current = controllerConversationId;
    runStatusSeenRef.current.clear();
  }, [controllerConversationId]);

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      return;
    }
    if (!controllerConversationId) {
      return;
    }

    let shouldRefetch = false;
    Object.values(runs ?? {}).forEach((run) => {
      if (run.runType !== "prompt") {
        return;
      }
      if (run.conversationId !== controllerConversationId) {
        return;
      }
      const previousStatus = runStatusSeenRef.current.get(run.id) ?? null;
      runStatusSeenRef.current.set(run.id, run.status);
      const isTerminal = TERMINAL_RUN_STATUSES.has(run.status);
      const wasTerminal = previousStatus ? TERMINAL_RUN_STATUSES.has(previousStatus) : false;
      if (!wasTerminal && isTerminal) {
        shouldRefetch = true;
      }
    });

    if (shouldRefetch) {
      void controllerMessagesQuery.refetch();
    }
  }, [controllerConversationId, controllerMessagesQuery, runs]);

  const hasMoreHistory = Boolean(controllerMessagesQuery.hasNextPage);
  const isHistoryLoading = controllerMessagesQuery.isFetchingNextPage;
  const isInitialHistoryLoading =
    runtimeControllerEnabled &&
    Boolean(currentUserId) &&
    Boolean(controllerConversationId) &&
    !controllerHistoryNotFound &&
    !controllerHistoryAccessDenied &&
    messages.length === 0 &&
    (
      controllerMessagesQuery.isPending ||
      (controllerMessagesQuery.isFetching &&
        !(controllerMessagesQuery.data?.pages?.length ?? 0))
    );

  const loadOlderMessages = useCallback(async () => {
    if (!controllerConversationId) {
      return;
    }
    if (!controllerMessagesQuery.hasNextPage || controllerMessagesQuery.isFetchingNextPage) {
      return;
    }
    await controllerMessagesQuery.fetchNextPage();
  }, [controllerConversationId, controllerMessagesQuery]);

  return {
    messages,
    hasMoreHistory,
    isHistoryLoading,
    isInitialHistoryLoading,
    loadOlderMessages,
  };
}
