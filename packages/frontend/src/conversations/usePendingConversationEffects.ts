import { useEffect, type Dispatch, type MutableRefObject } from "react";
import { isAppInForeground } from "../notifications/assistantMessageNotifications";
import type {
  ControllerConversationCreated,
  ControllerConversationMessage,
  ControllerConversationUpdated,
} from "../services/runtimeController/conversations";
import { isTimelineMessage, isUuid, mapControllerMessageToChat } from "./conversationMessageUtils";
import {
  applyGoalActionMessage,
  createConversationGoalMetadataPatch,
  extractConversationGoalFromMetadata,
  resolveNonRecoverableGoalErrorRunId,
  settleGoalAfterNonRecoverableRunError,
  shouldApplyConversationGoalSnapshot,
} from "./conversationGoals";
import {
  DEFAULT_CONVERSATION_ROUTING_PREFERENCES,
  extractConversationRoutingPreferences,
  type ConversationRoutingPreferences,
} from "./conversationRoutingMetadata";
import {
  extractConversationDelegatedByAgentIdFromMetadata,
  extractConversationLifecycleFromMetadata,
  extractConversationLocalIdFromMessageMetadata,
  extractConversationLocalIdFromMetadata,
  extractConversationOriginMessageIdFromMetadata,
  extractConversationOwnerAgentFromMetadata,
  extractConversationTitleFromMetadata,
  parseTimestamp,
  resolveConversationVisibility,
  resolveConversationVisibilityCandidate,
} from "./conversationMetadata";
import {
  extractLastUserMessageContent,
  isEmptyConversationPlaceholder,
  makeConversationId,
  type ConversationState,
  type ConversationsAction,
  type ConversationsState,
} from "./conversationState";

interface PendingConversationEffectsArgs {
  state: ConversationsState;
  projectKey: string;
  currentUserId: string | null;
  pendingConversationCreations: ControllerConversationCreated[];
  ackConversationCreations: (conversationIds: string[]) => void;
  pendingConversationUpdates: ControllerConversationUpdated[];
  ackConversationUpdates: (conversationIds: string[]) => void;
  pendingConversationMessages: ControllerConversationMessage[];
  ackConversationMessages: (messageIds: string[]) => void;
  lastBackgroundAtRef: MutableRefObject<number>;
  notifiedMessageIdsRef: MutableRefObject<Set<string>>;
  dispatch: Dispatch<ConversationsAction>;
  updateControllerConversationMetadata?: (params: {
    conversationId: string;
    metadata: Record<string, unknown>;
  }) => Promise<unknown>;
}

function conversationsRoutingPreferencesChanged(
  conversation: ConversationState,
  preferences: ConversationRoutingPreferences,
): boolean {
  return (
    conversation.assistantEnabled !== preferences.assistantEnabled ||
    conversation.extraAgentHandles.length !== preferences.extraAgentHandles.length ||
    conversation.extraAgentHandles.some(
      (handle, index) => handle !== preferences.extraAgentHandles[index],
    )
  );
}

