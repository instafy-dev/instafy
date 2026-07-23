import { useEffect, useMemo, useRef, useCallback } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
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
};

interface UseConversationHistoryStateArgs {
  activeConversation: ConversationState | null;
  runs: Record<string, RunRecord>;
  setConversationControllerId: (conversationId: string, controllerId: string | null) => void;
}

export function useConversationHistoryState({
  activeConversation,
  runs,
  setConversationControllerId,
}: UseConversationHistoryStateArgs) {
  const controllerConversationId = activeConversation?.controllerId ?? null;
  const controllerMessagesQuery = useInfiniteQuery<ConversationMessagesQueryPage>({
    queryKey: ["conversation-messages", controllerConversationId],
    enabled: runtimeControllerEnabled && Boolean(controllerConversationId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      if (!controllerConversationId) {
        return { messages: [], nextCursor: null, hasMore: false, notFound: false };
      }
      const cursor =
        typeof pageParam === "string" && pageParam.trim().length > 0 ? pageParam : null;
      const page = await fetchConversationMessagesFromController({
        conversationId: controllerConversationId,
        cursor: cursor ?? undefined,
        accessToken: null,
      });
      if (page === "not_found") {
        return { messages: [], nextCursor: null, hasMore: false, notFound: true };
      }
      if (!page) {
        return { messages: [], nextCursor: null, hasMore: false, notFound: false };
      }
      return {
        messages: (page.messages ?? []).map(mapControllerMessageToChat),
        nextCursor: page.nextCursor ?? null,
        hasMore: page.hasMore,
        notFound: false,
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
      runtimeControllerEnabled && controllerConversationId
        ? ACTIVE_CONVERSATION_HISTORY_REFETCH_INTERVAL_MS
        : false,
    refetchIntervalInBackground: true,
  });

  const controllerHistoryNotFound = useMemo(() => {
    return (controllerMessagesQuery.data?.pages ?? []).some((page) => page.notFound);
  }, [controllerMessagesQuery.data?.pages]);

  useEffect(() => {
    if (!controllerHistoryNotFound) {
      return;
    }
    if (!activeConversation?.controllerId) {
      return;
    }
    setConversationControllerId(activeConversation.localId, null);
  }, [
    activeConversation?.controllerId,
    activeConversation?.localId,
    controllerHistoryNotFound,
    setConversationControllerId,
  ]);

  const messages = useMemo(() => {
    const localMessages = activeConversation?.messages ?? [];
    const historyMessages = (controllerMessagesQuery.data?.pages ?? []).flatMap((page) => page.messages ?? []);
    if (localMessages.length === 0 && historyMessages.length === 0) {
      return [];
    }
    return mergeAndSortMessages([...historyMessages, ...localMessages]);
  }, [activeConversation?.messages, controllerMessagesQuery.data?.pages]);

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
    Boolean(controllerConversationId) &&
    !controllerHistoryNotFound &&
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
