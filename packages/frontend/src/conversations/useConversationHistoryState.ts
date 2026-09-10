import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { controllerClient } from "../sdk/instafy";
import type { RunRecord } from "../types";
import type { ChatMessage } from "../screens/studio/types";
import type { ConversationState } from "./ConversationsProvider";
import { mapControllerMessageToChat, mergeAndSortMessages } from "./conversationMessageUtils";
import {
  CONVERSATION_HISTORY_PAGE_SIZE,
  reconcileConversationHistory,
  type ConversationHistoryData,
  type ConversationHistoryPage,
} from "./conversationHistoryPages";
import {
  CONVERSATION_HISTORY_GC_TIME_MS,
  removeOtherAccountsConversationHistory,
  retainConversationHistoryCache,
} from "./conversationHistoryCache";

const ACTIVE_CONVERSATION_HISTORY_REFETCH_INTERVAL_MS = 10_000;
const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "canceled", "merged"]);
const { enabled: runtimeControllerEnabled } = controllerClient.core;
const { listMessages: fetchConversationMessagesFromController } = controllerClient.conversations;
// Distinguish completed reads even when several finish in the same millisecond.
let historyReadVersion = 0;

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
  const [unavailableScope, setUnavailableScope] = useState<{
    userId: string | null; conversationId: string | null; accessDenied: boolean; notFound: boolean;
  } | null>(null);
  const scopeUnavailable = unavailableScope?.userId === currentUserId && unavailableScope?.conversationId === controllerConversationId
    ? unavailableScope : null;
  useEffect(() => setUnavailableScope(null), [currentUserId, controllerConversationId]);
  const queryKey = useMemo(
    () => ["conversation-messages", currentUserId, controllerConversationId] as const,
    [currentUserId, controllerConversationId],
  );
  const latestQueryKey = useMemo(
    () => ["conversation-messages-latest", currentUserId, controllerConversationId] as const,
    [currentUserId, controllerConversationId],
  );
  const enabled = runtimeControllerEnabled && Boolean(currentUserId) && Boolean(controllerConversationId) && !scopeUnavailable;

  useEffect(() => retainConversationHistoryCache(queryClient), [queryClient]);
  useEffect(() => {
    removeOtherAccountsConversationHistory(queryClient, currentUserId);
  }, [queryClient, currentUserId]);

  const fetchPage = useCallback(async (cursor: string | null, signal: AbortSignal): Promise<ConversationHistoryPage> => {
    if (!controllerConversationId || !currentUserId) {
      return { messages: [], nextCursor: null, hasMore: false, notFound: false, accessDenied: false, readVersion: ++historyReadVersion };
    }
    const page = await fetchConversationMessagesFromController({
      conversationId: controllerConversationId,
      cursor: cursor ?? undefined,
      limit: CONVERSATION_HISTORY_PAGE_SIZE,
      accessToken: null,
      signal,
    });
    signal.throwIfAborted();
    if (page === "not_found" || page === "access_denied") {
      return {
        messages: [], nextCursor: null, hasMore: false,
        notFound: page === "not_found", accessDenied: page === "access_denied", readVersion: ++historyReadVersion,
      };
    }
    if (!page) {
      throw new Error("Unable to load conversation history.");
    }
    return {
      messages: (page.messages ?? []).map(mapControllerMessageToChat),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.hasMore,
      notFound: false,
      accessDenied: false,
      readVersion: ++historyReadVersion,
    };
  }, [controllerConversationId, currentUserId]);

  const controllerMessagesQuery = useInfiniteQuery({
    queryKey,
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchPage(pageParam, signal);
      signal.throwIfAborted();
      if (pageParam === null) {
        // Seed the recent-page observer so the first rendered messages do not
        // immediately start a second history request.
        queryClient.setQueryData(latestQueryKey, page);
      }
      return page;
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) {
        return undefined;
      }
      return lastPage.nextCursor ?? undefined;
    },
    staleTime: Infinity,
    gcTime: CONVERSATION_HISTORY_GC_TIME_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const latestMessagesQuery = useQuery({
    queryKey: latestQueryKey,
    queryFn: ({ signal }) => fetchPage(null, signal),
    enabled: enabled && Boolean(controllerMessagesQuery.data?.pages.length),
    staleTime: ACTIVE_CONVERSATION_HISTORY_REFETCH_INTERVAL_MS,
    gcTime: CONVERSATION_HISTORY_GC_TIME_MS,
    refetchInterval: enabled ? ACTIVE_CONVERSATION_HISTORY_REFETCH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const latest = latestMessagesQuery.data;
    if (!latest || !controllerMessagesQuery.data || controllerMessagesQuery.isFetchingNextPage) {
      return;
    }
    queryClient.setQueryData<ConversationHistoryData>(queryKey, (cached) => (
      cached ? reconcileConversationHistory(cached, latest) : cached
    ));
  }, [latestMessagesQuery.data, controllerMessagesQuery.data, controllerMessagesQuery.isFetchingNextPage, queryClient, queryKey]);

  const controllerHistoryNotFound = useMemo(() => {
    return Boolean(scopeUnavailable?.notFound || latestMessagesQuery.data?.notFound) || (controllerMessagesQuery.data?.pages ?? []).some((page) => page.notFound);
  }, [scopeUnavailable?.notFound, controllerMessagesQuery.data?.pages, latestMessagesQuery.data?.notFound]);
  const controllerHistoryAccessDenied = useMemo(() => {
    return Boolean(scopeUnavailable?.accessDenied || latestMessagesQuery.data?.accessDenied) || (controllerMessagesQuery.data?.pages ?? []).some((page) => page.accessDenied);
  }, [scopeUnavailable?.accessDenied, controllerMessagesQuery.data?.pages, latestMessagesQuery.data?.accessDenied]);

  useEffect(() => {
    if (!controllerHistoryNotFound && !controllerHistoryAccessDenied) {
      return;
    }
    if (!activeConversation?.controllerId) {
      return;
    }
    setUnavailableScope({ userId: currentUserId, conversationId: activeConversation.controllerId, accessDenied: controllerHistoryAccessDenied, notFound: controllerHistoryNotFound });
    if (controllerHistoryAccessDenied || controllerHistoryNotFound) {
      // Clear every cached page and any local/SSE copies after an explicit
      // denial; a later network error must not resurrect revoked history.
      queryClient.removeQueries({
        queryKey,
        exact: true,
      });
      queryClient.removeQueries({ queryKey: latestQueryKey, exact: true });
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
    queryKey,
    latestQueryKey,
    replaceMessages,
    setConversationControllerId,
  ]);

  const messages = useMemo(() => {
    if (controllerHistoryAccessDenied || controllerHistoryNotFound || (controllerConversationId && !currentUserId)) {
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
    controllerHistoryNotFound,
    controllerMessagesQuery.data?.pages,
    currentUserId,
  ]);

  const firstHistoryPageMessages = controllerMessagesQuery.data?.pages[0]?.messages;
  const latestArrivalMessages = useMemo<readonly ChatMessage[]>(() => {
    if (controllerHistoryAccessDenied || controllerHistoryNotFound || (controllerConversationId && !currentUserId)) {
      return [];
    }
    // Keep arrival detection separate from paginated transcript history: older
    // rows can share the newest timestamp after timestamp precision is reduced.
    const newestMessages = latestMessagesQuery.data?.messages ?? firstHistoryPageMessages ?? [];
    const localMessages = activeConversation?.messages ?? [];
    return mergeAndSortMessages([...newestMessages, ...localMessages]);
  }, [
    activeConversation?.messages,
    controllerConversationId,
    controllerHistoryAccessDenied,
    controllerHistoryNotFound,
    currentUserId,
    firstHistoryPageMessages,
    latestMessagesQuery.data?.messages,
  ]);

  const refetchInitial = controllerMessagesQuery.refetch;
  const refetchLatest = latestMessagesQuery.refetch;
  const hasLoadedHistory = Boolean(controllerMessagesQuery.data?.pages.length);
  const refreshHistory = useCallback(() => {
    if (!enabled || controllerHistoryAccessDenied || controllerHistoryNotFound) {
      return;
    }
    // Several UI consumers can request the same refresh. Join the in-flight
    // read instead of cancelling and restarting it for every observer.
    if (hasLoadedHistory) {
      void refetchLatest({ cancelRefetch: false });
    } else {
      void refetchInitial({ cancelRefetch: false });
    }
  }, [enabled, controllerHistoryAccessDenied, controllerHistoryNotFound, hasLoadedHistory, refetchLatest, refetchInitial]);

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

    window.addEventListener("instafy:controller-stream-reconnected", refreshHistory);
    return () => {
      window.removeEventListener("instafy:controller-stream-reconnected", refreshHistory);
    };
  }, [controllerConversationId, refreshHistory]);

  const runStatusSeenRef = useRef<Map<string, string>>(new Map());
  const runStatusConversationRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      return;
    }
    if (!controllerConversationId) {
      return;
    }

    const initializing = runStatusConversationRef.current !== controllerConversationId;
    if (initializing) {
      runStatusConversationRef.current = controllerConversationId;
      runStatusSeenRef.current.clear();
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
      if (!initializing && !wasTerminal && isTerminal) {
        shouldRefetch = true;
      }
    });

    if (shouldRefetch) {
      refreshHistory();
    }
  }, [controllerConversationId, refreshHistory, runs]);

  const hasMoreHistory = Boolean(controllerMessagesQuery.hasNextPage);
  // Local/SSE rows can arrive before the controller's first history response.
  // Only an authorized page establishes the remote baseline, including an empty page.
  const hasResolvedHistory = Boolean(activeConversation && currentUserId
    && !controllerHistoryNotFound && !controllerHistoryAccessDenied
    && (!runtimeControllerEnabled || (controllerConversationId && hasLoadedHistory)));
  const isHistoryLoading = controllerMessagesQuery.isFetchingNextPage;
  const needsInitialHistory =
    runtimeControllerEnabled &&
    Boolean(currentUserId) &&
    Boolean(controllerConversationId) &&
    !controllerHistoryNotFound &&
    !controllerHistoryAccessDenied &&
    messages.length === 0 &&
    !(controllerMessagesQuery.data?.pages?.length ?? 0);
  const isInitialHistoryLoading =
    needsInitialHistory && (controllerMessagesQuery.isPending || controllerMessagesQuery.isFetching);
  const initialHistoryError =
    needsInitialHistory && controllerMessagesQuery.isError && !controllerMessagesQuery.isFetching
      ? "Couldn't load messages."
      : null;

  const retryInitialHistory = useCallback(async () => {
    if (!needsInitialHistory || controllerMessagesQuery.isFetching) {
      return;
    }
    await controllerMessagesQuery.refetch();
  }, [controllerMessagesQuery, needsInitialHistory]);

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
    latestArrivalMessages,
    hasMoreHistory,
    hasResolvedHistory,
    isHistoryLoading,
    isInitialHistoryLoading,
    initialHistoryError,
    retryInitialHistory,
    loadOlderMessages,
  };
}
