import { useCallback, useEffect, useState } from "react";
import {
  executeLocalCapabilityPrompt,
  type LocalCapabilityStatusValue,
} from "@instafy/frontend/feature-api/runtime";
import {
  createActiveRobotLearningSession,
  resolveEmbodiedBehaviorPrompt,
  type ActiveRobotLearningSession,
} from "../../robot";
import { normalizeKnoshConversationPrompt } from "../knoshRuntimeState";

const SESSION_ID = "instafy_knosh_runtime";

function readActiveLearningSession(metadata: Record<string, unknown> | undefined) {
  const learning = metadata?.robotLearning;
  if (!learning || typeof learning !== "object") {
    return null;
  }
  const activeSession = (learning as { activeSession?: unknown }).activeSession;
  if (!activeSession || typeof activeSession !== "object") {
    return null;
  }
  return activeSession as ActiveRobotLearningSession;
}

type ShowStatus = (message: string, intent?: "success" | "error" | "warning" | "info", durationMs?: number) => void;

type UseKnoshRuntimeActionControllerOptions = {
  activeProjectId: string | null | undefined;
  activeConversationId: string | null;
  defaultEmbodiedHandle: string;
  showStatus: ShowStatus;
  refreshHardware: () => Promise<void>;
  voiceRepliesEnabled: boolean;
  speakRuntimeReply: (text: string) => Promise<boolean>;
  submitConversationPrompt: (
    conversationId: string | null,
    prompt: string,
  ) => Promise<unknown>;
  isAssistantTyping: boolean;
  latestAssistantContent?: string | null;
};

export function useKnoshRuntimeActionController({
  activeConversationId,
  activeProjectId,
  defaultEmbodiedHandle,
  isAssistantTyping,
  latestAssistantContent,
  refreshHardware,
  showStatus,
  speakRuntimeReply,
  submitConversationPrompt,
  voiceRepliesEnabled,
}: UseKnoshRuntimeActionControllerOptions) {
  const [activeLearningSession, setActiveLearningSession] =
    useState<ActiveRobotLearningSession | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [conversationSubmitting, setConversationSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runtimeStatusText, setRuntimeStatusText] = useState("Mounted runtime ready");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);

  useEffect(() => {
    if (isAssistantTyping) {
      setRuntimeStatusText("Knosh is thinking…");
    }
  }, [isAssistantTyping]);

  useEffect(() => {
    if (latestAssistantContent?.trim()) {
      setLastResponse(latestAssistantContent);
    }
  }, [latestAssistantContent]);

  const clearActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const executePrompt = useCallback(
    async (prompt: string, source: "voice" | "tap") => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || actionBusy) {
        return;
      }
      if (!activeProjectId) {
        const message =
          "Open a Studio project first so Knosh can use the attached provider from this device.";
        setActionError(message);
        setRuntimeStatusText(message);
        showStatus(message, "warning", 4000);
        return;
      }

      setActionBusy(true);
      setActionError(null);
      setLastPrompt(trimmedPrompt);
      if (source === "voice") {
        setLastTranscript(trimmedPrompt);
      }
      setRuntimeStatusText(
        source === "voice"
          ? "Thinking through the request…"
          : "Routing the command to Knosh…",
      );

      try {
        const result = await executeLocalCapabilityPrompt({
          handle: defaultEmbodiedHandle,
          prompt: trimmedPrompt,
          sessionId: SESSION_ID,
          projectId: activeProjectId ?? null,
          runtimeMode: "knosh_runtime_page",
          learningMode: "knosh_runtime_learning",
          activeLearningSession,
          onStatus: (status: LocalCapabilityStatusValue) => {
            setRuntimeStatusText(typeof status === "string" ? status : status.text);
          },
        });

        const fallbackResolution = resolveEmbodiedBehaviorPrompt(
          trimmedPrompt,
          defaultEmbodiedHandle,
          activeLearningSession,
        );
        const replyText =
          result.responseText ??
          (result.handled ? "Knosh handled that request." : fallbackResolution.detail);
        const metadata =
          result.metadata && typeof result.metadata === "object"
            ? (result.metadata as Record<string, unknown>)
            : undefined;
        const nextLearningSession = readActiveLearningSession(metadata);

        setLastResponse(replyText);
        setActionError(result.error ?? null);
        setRuntimeStatusText(result.error ? "Knosh needs attention" : replyText);
        setActiveLearningSession(
          nextLearningSession
            ? createActiveRobotLearningSession(
                nextLearningSession,
                defaultEmbodiedHandle,
                trimmedPrompt,
                activeLearningSession,
              )
            : null,
        );
        if (result.error) {
          showStatus(result.error, "error", 4000);
        } else {
          showStatus(replyText, "success", 2500);
        }
        if (voiceRepliesEnabled && !result.error) {
          void speakRuntimeReply(replyText);
        }
        await refreshHardware();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        setLastResponse(message);
        setRuntimeStatusText("Knosh could not complete that request");
        showStatus(message, "error", 4000);
      } finally {
        setActionBusy(false);
      }
    },
    [
      actionBusy,
      activeLearningSession,
      activeProjectId,
      defaultEmbodiedHandle,
      refreshHardware,
      showStatus,
      speakRuntimeReply,
      voiceRepliesEnabled,
    ],
  );

  const submitConversationTurn = useCallback(
    async (prompt: string, source: "voice" | "tap") => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || conversationSubmitting || actionBusy) {
        return false;
      }
      if (!activeProjectId) {
        const message =
          "Open a Studio project first so Knosh can use the attached provider from this device.";
        setActionError(message);
        setRuntimeStatusText(message);
        showStatus(message, "warning", 4000);
        return false;
      }
      const normalizedPrompt = normalizeKnoshConversationPrompt(trimmedPrompt);
      setConversationSubmitting(true);
      setActionError(null);
      setLastPrompt(trimmedPrompt);
      if (source === "voice") {
        setLastTranscript(trimmedPrompt);
      }
      setRuntimeStatusText("Sending the request to Knosh…");

      try {
        await submitConversationPrompt(activeConversationId, normalizedPrompt);
        setRuntimeStatusText("Knosh is responding…");
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        setRuntimeStatusText("Knosh could not start that conversation");
        showStatus(message, "error", 4000);
        return false;
      } finally {
        setConversationSubmitting(false);
      }
    },
    [
      actionBusy,
      activeConversationId,
      activeProjectId,
      conversationSubmitting,
      showStatus,
      submitConversationPrompt,
    ],
  );

  return {
    activeLearningSession,
    actionBusy,
    actionError,
    clearActionError,
    conversationSubmitting,
    executePrompt,
    lastPrompt,
    lastResponse,
    lastTranscript,
    runtimeStatusText,
    setActionError,
    setLastTranscript,
    setRuntimeStatusText,
    submitConversationTurn,
  };
}
