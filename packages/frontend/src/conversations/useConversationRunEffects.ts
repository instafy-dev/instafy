import { useEffect, type Dispatch, type MutableRefObject } from "react";
import type { RunRecord } from "../types";
import { controllerClient } from "../sdk/instafy";
import {
  createConversationGoalMetadataPatch,
  settleGoalAfterTerminalRun,
} from "./conversationGoals";
import {
  isAwaitingLeaseRunStale,
  isQueuedRunStale,
  resolveAwaitingLeaseRunExpiresAt,
} from "./runLiveness";
import type { ConversationState, ConversationsAction } from "./conversationState";

const runtimeControllerEnabled = controllerClient.core.enabled;

interface ConversationRunEffectsArgs {
  conversations: ConversationState[];
  runMap: Record<string, string>;
  runs: Record<string, RunRecord>;
  leasedRunIds: Record<string, true>;
  clearRunLease: (runId: string) => void;
  processedRunMessagesRef: MutableRefObject<Set<string>>;
  pendingLeaseSweepEpoch: number;
  bumpPendingLeaseSweepEpoch: () => void;
  pendingLeaseSweepTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  currentUserId: string | null;
  dispatch: Dispatch<ConversationsAction>;
  updateControllerConversationMetadata?: (params: {
    conversationId: string;
    metadata: Record<string, unknown>;
  }) => Promise<unknown>;
}

export function useConversationRunEffects({
  conversations,
  runMap,
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
}: ConversationRunEffectsArgs) {
  useEffect(() => {
    if (conversations.length === 0) {
      processedRunMessagesRef.current.clear();
    }
  }, [conversations.length, processedRunMessagesRef]);

  useEffect(() => {
    const processed = processedRunMessagesRef.current;
    const nowMs = Date.now();
    const staleRunIdsToUnlink = new Set<string>();
    Object.values(runs).forEach((run) => {
      if (!run.conversationId) {
        return;
      }
      const conversation = conversations.find(
        (entry) => entry.controllerId === run.conversationId,
      );
      if (!conversation) {
        return;
      }

      if (!runtimeControllerEnabled) {
        const message = typeof run.lastMessage === "string" ? run.lastMessage.trim() : "";
        let shouldAppend = false;
        if (message) {
          const key = `${run.id}:${message}`;
          if (!processed.has(key)) {
            processed.add(key);
            shouldAppend = true;
          }
        }
        if (shouldAppend) {
          dispatch({
            type: "APPEND",
            id: conversation.localId,
            messages: [
              {
                id: `assistant-${run.id}-${Date.now()}`,
                role: "assistant",
                content: message,
                timestamp: Date.now(),
              },
            ],
          });
        }
      }

      if (
        run.status === "success" ||
        run.status === "failed" ||
        run.status === "canceled" ||
        isQueuedRunStale(run, nowMs)
      ) {
        const goalResult = settleGoalAfterTerminalRun(
          conversation.activeGoal,
          run.metadata,
          run.status,
          currentUserId,
        );
        if (goalResult.changed) {
          dispatch({
            type: "SET_GOAL",
            id: conversation.localId,
            goal: goalResult.goal,
          });
          if (conversation.controllerId && updateControllerConversationMetadata) {
            void updateControllerConversationMetadata({
              conversationId: conversation.controllerId,
              metadata: createConversationGoalMetadataPatch(goalResult.goal),
            }).catch((error) => {
              console.warn("Failed to persist terminal goal state", error);
            });
          }
        }
        staleRunIdsToUnlink.add(run.id);
      }
    });
    if (staleRunIdsToUnlink.size > 0) {
      staleRunIdsToUnlink.forEach((runId) => {
        dispatch({ type: "UNLINK_RUN", runId });
      });
    }
  }, [
    conversations,
    currentUserId,
    dispatch,
    processedRunMessagesRef,
    runs,
    updateControllerConversationMetadata,
  ]);

  useEffect(() => {
    if (pendingLeaseSweepTimeoutRef.current) {
      clearTimeout(pendingLeaseSweepTimeoutRef.current);
      pendingLeaseSweepTimeoutRef.current = null;
    }

    const nowMs = Date.now();
    let nextSweepAt: number | null = null;
    const staleRunIdsToUnlink = new Set<string>();

    conversations.forEach((conversation) => {
      conversation.awaitingLeaseRunIds.forEach((runId) => {
        if (runs[runId]) {
          return;
        }
        const submittedAt = conversation.pendingRunSubmittedAt[runId] ?? null;
        if (isAwaitingLeaseRunStale(submittedAt, nowMs)) {
          staleRunIdsToUnlink.add(runId);
          return;
        }
        const expiresAt = resolveAwaitingLeaseRunExpiresAt(submittedAt);
        if (expiresAt !== null && (nextSweepAt === null || expiresAt < nextSweepAt)) {
          nextSweepAt = expiresAt;
        }
      });
    });

    if (staleRunIdsToUnlink.size > 0) {
      staleRunIdsToUnlink.forEach((runId) => {
        dispatch({ type: "UNLINK_RUN", runId });
      });
      return;
    }

    if (nextSweepAt !== null) {
      pendingLeaseSweepTimeoutRef.current = setTimeout(() => {
        pendingLeaseSweepTimeoutRef.current = null;
        bumpPendingLeaseSweepEpoch();
      }, Math.max(0, nextSweepAt - Date.now()));
    }

    return () => {
      if (pendingLeaseSweepTimeoutRef.current) {
        clearTimeout(pendingLeaseSweepTimeoutRef.current);
        pendingLeaseSweepTimeoutRef.current = null;
      }
    };
  }, [
    bumpPendingLeaseSweepEpoch,
    conversations,
    dispatch,
    pendingLeaseSweepEpoch,
    pendingLeaseSweepTimeoutRef,
    runs,
  ]);

  useEffect(() => {
    const runIds = Object.keys(leasedRunIds ?? {});
    if (runIds.length === 0) {
      return;
    }
    runIds.forEach((runId) => {
      const conversationId = runMap[runId];
      if (!conversationId) {
        return;
      }
      dispatch({ type: "LEASE_CONFIRMED", conversationId, runId });
      clearRunLease(runId);
    });
  }, [clearRunLease, dispatch, leasedRunIds, runMap]);
}
