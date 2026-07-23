import { useCallback, type Dispatch, type MutableRefObject } from "react";
import { controllerClient } from "../sdk/instafy";
import {
  createConversationRoutingMetadataPatch,
  type ConversationRoutingPreferences,
} from "./conversationRoutingMetadata";
import {
  createConversationGoalMetadataPatch,
  type ConversationGoal,
} from "./conversationGoals";
import {
  getConversationLifecycleMetadataKey,
  type ConversationLifecycleStatus,
} from "./conversationMetadata";
import type { ConversationsAction, ConversationsState } from "./conversationState";

const runtimeControllerEnabled = controllerClient.core.enabled;

type ControllerConversationMetadataUpdater = (args: {
  conversationId: string;
  metadata: Record<string, unknown>;
}) => Promise<unknown>;

interface ConversationMetadataPersistenceArgs {
  latestStateRef: MutableRefObject<ConversationsState>;
  currentUserId: string | null;
  dispatch: Dispatch<ConversationsAction>;
  updateControllerConversationMetadata: ControllerConversationMetadataUpdater;
}

export function useConversationMetadataPersistence({
  latestStateRef,
  currentUserId,
  dispatch,
  updateControllerConversationMetadata,
}: ConversationMetadataPersistenceArgs) {
  const setConversationLifecycleStatus = useCallback(
    (conversationId: string, status: ConversationLifecycleStatus) => {
      dispatch({ type: "SET_LIFECYCLE", id: conversationId, status });

      const userId = currentUserId;
      if (!runtimeControllerEnabled || !userId) {
        return;
      }
      const conversation =
        latestStateRef.current.conversations.find(
          (entry) => entry.localId === conversationId,
        ) ?? null;
      if (!conversation?.controllerId) {
        return;
      }
      const metadataKey = getConversationLifecycleMetadataKey(userId);
      void updateControllerConversationMetadata({
        conversationId: conversation.controllerId,
        metadata: {
          [metadataKey]: {
            status,
            updatedAt: new Date().toISOString(),
          },
        },
      });
    },
    [currentUserId, dispatch, latestStateRef, updateControllerConversationMetadata],
  );

  const persistConversationRoutingPreferences = useCallback(
    (conversationId: string, preferences: ConversationRoutingPreferences) => {
      if (!runtimeControllerEnabled || !currentUserId) {
        return;
      }
      const conversation =
        latestStateRef.current.conversations.find(
          (entry) => entry.localId === conversationId,
        ) ?? null;
      if (!conversation?.controllerId) {
        return;
      }
      void updateControllerConversationMetadata({
        conversationId: conversation.controllerId,
        metadata: createConversationRoutingMetadataPatch(currentUserId, preferences),
      });
    },
    [currentUserId, latestStateRef, updateControllerConversationMetadata],
  );

  const persistConversationGoal = useCallback(
    (conversationId: string, goal: ConversationGoal | null) => {
      if (!runtimeControllerEnabled || !currentUserId) {
        return;
      }
      const conversation =
        latestStateRef.current.conversations.find(
          (entry) => entry.localId === conversationId,
        ) ?? null;
      if (!conversation?.controllerId) {
        return;
      }
      void updateControllerConversationMetadata({
        conversationId: conversation.controllerId,
        metadata: createConversationGoalMetadataPatch(goal),
      });
    },
    [currentUserId, latestStateRef, updateControllerConversationMetadata],
  );

  return {
    setConversationLifecycleStatus,
    persistConversationRoutingPreferences,
    persistConversationGoal,
  };
}