export function usePendingConversationEffects({
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
}: PendingConversationEffectsArgs) {
  useEffect(() => {
    if (pendingConversationCreations.length === 0) {
      return;
    }
    if (state.projectKey !== projectKey) {
      return;
    }
    const controllerToLocal = new Map<string, string>();
    state.conversations.forEach((conversation) => {
      if (conversation.controllerId) {
        controllerToLocal.set(conversation.controllerId, conversation.localId);
      }
    });

    const activeConversation =
      state.conversations.find((conversation) => conversation.localId === state.activeId) ??
      null;

    const ackConversationIds: string[] = [];
    pendingConversationCreations.forEach((creation) => {
      if (creation.projectId !== state.projectKey) {
        return;
      }
      const controllerId = creation.conversationId;
      ackConversationIds.push(controllerId);
      if (!isUuid(controllerId)) {
        return;
      }
      if (controllerToLocal.has(controllerId)) {
        return;
      }

      const titleFromMetadata = extractConversationTitleFromMetadata(creation.metadata);
      const localIdFromMetadata = extractConversationLocalIdFromMetadata(creation.metadata);
      const parentConversationIdFromRemote =
        typeof creation.parentConversationId === "string" && isUuid(creation.parentConversationId)
          ? creation.parentConversationId
          : null;
      const threadKindFromRemote =
        parentConversationIdFromRemote && typeof creation.threadKind === "string"
          ? creation.threadKind.trim().toLowerCase() || null
          : null;
      const visibility = resolveConversationVisibility(creation.visibility, creation.metadata);
      const lifecycleStatus = extractConversationLifecycleFromMetadata(
        creation.metadata,
        currentUserId,
      );
      const ownerAgentFromMetadata =
        extractConversationOwnerAgentFromMetadata(creation.metadata);
      const activeGoalFromMetadata = extractConversationGoalFromMetadata(creation.metadata);
      const originMessageIdFromMetadata =
        extractConversationOriginMessageIdFromMetadata(creation.metadata);
      const delegatedByAgentIdFromMetadata =
        extractConversationDelegatedByAgentIdFromMetadata(creation.metadata);
      const routingPreferencesFromMetadata = extractConversationRoutingPreferences(
        creation.metadata,
        currentUserId,
      );
      const routingPreferences =
        routingPreferencesFromMetadata ?? DEFAULT_CONVERSATION_ROUTING_PREFERENCES;
      const createdByIsSelf = currentUserId !== null && creation.createdBy === currentUserId;
      if (createdByIsSelf) {
        if (localIdFromMetadata) {
          const explicit =
            state.conversations.find(
              (conversation) => conversation.localId === localIdFromMetadata,
            ) ?? null;
          if (explicit) {
            if (!explicit.controllerId) {
              dispatch({ type: "SET_CONTROLLER", id: explicit.localId, controllerId });
            }
            if (titleFromMetadata && explicit.title !== titleFromMetadata) {
              dispatch({ type: "SET_TITLE", id: explicit.localId, title: titleFromMetadata });
            }
            if (explicit.visibility !== visibility) {
              dispatch({ type: "SET_VISIBILITY", id: explicit.localId, visibility });
            }
            if (explicit.lifecycleStatus !== lifecycleStatus) {
              dispatch({
                type: "SET_LIFECYCLE",
                id: explicit.localId,
                status: lifecycleStatus,
              });
            }
            if (
              routingPreferencesFromMetadata &&
              conversationsRoutingPreferencesChanged(explicit, routingPreferencesFromMetadata)
            ) {
              dispatch({
                type: "SET_ROUTING_PREFERENCES",
                id: explicit.localId,
                assistantEnabled: routingPreferencesFromMetadata.assistantEnabled,
                extraAgentHandles: routingPreferencesFromMetadata.extraAgentHandles,
              });
            }
            if (
              shouldApplyConversationGoalSnapshot(
                explicit.activeGoal,
                activeGoalFromMetadata,
              )
            ) {
              dispatch({
                type: "SET_GOAL",
                id: explicit.localId,
                goal: activeGoalFromMetadata,
              });
            }
            const resolvedParentConversationId =
              parentConversationIdFromRemote ?? explicit.parentConversationId ?? null;
            const resolvedThreadKind = threadKindFromRemote ?? explicit.threadKind ?? null;
            if (
              explicit.parentConversationId !== resolvedParentConversationId ||
              explicit.threadKind !== resolvedThreadKind ||
              explicit.ownerAgent?.id !== ownerAgentFromMetadata?.id ||
              explicit.ownerAgent?.handle !== ownerAgentFromMetadata?.handle ||
              explicit.originMessageId !== originMessageIdFromMetadata ||
              explicit.delegatedByAgentId !== delegatedByAgentIdFromMetadata
            ) {
              dispatch({
                type: "SET_THREAD_META",
                id: explicit.localId,
                parentConversationId: resolvedParentConversationId,
                threadKind: resolvedThreadKind,
                ownerAgent: ownerAgentFromMetadata,
                originMessageId: originMessageIdFromMetadata,
                delegatedByAgentId: delegatedByAgentIdFromMetadata,
              });
            }
            controllerToLocal.set(controllerId, explicit.localId);
            return;
          }
        }

        const candidate =
          (activeConversation && !activeConversation.controllerId ? activeConversation : null) ??
          (titleFromMetadata
            ? state.conversations.find(
                (conversation) =>
                  !conversation.controllerId && conversation.title === titleFromMetadata,
              ) ?? null
            : null) ??
          (state.conversations.find((conversation) => !conversation.controllerId) ?? null);

        if (candidate) {
          dispatch({ type: "SET_CONTROLLER", id: candidate.localId, controllerId });
          if (titleFromMetadata && candidate.title !== titleFromMetadata) {
            dispatch({ type: "SET_TITLE", id: candidate.localId, title: titleFromMetadata });
          }
          if (candidate.visibility !== visibility) {
            dispatch({ type: "SET_VISIBILITY", id: candidate.localId, visibility });
          }
          if (candidate.lifecycleStatus !== lifecycleStatus) {
            dispatch({
              type: "SET_LIFECYCLE",
              id: candidate.localId,
              status: lifecycleStatus,
            });
          }
          if (
            routingPreferencesFromMetadata &&
            conversationsRoutingPreferencesChanged(candidate, routingPreferencesFromMetadata)
          ) {
            dispatch({
              type: "SET_ROUTING_PREFERENCES",
              id: candidate.localId,
              assistantEnabled: routingPreferencesFromMetadata.assistantEnabled,
              extraAgentHandles: routingPreferencesFromMetadata.extraAgentHandles,
            });
          }
          if (
            shouldApplyConversationGoalSnapshot(
              candidate.activeGoal,
              activeGoalFromMetadata,
            )
          ) {
            dispatch({
              type: "SET_GOAL",
              id: candidate.localId,
              goal: activeGoalFromMetadata,
            });
          }
          const resolvedParentConversationId =
            parentConversationIdFromRemote ?? candidate.parentConversationId ?? null;
          const resolvedThreadKind = threadKindFromRemote ?? candidate.threadKind ?? null;
          if (
            candidate.parentConversationId !== resolvedParentConversationId ||
            candidate.threadKind !== resolvedThreadKind ||
            candidate.ownerAgent?.id !== ownerAgentFromMetadata?.id ||
            candidate.ownerAgent?.handle !== ownerAgentFromMetadata?.handle ||
            candidate.originMessageId !== originMessageIdFromMetadata ||
            candidate.delegatedByAgentId !== delegatedByAgentIdFromMetadata
          ) {
            dispatch({
              type: "SET_THREAD_META",
              id: candidate.localId,
              parentConversationId: resolvedParentConversationId,
              threadKind: resolvedThreadKind,
              ownerAgent: ownerAgentFromMetadata,
              originMessageId: originMessageIdFromMetadata,
              delegatedByAgentId: delegatedByAgentIdFromMetadata,
            });
          }
          controllerToLocal.set(controllerId, candidate.localId);
          return;
        }
      }

      let localId = localIdFromMetadata ?? makeConversationId();
      if (state.conversations.some((conversation) => conversation.localId === localId)) {
        localId = makeConversationId();
      }
      const conversation: ConversationState = {
        localId,
        title: titleFromMetadata ?? `Conversation ${state.sequence}`,
        visibility,
        lifecycleStatus,
        controllerId,
        parentConversationId: parentConversationIdFromRemote,
        threadKind: threadKindFromRemote,
        ownerAgent: ownerAgentFromMetadata,
        activeGoal: activeGoalFromMetadata,
        originMessageId: originMessageIdFromMetadata,
        delegatedByAgentId: delegatedByAgentIdFromMetadata,
        messages: [],
        draft: "",
        draftEditorState: null,
        assistantEnabled: routingPreferences.assistantEnabled,
        extraAgentHandles: [...routingPreferences.extraAgentHandles],
        unreadCount: 0,
        createdAt: parseTimestamp(creation.createdAt ?? null),
        pendingRunIds: [],
        awaitingLeaseRunIds: [],
        pendingRunSubmittedAt: {},
        runtimePreference: null,
      };
      dispatch({ type: "CREATE", conversation, select: false });
      controllerToLocal.set(controllerId, conversation.localId);
    });

    if (ackConversationIds.length > 0) {
      ackConversationCreations(ackConversationIds);
    }
  }, [
    ackConversationCreations,
    currentUserId,
    dispatch,
    pendingConversationCreations,
    projectKey,
    state.activeId,
    state.conversations,
    state.projectKey,
    state.sequence,
  ]);

  useEffect(() => {
    if (pendingConversationUpdates.length === 0) {
      return;
    }
    if (state.projectKey !== projectKey) {
      return;
    }
    const controllerToLocal = new Map<string, string>();
    const localConversations = new Map<string, ConversationState>();
    state.conversations.forEach((conversation) => {
      localConversations.set(conversation.localId, conversation);
      if (conversation.controllerId) {
        controllerToLocal.set(conversation.controllerId, conversation.localId);
      }
    });

    const ackConversationIds: string[] = [];
    pendingConversationUpdates.forEach((update) => {
      if (update.projectId !== state.projectKey) {
        return;
      }
      const controllerId = update.conversationId;
      ackConversationIds.push(controllerId);
      if (!isUuid(controllerId)) {
        return;
      }
      const localId = controllerToLocal.get(controllerId);
      if (!localId) {
        return;
      }
      const conversation = localConversations.get(localId) ?? null;
      if (!conversation) {
        return;
      }
      const titleFromMetadata = extractConversationTitleFromMetadata(update.metadata);
      if (titleFromMetadata && conversation.title !== titleFromMetadata) {
        dispatch({ type: "SET_TITLE", id: localId, title: titleFromMetadata });
      }
      const nextVisibility =
        resolveConversationVisibilityCandidate(update.visibility) ??
        resolveConversationVisibilityCandidate(update.metadata?.visibility);
      if (nextVisibility && conversation.visibility !== nextVisibility) {
        dispatch({ type: "SET_VISIBILITY", id: localId, visibility: nextVisibility });
      }

      const nextLifecycleStatus = extractConversationLifecycleFromMetadata(
        update.metadata,
        currentUserId,
      );
      if (conversation.lifecycleStatus !== nextLifecycleStatus) {
        dispatch({ type: "SET_LIFECYCLE", id: localId, status: nextLifecycleStatus });
      }
      const nextRoutingPreferences = extractConversationRoutingPreferences(
        update.metadata,
        currentUserId,
      );
      const nextActiveGoal = extractConversationGoalFromMetadata(update.metadata);
      if (
        nextRoutingPreferences &&
        conversationsRoutingPreferencesChanged(conversation, nextRoutingPreferences)
      ) {
        dispatch({
          type: "SET_ROUTING_PREFERENCES",
          id: localId,
          assistantEnabled: nextRoutingPreferences.assistantEnabled,
          extraAgentHandles: nextRoutingPreferences.extraAgentHandles,
        });
      }
      if (shouldApplyConversationGoalSnapshot(conversation.activeGoal, nextActiveGoal)) {
        dispatch({
          type: "SET_GOAL",
          id: localId,
          goal: nextActiveGoal,
        });
      }

      const resolvedParentConversationId =
        update.parentConversationId === null
          ? null
          : typeof update.parentConversationId === "string" && isUuid(update.parentConversationId)
            ? update.parentConversationId
            : conversation.parentConversationId;
      const resolvedThreadKind = resolvedParentConversationId
        ? update.threadKind === null
          ? null
          : typeof update.threadKind === "string"
            ? update.threadKind.trim().toLowerCase() || null
            : conversation.threadKind
        : null;
      const ownerAgentFromMetadata =
        extractConversationOwnerAgentFromMetadata(update.metadata);
      const originMessageIdFromMetadata =
        extractConversationOriginMessageIdFromMetadata(update.metadata);
      const delegatedByAgentIdFromMetadata =
        extractConversationDelegatedByAgentIdFromMetadata(update.metadata);
      if (
        conversation.parentConversationId !== resolvedParentConversationId ||
        conversation.threadKind !== resolvedThreadKind ||
        conversation.ownerAgent?.id !== ownerAgentFromMetadata?.id ||
        conversation.ownerAgent?.handle !== ownerAgentFromMetadata?.handle ||
        conversation.originMessageId !== originMessageIdFromMetadata ||
        conversation.delegatedByAgentId !== delegatedByAgentIdFromMetadata
      ) {
        dispatch({
          type: "SET_THREAD_META",
          id: localId,
          parentConversationId: resolvedParentConversationId,
          threadKind: resolvedThreadKind,
          ownerAgent: ownerAgentFromMetadata,
          originMessageId: originMessageIdFromMetadata,
          delegatedByAgentId: delegatedByAgentIdFromMetadata,
        });
      }
    });

    if (ackConversationIds.length > 0) {
      ackConversationUpdates(ackConversationIds);
    }
  }, [
    ackConversationUpdates,
    currentUserId,
    dispatch,
    pendingConversationUpdates,
    projectKey,
    state.conversations,
    state.projectKey,
  ]);

  useEffect(() => {
    if (pendingConversationMessages.length === 0) {
      return;
    }
    if (state.projectKey !== projectKey) {
      return;
    }
    const controllerToLocal = new Map<string, string>();
    state.conversations.forEach((conversation) => {
      if (conversation.controllerId) {
        controllerToLocal.set(conversation.controllerId, conversation.localId);
      }
    });
    const activeConversation =
      state.conversations.find((conversation) => conversation.localId === state.activeId) ??
      null;
    let placeholderId =
      activeConversation && isEmptyConversationPlaceholder(activeConversation)
        ? activeConversation.localId
        : null;
    const ackIds: string[] = [];
    pendingConversationMessages.forEach((message) => {
      if (message.projectId !== state.projectKey) {
        return;
      }
      const controllerId = message.conversationId;
      let conversationId = controllerToLocal.get(controllerId) ?? null;
      if (!conversationId) {
        const metadataLocalId = extractConversationLocalIdFromMessageMetadata(message.metadata);
        if (metadataLocalId) {
          const conversationMatch =
            state.conversations.find(
              (conversation) => conversation.localId === metadataLocalId,
            ) ?? null;
          if (
            conversationMatch &&
            (!conversationMatch.controllerId || conversationMatch.controllerId === controllerId)
          ) {
            if (!conversationMatch.controllerId) {
              dispatch({
                type: "SET_CONTROLLER",
                id: conversationMatch.localId,
                controllerId,
              });
            }
            conversationId = conversationMatch.localId;
            controllerToLocal.set(controllerId, conversationId);
          }
        }
      }
      if (!conversationId && message.role === "user") {
        const normalizedContent = message.content.trim();
        if (activeConversation && !activeConversation.controllerId) {
          const activeMatch = extractLastUserMessageContent(activeConversation);
          if (activeMatch && activeMatch === normalizedContent) {
            dispatch({
              type: "SET_CONTROLLER",
              id: activeConversation.localId,
              controllerId,
            });
            conversationId = activeConversation.localId;
            controllerToLocal.set(controllerId, conversationId);
          }
        }
        if (!conversationId) {
          const match =
            normalizedContent.length > 0
              ? state.conversations.find((conversation) => {
                  if (conversation.controllerId) {
                    return false;
                  }
                  const lastUserContent = extractLastUserMessageContent(conversation);
                  return lastUserContent ? lastUserContent === normalizedContent : false;
                })
              : null;
          if (match) {
            dispatch({ type: "SET_CONTROLLER", id: match.localId, controllerId });
            conversationId = match.localId;
            controllerToLocal.set(controllerId, conversationId);
          }
        }
      }
      if (!conversationId && placeholderId) {
        dispatch({ type: "SET_CONTROLLER", id: placeholderId, controllerId });
        conversationId = placeholderId;
        controllerToLocal.set(controllerId, conversationId);
        placeholderId = null;
      }
      if (!conversationId) {
        const conversation: ConversationState = {
          localId: makeConversationId(),
          title: `Conversation ${state.sequence}`,
          visibility: "public",
          lifecycleStatus: "active",
          controllerId,
          parentConversationId: null,
          threadKind: null,
          ownerAgent: null,
          activeGoal: null,
          originMessageId: null,
          delegatedByAgentId: null,
          messages: [],
          draft: "",
          draftEditorState: null,
          assistantEnabled: DEFAULT_CONVERSATION_ROUTING_PREFERENCES.assistantEnabled,
          extraAgentHandles: [...DEFAULT_CONVERSATION_ROUTING_PREFERENCES.extraAgentHandles],
          unreadCount: 0,
          createdAt: parseTimestamp(message.createdAt ?? null),
          pendingRunIds: [],
          awaitingLeaseRunIds: [],
          pendingRunSubmittedAt: {},
          runtimePreference: null,
        };
        dispatch({ type: "CREATE", conversation, select: false });
        conversationId = conversation.localId;
        controllerToLocal.set(controllerId, conversationId);
      }
      const chatMessage = mapControllerMessageToChat(message);
      const localConversation =
        state.conversations.find((conversation) => conversation.localId === conversationId) ??
        null;
      let goalFromAction = applyGoalActionMessage(
        localConversation?.activeGoal ?? null,
        chatMessage,
        currentUserId,
      );
      if (!goalFromAction.changed && localConversation) {
        goalFromAction = settleGoalAfterNonRecoverableRunError(
          localConversation.activeGoal,
          localConversation.messages,
          chatMessage,
          currentUserId,
        );
      }
      if (goalFromAction.changed) {
        const failedRunId = localConversation
          ? resolveNonRecoverableGoalErrorRunId(
              localConversation.activeGoal,
              localConversation.messages,
              chatMessage,
            )
          : null;
        dispatch({
          type: "SET_GOAL",
          id: conversationId,
          goal: goalFromAction.goal,
        });
        if (failedRunId) {
          dispatch({ type: "UNLINK_RUN", runId: failedRunId });
        }
        if (controllerId) {
          void updateControllerConversationMetadata?.({
            conversationId: controllerId,
            metadata: createConversationGoalMetadataPatch(goalFromAction.goal),
          }).catch((error) => {
            console.warn("Failed to persist conversation goal update", error);
          });
        }
      }
      dispatch({
        type: "APPLY_REMOTE_MESSAGE",
        conversationId,
        message: chatMessage,
        currentUserId,
      });
      const appInForegroundNow = isAppInForeground();
      const hasPendingAssistantWork = Boolean(
        localConversation &&
          (localConversation.pendingRunIds.length > 0 ||
            localConversation.awaitingLeaseRunIds.length > 0),
      );
      const recentlyBackgroundedWhileWaiting =
        message.role === "assistant" &&
        hasPendingAssistantWork &&
        lastBackgroundAtRef.current > 0 &&
        Date.now() - lastBackgroundAtRef.current <= 8_000;

      if (
        (!appInForegroundNow || recentlyBackgroundedWhileWaiting) &&
        !notifiedMessageIdsRef.current.has(message.id)
      ) {
        const shouldNotify =
          (message.role === "assistant" && !isTimelineMessage(chatMessage)) ||
          (message.role === "user" &&
            chatMessage.authorId &&
            (!currentUserId || chatMessage.authorId !== currentUserId));
        if (shouldNotify) {
          notifiedMessageIdsRef.current.add(message.id);
          // The controller's durable event owns notification presentation. This
          // stream still maintains message/read state and Home's Needs you lane.
        }
      }
      ackIds.push(message.id);
    });
    if (ackIds.length > 0) {
      ackConversationMessages(ackIds);
    }
  }, [
    ackConversationMessages,
    currentUserId,
    dispatch,
    lastBackgroundAtRef,
    notifiedMessageIdsRef,
    pendingConversationMessages,
    projectKey,
    state.activeId,
    state.conversations,
    state.projectKey,
    state.sequence,
    updateControllerConversationMetadata,
  ]);
}
