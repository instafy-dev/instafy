import { useCallback, useEffect, useMemo, type MutableRefObject } from "react";
import { useConversations } from "./ConversationsProvider";
import { useStatus } from "../status/useStatus";
import { useProject } from "../projects/useProject";
import { useRuntime } from "../runtime/useRuntime";
import type { ChatMessage } from "../screens/studio/types";
import { useAuth } from "../providers/AuthProvider";
import { controllerClient } from "../sdk/instafy";
import { isAwaitingLeaseRunStale, isRunActivelyProgressing } from "./runLiveness";
import { useConversationHistoryState } from "./useConversationHistoryState";
import {
  buildConversationAgentHandles,
  type SubmitConversationOptions,
  useConversationSubmitFlow,
} from "./useConversationSubmitFlow";
import {
  getFirstUserMessage,
  getStructuredConversationTitle,
  isDefaultConversationTitle,
} from "./conversationAutoTitle";
import {
  hasVisibleAssistantMessageForRun,
  shouldSuppressAgentEvaluationRunPresence,
  type ConversationGroupParticipationPreflightInput,
  type ConversationGroupParticipationPreflightResult,
} from "./groupParticipation";
import { hasNonRecoverableErrorForRun } from "./conversationGoals";
import { APPLICATION_FRONTEND_FEATURES } from "../features/applicationFrontendFeatureComposition";
import { messageUsesTurnEngine } from "../features/frontendFeatureModule";
export type { SubmitConversationOptions, SubmitConversationRuntimeOverride } from "./useConversationSubmitFlow";

const { updateMetadata: updateControllerConversationMetadata } = controllerClient.conversations;

interface UseConversationResult {
  conversations: ReturnType<typeof useConversations>["conversations"];
  activeConversationId: string | null;
  messages: ChatMessage[];
  latestArrivalMessages: readonly ChatMessage[];
  inputValue: string;
  inputEditorState: string | null;
  assistantEnabled: boolean;
  extraAgentHandles: string[];
  agentHandles: string[];
  onAssistantEnabledChange: (conversationId: string | null, enabled: boolean) => void;
  onAddAgentHandle: (conversationId: string | null, handle: string) => void;
  onRemoveAgentHandle: (conversationId: string | null, handle: string) => void;
  isAssistantTyping: boolean;
  isWorkspaceSettingUp: boolean;
  hasMoreHistory: boolean;
  hasResolvedHistory: boolean;
  isHistoryLoading: boolean;
  isInitialHistoryLoading: boolean;
  initialHistoryError: string | null;
  retryInitialHistory: () => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  onSelectConversation: (conversationId: string) => void;
  onCreateConversation: () => void;
  onCloseConversation: (conversationId: string) => void;
  onInputChange: (conversationId: string | null, value: string, editorState?: string | null) => void;
  onRecordMessage: (
    conversationId: string,
    content: string,
    metadata?: Record<string, unknown> | null,
    role?: ChatMessage["role"],
  ) => Promise<ChatMessage | null>;
  onMaybeAutoTitleConversation: (conversationId: string, firstUserMessage: string) => Promise<void>;
  onResolveGroupParticipationBeforeSubmit: (
    input: ConversationGroupParticipationPreflightInput,
  ) => Promise<ConversationGroupParticipationPreflightResult>;
  onSubmit: (conversationId: string | null, input: string, options?: SubmitConversationOptions) => Promise<void>;
  stickyMentionedAgentByConversationRef: MutableRefObject<Map<string, string>>;
}

