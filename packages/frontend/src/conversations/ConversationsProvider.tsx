import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { ChatMessage } from "../screens/studio/types";
import { useRuntime } from "../runtime/useRuntime";
import { useProject } from "../projects/useProject";
import { useAuth } from "../providers/AuthProvider";
import { useStatus } from "../status/useStatus";
import { controllerClient } from "../sdk/instafy";
import { isAppInForeground } from "../notifications/assistantMessageNotifications";
import { isUuid } from "./conversationMessageUtils";
import {
  DEFAULT_CONVERSATION_ROUTING_PREFERENCES,
  normalizeConversationRoutingHandles,
  type ConversationRoutingPreferences,
} from "./conversationRoutingMetadata";
import {
  deriveRuntimePreferenceFromMessages,
  type ConversationLifecycleStatus,
} from "./conversationMetadata";
import type { ConversationGoal } from "./conversationGoals";
import {
  cloneConversationsState,
  conversationsReducer,
  createInitialState,
  makeConversationId,
  type ConversationState,
  type ConversationsState,
  type CreateConversationOptions,
} from "./conversationState";
import { normalizeCustomAgentHandle } from "../assistants/localBuiltInAssistantCatalog";
import {
  useConversationControllerSync,
  useConversationMetadataPersistence,
  useConversationRunEffects,
  usePendingConversationEffects,
} from "./useConversationProviderEffects";
import { useConversationControllerDispatch } from "./useConversationControllerDispatch";
import { useConversationGoalContinuationEffects } from "./useConversationGoalContinuationEffects";
import { ConversationMessageMetadataProvider } from "./ConversationMessageMetadata";
import { studioPerformance } from "../telemetry/studioPerformance";

const {
  listForProject: fetchProjectConversationsFromController,
  updateMetadata: updateControllerConversationMetadata,
} = controllerClient.conversations;
export type {
  ConversationLifecycleStatus,
  ConversationRuntimePreference,
  ConversationVisibility,
} from "./conversationMetadata";
export type {
  ConversationState,
  CreateConversationOptions,
} from "./conversationState";

type ConversationDebugSnapshot = {
  activeConversationLocalId: string | null;
  activeConversationControllerId: string | null;
  activeConversationAssistantEnabled: boolean | null;
  activeConversationExtraAgentHandles: string[];
  conversations: Array<{
    localId: string;
    controllerId: string | null;
    title: string;
    parentConversationId: string | null;
    threadKind: string | null;
    ownerAgentHandle: string | null;
    activeGoal: ConversationGoal | null;
    assistantEnabled: boolean;
    extraAgentHandles: string[];
  }>;
  createConversation?: (options?: CreateConversationOptions) => string | null;
  selectConversation?: (conversationId: string) => void;
  setConversationControllerId?: (conversationId: string, controllerId: string | null) => void;
  setConversationGoal?: (conversationId: string, goal: ConversationGoal | null) => void;
  markConversationRead?: (conversationId: string) => void;
};

interface ConversationsContextValue {
  projectKey: string;
  remoteConversationHistoryResolved: boolean;
  remoteConversationHistoryError: string | null;
  retryRemoteConversationHistory: () => void;
  conversations: ConversationState[];
  activeConversationId: string | null;
  activeConversation: ConversationState | null;
  createConversation: (options?: CreateConversationOptions) => ConversationState;
  selectConversation: (conversationId: string) => void;
  closeConversation: (conversationId: string) => void;
  setConversationLifecycleStatus: (conversationId: string, status: ConversationLifecycleStatus) => void;
  setConversationDraft: (conversationId: string, draft: string, editorState?: string | null) => void;
  setConversationAssistantEnabled: (conversationId: string, enabled: boolean) => void;
  addConversationAgentHandle: (conversationId: string, handle: string) => void;
  removeConversationAgentHandle: (conversationId: string, handle: string) => void;
  appendMessages: (conversationId: string, messages: ChatMessage[]) => void;
  replaceMessages: (conversationId: string, messages: ChatMessage[]) => void;
  updateMessage: (
    conversationId: string,
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage
  ) => void;
  setConversationControllerId: (conversationId: string, controllerId: string | null) => void;
  setConversationTitle: (conversationId: string, title: string) => void;
  setConversationGoal: (conversationId: string, goal: ConversationGoal | null) => void;
  markConversationRead: (conversationId: string) => void;
  linkRunToConversation: (runId: string, conversationId: string) => void;
  unlinkRunFromConversation: (runId: string) => void;
  resolveConversationForRun: (runId: string, options?: { remove?: boolean }) => string | null;
  resolveConversationByController: (controllerId: string | null | undefined) => ConversationState | null;
}

