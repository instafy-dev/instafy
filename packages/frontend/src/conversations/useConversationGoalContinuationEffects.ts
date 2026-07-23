import { useEffect, useMemo, useRef } from "react";
import type { RunRecord } from "../types";
import type { ConversationState } from "./conversationState";
import {
  activeGoalPromptMetadata,
  buildGoalContinuationPrompt,
  createConversationGoalMetadataPatch,
  decideGoalContinuation,
  selectLatestSuccessfulGoalRuns,
  updateConversationGoal,
} from "./conversationGoals";
import { getChatClientSessionId } from "./chatClientIdentity";
import {
  buildConversationClientMetadata,
  createConversationMessage,
} from "./conversationSubmitHelpers";
import type { useConversationControllerDispatch } from "./useConversationControllerDispatch";

type SendPromptToController = ReturnType<
  typeof useConversationControllerDispatch
>["sendPromptToController"];
type UpdateControllerConversationMetadata = (args: {
  conversationId: string;
  metadata: Record<string, unknown>;
}) => Promise<unknown>;

const fallbackContinuedGoalRunIds = new Set<string>();
const goalContinuationTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

declare global {
  interface Window {
    __INSTAFY_CONTINUED_GOAL_RUN_IDS__?: Set<string>;
  }
}

function getContinuedGoalRunIds(): Set<string> {
  if (typeof window === "undefined") {
    return fallbackContinuedGoalRunIds;
  }
  window.__INSTAFY_CONTINUED_GOAL_RUN_IDS__ ??= new Set<string>();
  return window.__INSTAFY_CONTINUED_GOAL_RUN_IDS__;
}

export function useConversationGoalContinuationEffects({
  conversations,
  runs,
  currentUserId,
  setConversationGoal,
  appendMessages,
  sendPromptToController,
  updateControllerConversationMetadata,
}: {
  conversations: ConversationState[];
  runs: Record<string, RunRecord>;
  currentUserId: string | null;
  setConversationGoal: (conversationId: string, goal: ConversationState["activeGoal"]) => void;
  appendMessages: (conversationId: string, messages: ConversationState["messages"]) => void;
  sendPromptToController: SendPromptToController;
  updateControllerConversationMetadata: UpdateControllerConversationMetadata;
}) {
  const chatClientSessionId = useMemo(() => getChatClientSessionId(), []);
  const latestConversationsRef = useRef(conversations);
  const latestRunsRef = useRef(runs);

  useEffect(() => {
    latestConversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    latestRunsRef.current = runs;
  }, [runs]);

  useEffect(() => {
    const terminalGoalRuns = selectLatestSuccessfulGoalRuns({
      conversations,
      runs: Object.values(runs),
    });
    if (terminalGoalRuns.length === 0) {
      return;
    }
    const continuedGoalRunIds = getContinuedGoalRunIds();

    terminalGoalRuns.forEach((run) => {
      if (continuedGoalRunIds.has(run.id)) {
        return;
      }
      const conversation =
        conversations.find((entry) => entry.controllerId === run.conversationId) ?? null;
      if (!conversation?.activeGoal || conversation.activeGoal.status !== "active") {
        return;
      }
      const pendingRuns = conversation.pendingRunIds
        .map((runId) => runs[runId])
        .filter((entry): entry is RunRecord => Boolean(entry));
      const decision = decideGoalContinuation({
        goal: conversation.activeGoal,
        terminalRun: run,
        messages: conversation.messages,
        pendingRuns,
      });
      if (decision.reason === "goal_run_already_pending") {
        continuedGoalRunIds.add(run.id);
        return;
      }
      if (decision.reason === "turn_limit_reached") {
        continuedGoalRunIds.add(run.id);
        const blockedGoal = updateConversationGoal(
          conversation.activeGoal,
          {
            status: "blocked",
            progressSummary: "Stopped after the automatic goal continuation turn limit.",
          },
          currentUserId,
        );
        setConversationGoal(conversation.localId, blockedGoal);
        if (conversation.controllerId) {
          void updateControllerConversationMetadata({
            conversationId: conversation.controllerId,
            metadata: createConversationGoalMetadataPatch(blockedGoal),
          }).catch((error) => {
            console.warn("Failed to persist goal continuation limit", error);
          });
        }
        return;
      }
      if (decision.reason === "stagnation_detected") {
        continuedGoalRunIds.add(run.id);
        const blockedGoal = updateConversationGoal(
          conversation.activeGoal,
          {
            status: "blocked",
            progressSummary:
              decision.stagnation?.summary ??
              "Stopped because automatic goal turns no longer showed meaningful progress.",
          },
          currentUserId,
        );
        setConversationGoal(conversation.localId, blockedGoal);
        if (conversation.controllerId) {
          void updateControllerConversationMetadata({
            conversationId: conversation.controllerId,
            metadata: createConversationGoalMetadataPatch(blockedGoal),
          }).catch((error) => {
            console.warn("Failed to persist stagnant goal state", error);
          });
        }
        return;
      }
      if (!decision.shouldContinue) {
        return;
      }

      continuedGoalRunIds.add(run.id);
      const timeoutKey = `${conversation.localId}:${run.id}`;
      if (goalContinuationTimeouts.has(timeoutKey)) {
        return;
      }

      const timeout = setTimeout(() => {
        goalContinuationTimeouts.delete(timeoutKey);
        const latestConversation =
          latestConversationsRef.current.find(
            (entry) => entry.localId === conversation.localId,
          ) ?? null;
        const latestRun = latestRunsRef.current?.[run.id] ?? run;
        if (!latestConversation?.activeGoal) {
          return;
        }
        const latestPendingRuns = latestConversation.pendingRunIds
          .map((runId) => latestRunsRef.current?.[runId])
          .filter((entry): entry is RunRecord => Boolean(entry));
        const latestDecision = decideGoalContinuation({
          goal: latestConversation.activeGoal,
          terminalRun: latestRun,
          messages: latestConversation.messages,
          pendingRuns: latestPendingRuns,
        });
        if (!latestDecision.shouldContinue) {
          return;
        }
        const goal = latestConversation.activeGoal;
        const displayContent = `Continue goal: ${goal.objective}`;
        const dispatchContent = buildGoalContinuationPrompt({
          goal,
          turn: latestDecision.nextTurn,
          stagnation: latestDecision.stagnation,
          messages: latestConversation.messages,
        });
        const metadata = {
          client: buildConversationClientMetadata(chatClientSessionId, currentUserId),
          clientMessageId: `goal-continuation:${goal.id}:${run.id}`,
          goal: activeGoalPromptMetadata(goal),
          goalContinuation: {
            triggerRunId: run.id,
            turn: latestDecision.nextTurn,
          },
          displayContent,
          dispatchContent,
        };

        appendMessages(latestConversation.localId, [
          createConversationMessage("user", displayContent, currentUserId, metadata),
        ]);
        void sendPromptToController(
          latestConversation.localId,
          dispatchContent,
          metadata,
          undefined,
          latestConversation,
        );
      }, 750);
      goalContinuationTimeouts.set(timeoutKey, timeout);
    });
  }, [
    appendMessages,
    chatClientSessionId,
    conversations,
    currentUserId,
    runs,
    sendPromptToController,
    setConversationGoal,
    updateControllerConversationMetadata,
  ]);
}