export function useConversation(): UseConversationResult {
  const {
    conversations,
    activeConversationId,
    activeConversation,
    createConversation,
    selectConversation,
    closeConversation,
    setConversationDraft,
    setConversationAssistantEnabled,
    addConversationAgentHandle,
    removeConversationAgentHandle,
    appendMessages,
    replaceMessages,
    updateMessage,
    markConversationRead,
    setConversationControllerId,
    setConversationTitle,
    setConversationGoal,
    linkRunToConversation,
  } = useConversations();
  const { showStatus } = useStatus();
  const { activeProjectId } = useProject();
  const { user } = useAuth();
  const {
    preferredRuntimeId,
    runtimeStatuses,
    effectiveRuntimeId,
    effectiveRuntimeSource,
    runs,
  } = useRuntime();
  const currentUserId = user?.id ?? null;

  const {
    messages,
    latestArrivalMessages,
    hasMoreHistory,
    hasResolvedHistory,
    isHistoryLoading,
    isInitialHistoryLoading,
    initialHistoryError,
    retryInitialHistory,
    loadOlderMessages,
  } = useConversationHistoryState({
    activeConversation,
    currentUserId,
    runs,
    setConversationControllerId,
    replaceMessages,
  });

  const {
    ensureConversation,
    handleCreateConversation,
    handleInputChange,
    recordMessageToController,
    maybeAutoTitleConversation,
    resolveGroupParticipationBeforeSubmit,
    handleSubmit,
    stickyMentionedAgentByConversationRef,
    pendingAgentEvaluationRunIdsRef,
  } = useConversationSubmitFlow({
    conversations,
    activeConversation,
    activeProjectId,
    currentUserId,
    preferredRuntimeId,
    runtimeStatuses,
    effectiveRuntimeId,
    effectiveRuntimeSource,
    showStatus,
    createConversation,
    selectConversation,
    markConversationRead,
    setConversationDraft,
    setConversationControllerId,
    setConversationTitle,
    setConversationGoal,
    appendMessages,
    updateMessage,
    linkRunToConversation,
  });

  useEffect(() => {
    if (!activeConversation) {
      return;
    }
    // A chat rebuilt from a message or a draft may hide a real title behind
    // its default one until the chat list confirms it.
    if (
      activeConversation.parentConversationId ||
      activeConversation.threadKind ||
      activeConversation.remoteSummaryPending ||
      !isDefaultConversationTitle(activeConversation.title)
    ) {
      return;
    }
    const structuredTitle = getStructuredConversationTitle(messages);
    if (structuredTitle) {
      setConversationTitle(activeConversation.localId, structuredTitle);
      if (activeConversation.controllerId) {
        void updateControllerConversationMetadata({
          conversationId: activeConversation.controllerId,
          metadata: {
            title: structuredTitle,
          },
        });
      }
      return;
    }
    // A turn-engine turn's message never seeds a title: titles are asked of a
    // model, and nothing Instafy runs for such a turn calls one.
    const turnEngineIds = APPLICATION_FRONTEND_FEATURES.turnEngines.map((engine) => engine.id);
    const latestUserMessage = messages
      .filter(
        (message) =>
          message.role === "user" &&
          message.content.trim().length > 0 &&
          !messageUsesTurnEngine(message.metadata, turnEngineIds),
      )
      .at(-1);
    const seed = latestUserMessage?.content.trim() ?? "";
    if (!seed) {
      return;
    }
    // Once every history page is in, the merged list names the opening
    // message, which a chat loaded from the controller lacks locally.
    const openingMessage = hasResolvedHistory && !hasMoreHistory
      ? getFirstUserMessage(messages) ?? undefined
      : undefined;
    void maybeAutoTitleConversation(activeConversation.localId, seed, openingMessage);
  }, [
    activeConversation,
    activeConversation?.localId,
    activeConversation?.parentConversationId,
    activeConversation?.remoteSummaryPending,
    activeConversation?.threadKind,
    activeConversation?.title,
    hasMoreHistory,
    hasResolvedHistory,
    maybeAutoTitleConversation,
    messages,
    setConversationTitle,
  ]);

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      selectConversation(conversationId);
      markConversationRead(conversationId);
    },
    [markConversationRead, selectConversation],
  );

  const handleCloseConversation = useCallback(
    (conversationId: string) => {
      closeConversation(conversationId);
    },
    [closeConversation],
  );

  const inputValue = activeConversation?.draft ?? "";
  const inputEditorState = activeConversation?.draftEditorState ?? null;
  const assistantEnabled = activeConversation?.assistantEnabled ?? true;
  const extraAgentHandles = useMemo(
    () => activeConversation?.extraAgentHandles ?? [],
    [activeConversation?.extraAgentHandles],
  );
  const agentHandles = useMemo(
    () => buildConversationAgentHandles(assistantEnabled, extraAgentHandles),
    [assistantEnabled, extraAgentHandles],
  );

  const onAssistantEnabledChange = useCallback(
    (conversationId: string | null, enabled: boolean) => {
      const targetId = conversationId ?? ensureConversation().localId;
      setConversationAssistantEnabled(targetId, enabled);
    },
    [ensureConversation, setConversationAssistantEnabled],
  );

  const onAddAgentHandle = useCallback(
    (conversationId: string | null, handle: string) => {
      const targetId = conversationId ?? ensureConversation().localId;
      addConversationAgentHandle(targetId, handle);
    },
    [addConversationAgentHandle, ensureConversation],
  );

  const onRemoveAgentHandle = useCallback(
    (conversationId: string | null, handle: string) => {
      const targetId = conversationId ?? ensureConversation().localId;
      removeConversationAgentHandle(targetId, handle);
    },
    [ensureConversation, removeConversationAgentHandle],
  );

  const isAssistantTyping = useMemo(() => {
    const nowMs = Date.now();
    const pendingRunIds = activeConversation?.pendingRunIds ?? [];
    const awaitingLeaseRunIds = new Set(activeConversation?.awaitingLeaseRunIds ?? []);
    const pendingRunSubmittedAt = activeConversation?.pendingRunSubmittedAt ?? {};
    const controllerId = activeConversation?.controllerId ?? null;
    const hasNonRecoverableErrorForPendingRun = (runId: string) =>
      hasNonRecoverableErrorForRun(
        messages,
        runId,
        activeConversation?.activeGoal ?? null,
      );
    // Skill-mode ambient runs stay silent-until-speaking: no typing indicator
    // for any viewer (server-stamped run metadata) including the submitter's
    // awaiting-lease window (local marks, populated before LINK_RUN so this
    // memo recomputes after the mark exists).
    const isSilencedAgentEvaluationRun = (
      runId: string,
      runMetadata?: Record<string, unknown> | null,
    ) =>
      shouldSuppressAgentEvaluationRunPresence({
        runId,
        runMetadata,
        pendingAgentEvaluationRunIds: pendingAgentEvaluationRunIdsRef.current,
        messages,
      });

    if (pendingRunIds.length > 0) {
      for (const runId of pendingRunIds) {
        const run = runs?.[runId];
        if (!run) {
          if (
            awaitingLeaseRunIds.has(runId) &&
            !isAwaitingLeaseRunStale(pendingRunSubmittedAt[runId], nowMs) &&
            !isSilencedAgentEvaluationRun(runId)
          ) {
            return true;
          }
          continue;
        }
        if (controllerId && run.conversationId && run.conversationId !== controllerId) {
          continue;
        }
        if (
          isRunActivelyProgressing(run, nowMs) &&
          !hasNonRecoverableErrorForPendingRun(run.id) &&
          !isSilencedAgentEvaluationRun(run.id, run.metadata)
        ) {
          return true;
        }
      }
    }

    if (!controllerId) {
      return false;
    }

    return Object.values(runs ?? {}).some((run) => {
      if (
        run.conversationId !== controllerId ||
        !isRunActivelyProgressing(run, nowMs) ||
        hasNonRecoverableErrorForPendingRun(run.id) ||
        isSilencedAgentEvaluationRun(run.id, run.metadata)
      ) {
        return false;
      }
      // Conservative viewer default: a run whose metadata has not arrived yet
      // could be a silent skill-mode evaluation, so it shows no presence until
      // the metadata proves it direct or a visible assistant message streams.
      // The submitter's own runs are vouched for by the pending/awaiting-lease
      // branches above, which use session-local knowledge.
      if (!run.metadata && !hasVisibleAssistantMessageForRun(messages, run.id)) {
        return false;
      }
      return true;
    });
  }, [
    activeConversation?.activeGoal,
    activeConversation?.awaitingLeaseRunIds,
    activeConversation?.controllerId,
    activeConversation?.pendingRunIds,
    activeConversation?.pendingRunSubmittedAt,
    messages,
    pendingAgentEvaluationRunIdsRef,
    runs,
  ]);

  const isWorkspaceSettingUp = useMemo(() => {
    const nowMs = Date.now();
    const awaitingLeaseRunIds = activeConversation?.awaitingLeaseRunIds ?? [];
    const pendingRunSubmittedAt = activeConversation?.pendingRunSubmittedAt ?? {};
    return awaitingLeaseRunIds.some(
      (runId) =>
        !isAwaitingLeaseRunStale(pendingRunSubmittedAt[runId], nowMs) &&
        // Silent skill-mode evaluations never surface a "starting workspace"
        // activity row.
        !shouldSuppressAgentEvaluationRunPresence({
          runId,
          pendingAgentEvaluationRunIds: pendingAgentEvaluationRunIdsRef.current,
          messages,
        }),
    );
  }, [
    activeConversation?.awaitingLeaseRunIds,
    activeConversation?.pendingRunSubmittedAt,
    messages,
    pendingAgentEvaluationRunIdsRef,
  ]);

  return {
    conversations,
    activeConversationId,
    messages,
    latestArrivalMessages,
    inputValue,
    inputEditorState,
    assistantEnabled,
    extraAgentHandles,
    agentHandles,
    onAssistantEnabledChange,
    onAddAgentHandle,
    onRemoveAgentHandle,
    isAssistantTyping,
    isWorkspaceSettingUp,
    hasMoreHistory,
    hasResolvedHistory,
    isHistoryLoading,
    isInitialHistoryLoading,
    initialHistoryError,
    retryInitialHistory,
    loadOlderMessages,
    onSelectConversation: handleSelectConversation,
    onCreateConversation: handleCreateConversation,
    onCloseConversation: handleCloseConversation,
    onInputChange: handleInputChange,
    onRecordMessage: recordMessageToController,
    onMaybeAutoTitleConversation: maybeAutoTitleConversation,
    onResolveGroupParticipationBeforeSubmit: resolveGroupParticipationBeforeSubmit,
    onSubmit: handleSubmit,
    stickyMentionedAgentByConversationRef,
  };
}