const ConversationsContext = createContext<ConversationsContextValue | undefined>(undefined);

declare global {
  interface Window {
    __INSTAFY_CONVERSATIONS_DEBUG__?: ConversationDebugSnapshot;
  }
}

const normalizeExtraAgentHandle = (handle: string) => normalizeCustomAgentHandle(handle);

export const ConversationsProvider = ({ children }: PropsWithChildren) => {
  const [state, dispatch] = useReducer(conversationsReducer, undefined, createInitialState);
  const [controllerConversationSyncEpoch, bumpControllerConversationSyncEpoch] = useReducer(
    (value: number) => value + 1,
    0,
  );
  const [pendingLeaseSweepEpoch, bumpPendingLeaseSweepEpoch] = useReducer(
    (value: number) => value + 1,
    0,
  );
  const processedRunMessagesRef = useRef<Set<string>>(new Set());
  const notifiedMessageIdsRef = useRef<Set<string>>(new Set());
  const lastBackgroundAtRef = useRef<number>(0);
  const projectStatesRef = useRef<Record<string, ConversationsState>>({});
  const lastProjectIdRef = useRef<string | null>(null);
  const latestStateRef = useRef<ConversationsState>(state);
  const pendingLeaseSweepTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { activeProjectId, projectAccessPending, projectAccessBlocked } = useProject();
  const { user } = useAuth();
  const { showStatus } = useStatus();
  const runtimeContext = useRuntime();
  const {
    runs,
    leasedRunIds,
    clearRunLease,
    pendingConversationMessages,
    ackConversationMessages,
    pendingConversationCreations,
    ackConversationCreations,
    pendingConversationUpdates,
    ackConversationUpdates
  } = runtimeContext;
  const controllerProjectMissing = runtimeContext.runtime.controllerProjectMissing;
  const currentUserId = user?.id ?? null;

  // Note: notification nudges are rendered inside the Chat panel so they feel like part of the
  // conversation flow (instead of a global toast).

  useLayoutEffect(() => {
    latestStateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const recordBackgroundState = () => {
      if (!isAppInForeground()) {
        lastBackgroundAtRef.current = Date.now();
      }
    };

    recordBackgroundState();
    document.addEventListener("visibilitychange", recordBackgroundState);
    window.addEventListener("blur", recordBackgroundState);

    return () => {
      document.removeEventListener("visibilitychange", recordBackgroundState);
      window.removeEventListener("blur", recordBackgroundState);
    };
  }, []);

  const projectKey = useMemo(() => {
    if (activeProjectId && isUuid(activeProjectId)) {
      return activeProjectId;
    }
    if (typeof window !== "undefined") {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
      };
      const fromWindow = runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__;
      if (fromWindow && isUuid(fromWindow)) {
        return fromWindow;
      }
      try {
        const params = new URLSearchParams(window.location.search);
        const fromUrl = params.get("projectId");
        if (fromUrl && isUuid(fromUrl.trim())) {
          return fromUrl.trim();
        }
      } catch (_error) {
        // ignore malformed URL
      }
    }
    return "default";
  }, [activeProjectId]);

  useLayoutEffect(() => {
    if (lastProjectIdRef.current === projectKey) {
      return;
    }
    const persistedKey = lastProjectIdRef.current ?? projectKey;
    projectStatesRef.current[persistedKey] = {
      ...cloneConversationsState(latestStateRef.current),
      projectKey: persistedKey
    };
    const savedState = projectStatesRef.current[projectKey];
    const nextState = savedState
      ? cloneConversationsState(savedState)
      : cloneConversationsState(createInitialState(projectKey));
    nextState.projectKey = projectKey;
    dispatch({ type: "LOAD_STATE", state: nextState });
    lastProjectIdRef.current = projectKey;
  }, [projectKey]);

  const {
    remoteConversationHistoryResolved,
    remoteConversationHistoryError,
    retryRemoteConversationHistory,
  } = useConversationControllerSync({
    state,
    currentUserId,
    controllerProjectMissing,
    projectAccessPending,
    projectAccessBlocked,
    latestStateRef,
    dispatch,
    controllerConversationSyncEpoch,
    bumpControllerConversationSyncEpoch,
    fetchProjectConversationsFromController,
    updateControllerConversationMetadata,
  });

  useConversationRunEffects({
    conversations: state.conversations,
    runMap: state.runMap,
    runs,
    leasedRunIds,
    clearRunLease,
    processedRunMessagesRef,
    pendingLeaseSweepEpoch,
    bumpPendingLeaseSweepEpoch,
    pendingLeaseSweepTimeoutRef,
    currentUserId,
    dispatch,
    updateControllerConversationMetadata,
  });

  usePendingConversationEffects({
    state,
    projectKey,
    currentUserId,
    pendingConversationCreations,
    ackConversationCreations,
    pendingConversationUpdates,
    ackConversationUpdates,
    pendingConversationMessages,
    ackConversationMessages,
    lastBackgroundAtRef,
    notifiedMessageIdsRef,
    dispatch,
    updateControllerConversationMetadata,
  });

  const {
    setConversationLifecycleStatus,
    persistConversationRoutingPreferences,
    persistConversationGoal,
  } =
    useConversationMetadataPersistence({
      latestStateRef,
      currentUserId,
      dispatch,
      updateControllerConversationMetadata,
    });

  const createConversation = useCallback(
    (options?: CreateConversationOptions): ConversationState => {
      const initialMessages = options?.messages ?? [];
      const conversation: ConversationState = {
        localId: options?.localId ?? makeConversationId(),
        title: options?.title ?? `Conversation ${state.sequence}`,
        visibility: options?.visibility ?? "public",
        lifecycleStatus: "active",
        controllerId: options?.controllerId ?? null,
        parentConversationId: options?.parentConversationId ?? null,
        threadKind: options?.threadKind ?? null,
        ownerAgent: options?.ownerAgent ? { ...options.ownerAgent } : null,
        activeGoal: options?.activeGoal ? { ...options.activeGoal } : null,
        originMessageId: options?.originMessageId ?? null,
        delegatedByAgentId: options?.delegatedByAgentId ?? null,
        messages: initialMessages,
        draft: "",
        draftEditorState: null,
        assistantEnabled:
          options?.assistantEnabled ??
          DEFAULT_CONVERSATION_ROUTING_PREFERENCES.assistantEnabled,
        extraAgentHandles:
          options?.extraAgentHandles && options.extraAgentHandles.length > 0
            ? [...options.extraAgentHandles]
            : [...DEFAULT_CONVERSATION_ROUTING_PREFERENCES.extraAgentHandles],
        unreadCount: 0,
        createdAt: Date.now(),
        pendingRunIds: [],
        awaitingLeaseRunIds: [],
        pendingRunSubmittedAt: {},
        runtimePreference: deriveRuntimePreferenceFromMessages(initialMessages)
      };
      dispatch({ type: "CREATE", conversation, select: options?.select !== false });
      return conversation;
    },
    [state.sequence]
  );

  const selectConversation = useCallback((conversationId: string) => {
    const current = latestStateRef.current;
    if (current.activeId !== conversationId && current.conversations.some((entry) => entry.localId === conversationId)) {
      studioPerformance.beginConversation(current.projectKey, conversationId);
    }
    dispatch({ type: "SELECT", id: conversationId });
  }, []);

  const closeConversation = useCallback((conversationId: string) => {
    setConversationLifecycleStatus(conversationId, "hidden");
  }, [setConversationLifecycleStatus]);

  const setConversationDraft = useCallback((conversationId: string, draft: string, editorState: string | null = null) => {
    dispatch({ type: "SET_DRAFT", id: conversationId, draft, editorState });
  }, []);

  const setConversationAssistantEnabled = useCallback((conversationId: string, enabled: boolean) => {
    const conversation =
      latestStateRef.current.conversations.find((entry) => entry.localId === conversationId) ?? null;
    const nextPreferences: ConversationRoutingPreferences = {
      assistantEnabled: enabled,
      extraAgentHandles: conversation?.extraAgentHandles ?? [],
    };
    dispatch({ type: "SET_ASSISTANT_ENABLED", id: conversationId, enabled });
    persistConversationRoutingPreferences(conversationId, nextPreferences);
  }, [persistConversationRoutingPreferences]);

  const addConversationAgentHandle = useCallback((conversationId: string, handle: string) => {
    const normalized = normalizeExtraAgentHandle(handle);
    if (!normalized) {
      return;
    }
    const conversation =
      latestStateRef.current.conversations.find((entry) => entry.localId === conversationId) ?? null;
    const nextHandles = normalizeConversationRoutingHandles([
      ...(conversation?.extraAgentHandles ?? []),
      normalized,
    ]);
    dispatch({ type: "ADD_AGENT_HANDLE", id: conversationId, handle: normalized });
    persistConversationRoutingPreferences(conversationId, {
      assistantEnabled: conversation?.assistantEnabled ?? DEFAULT_CONVERSATION_ROUTING_PREFERENCES.assistantEnabled,
      extraAgentHandles: nextHandles,
    });
  }, [persistConversationRoutingPreferences]);

  const removeConversationAgentHandle = useCallback((conversationId: string, handle: string) => {
    const normalized = normalizeExtraAgentHandle(handle);
    if (!normalized) {
      return;
    }
    const conversation =
      latestStateRef.current.conversations.find((entry) => entry.localId === conversationId) ?? null;
    const nextHandles = (conversation?.extraAgentHandles ?? []).filter((entry) => entry !== normalized);
    dispatch({ type: "REMOVE_AGENT_HANDLE", id: conversationId, handle: normalized });
    persistConversationRoutingPreferences(conversationId, {
      assistantEnabled: conversation?.assistantEnabled ?? DEFAULT_CONVERSATION_ROUTING_PREFERENCES.assistantEnabled,
      extraAgentHandles: nextHandles,
    });
  }, [persistConversationRoutingPreferences]);

  const appendMessages = useCallback((conversationId: string, messages: ChatMessage[]) => {
    dispatch({ type: "APPEND", id: conversationId, messages });
  }, []);

  const replaceMessages = useCallback((conversationId: string, messages: ChatMessage[]) => {
    dispatch({ type: "REPLACE", id: conversationId, messages });
  }, []);

  const updateMessage = useCallback(
    (conversationId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
      dispatch({ type: "UPDATE_MESSAGE", conversationId, messageId, updater });
    },
    []
  );

  const setConversationControllerId = useCallback((conversationId: string, controllerId: string | null) => {
    dispatch({ type: "SET_CONTROLLER", id: conversationId, controllerId });
  }, []);

  const setConversationTitle = useCallback((conversationId: string, title: string) => {
    dispatch({ type: "SET_TITLE", id: conversationId, title });
  }, []);

  const setConversationGoal = useCallback(
    (conversationId: string, goal: ConversationGoal | null) => {
      dispatch({ type: "SET_GOAL", id: conversationId, goal });
      persistConversationGoal(conversationId, goal);
    },
    [persistConversationGoal],
  );

  const markConversationRead = useCallback((conversationId: string) => {
    dispatch({ type: "MARK_READ", id: conversationId });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const activeConversation =
      state.activeId
        ? state.conversations.find((conversation) => conversation.localId === state.activeId) ?? null
        : null;
    window.__INSTAFY_CONVERSATIONS_DEBUG__ = {
      activeConversationLocalId: activeConversation?.localId ?? null,
      activeConversationControllerId: activeConversation?.controllerId ?? null,
      activeConversationAssistantEnabled: activeConversation?.assistantEnabled ?? null,
      activeConversationExtraAgentHandles: [...(activeConversation?.extraAgentHandles ?? [])],
      conversations: state.conversations.map((conversation) => ({
        localId: conversation.localId,
        controllerId: conversation.controllerId,
        title: conversation.title,
        parentConversationId: conversation.parentConversationId,
        threadKind: conversation.threadKind,
        ownerAgentHandle: conversation.ownerAgent?.handle ?? null,
        activeGoal: conversation.activeGoal ? { ...conversation.activeGoal } : null,
        assistantEnabled: conversation.assistantEnabled,
        extraAgentHandles: [...conversation.extraAgentHandles],
      })),
      createConversation: (options?: CreateConversationOptions) =>
        createConversation(options)?.localId ?? null,
      selectConversation,
      setConversationControllerId,
      setConversationGoal,
      markConversationRead,
    };
  }, [
    createConversation,
    markConversationRead,
    selectConversation,
    setConversationControllerId,
    setConversationGoal,
    state,
  ]);

  const linkRunToConversation = useCallback((runId: string, conversationId: string) => {
    dispatch({ type: "LINK_RUN", runId, conversationId });
  }, []);

  const unlinkRunFromConversation = useCallback((runId: string) => {
    dispatch({ type: "UNLINK_RUN", runId });
  }, []);

  const resolveConversationForRun = useCallback(
    (runId: string, options?: { remove?: boolean }) => {
      const conversationId = state.runMap[runId] ?? null;
      if (conversationId && options?.remove) {
        dispatch({ type: "UNLINK_RUN", runId });
      }
      return conversationId;
    },
    [state.runMap]
  );

  const resolveConversationByController = useCallback(
    (controllerId: string | null | undefined) => {
      if (!controllerId) {
        return null;
      }
      return state.conversations.find((conversation) => conversation.controllerId === controllerId) ?? null;
    },
    [state.conversations]
  );

  const activeConversation = useMemo(() => {
    return state.conversations.find((conversation) => conversation.localId === state.activeId) ?? null;
  }, [state.activeId, state.conversations]);

  const { sendPromptToController } = useConversationControllerDispatch({
    conversations: state.conversations,
    activeConversation,
    activeProjectId,
    currentUserId,
    preferredRuntimeId: runtimeContext.preferredRuntimeId,
    runtimeStatuses: runtimeContext.runtimeStatuses,
    effectiveRuntimeId: runtimeContext.effectiveRuntimeId,
    effectiveRuntimeSource: runtimeContext.effectiveRuntimeSource,
    showStatus,
    createConversation,
    selectConversation,
    markConversationRead,
    setConversationDraft,
    setConversationControllerId,
    appendMessages,
    linkRunToConversation,
  });

  useConversationGoalContinuationEffects({
    conversations: state.conversations,
    runs,
    currentUserId,
    setConversationGoal,
    appendMessages,
    sendPromptToController,
    updateControllerConversationMetadata,
  });

  const value = useMemo<ConversationsContextValue>(
    () => ({
      projectKey: state.projectKey,
      remoteConversationHistoryResolved,
      remoteConversationHistoryError,
      retryRemoteConversationHistory,
      conversations: state.conversations,
      activeConversationId: state.activeId,
      activeConversation,
      createConversation,
      selectConversation,
      closeConversation,
      setConversationLifecycleStatus,
      setConversationDraft,
      setConversationAssistantEnabled,
      addConversationAgentHandle,
      removeConversationAgentHandle,
      appendMessages,
      replaceMessages,
      updateMessage,
      setConversationControllerId,
      setConversationTitle,
      setConversationGoal,
      markConversationRead,
      linkRunToConversation,
      unlinkRunFromConversation,
      resolveConversationForRun,
      resolveConversationByController
    }),
    [
      state.projectKey,
      remoteConversationHistoryResolved,
      remoteConversationHistoryError,
      retryRemoteConversationHistory,
      state.conversations,
      state.activeId,
      activeConversation,
      createConversation,
      selectConversation,
      closeConversation,
      setConversationLifecycleStatus,
      setConversationDraft,
      setConversationAssistantEnabled,
      addConversationAgentHandle,
      removeConversationAgentHandle,
      appendMessages,
      replaceMessages,
      updateMessage,
      setConversationControllerId,
      setConversationTitle,
      setConversationGoal,
      markConversationRead,
      linkRunToConversation,
      unlinkRunFromConversation,
      resolveConversationForRun,
      resolveConversationByController
    ]
  );

  return (
    <ConversationsContext.Provider value={value}>
      <ConversationMessageMetadataProvider conversations={state.conversations} activeConversationId={state.activeId}>
        {children}
      </ConversationMessageMetadataProvider>
    </ConversationsContext.Provider>
  );
};

export function useConversations(): ConversationsContextValue {
  const context = useContext(ConversationsContext);
  if (context === undefined) {
    throw new Error("useConversations must be used within a ConversationsProvider");
  }
  return context;
}
