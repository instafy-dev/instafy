import { useCallback, useRef, useState } from "react";

type PauseContinuousVoiceSessionOptions = {
  resumeOnForeground?: boolean;
};

export type ContinuousVoiceSessionState = {
  continuousConversationActive: boolean;
  continuousAwaitingAssistantReply: boolean;
  continuousPauseMessage: string | null;
  clearPauseMessage: () => void;
  markTurnStarted: () => void;
  markTurnStartFailed: () => void;
  reset: () => void;
  pause: (
    message: string,
    options?: PauseContinuousVoiceSessionOptions,
  ) => void;
  markAwaitingAssistantReply: (replyFloorId: string | null) => void;
  hasAssistantReplyReady: (latestAssistantId: string | null) => boolean;
  consumeAssistantReplyIfReady: (latestAssistantId: string | null) => boolean;
  shouldResumeOnForeground: () => boolean;
  clearForegroundResume: () => void;
};

export function useContinuousVoiceSession(): ContinuousVoiceSessionState {
  const [continuousConversationActive, setContinuousConversationActive] = useState(false);
  const [continuousAwaitingAssistantReply, setContinuousAwaitingAssistantReply] = useState(false);
  const [continuousPauseMessage, setContinuousPauseMessage] = useState<string | null>(null);
  const continuousReplyFloorIdRef = useRef<string | null>(null);
  const continuousResumeOnForegroundRef = useRef(false);

  const reset = useCallback(() => {
    setContinuousConversationActive(false);
    setContinuousAwaitingAssistantReply(false);
    setContinuousPauseMessage(null);
    continuousReplyFloorIdRef.current = null;
    continuousResumeOnForegroundRef.current = false;
  }, []);

  const pause = useCallback(
    (message: string, options?: PauseContinuousVoiceSessionOptions) => {
      setContinuousConversationActive(false);
      setContinuousAwaitingAssistantReply(false);
      setContinuousPauseMessage(message);
      continuousReplyFloorIdRef.current = null;
      continuousResumeOnForegroundRef.current = options?.resumeOnForeground === true;
    },
    [],
  );

  const clearPauseMessage = useCallback(() => {
    setContinuousPauseMessage(null);
  }, []);

  const markTurnStarted = useCallback(() => {
    setContinuousConversationActive(true);
    setContinuousAwaitingAssistantReply(false);
    setContinuousPauseMessage(null);
    continuousReplyFloorIdRef.current = null;
    continuousResumeOnForegroundRef.current = false;
  }, []);

  const markTurnStartFailed = useCallback(() => {
    setContinuousConversationActive(false);
    setContinuousAwaitingAssistantReply(false);
  }, []);

  const markAwaitingAssistantReply = useCallback((replyFloorId: string | null) => {
    continuousReplyFloorIdRef.current = replyFloorId;
    setContinuousAwaitingAssistantReply(true);
  }, []);

  const hasAssistantReplyReady = useCallback((latestAssistantId: string | null) => {
    return Boolean(latestAssistantId) && latestAssistantId !== continuousReplyFloorIdRef.current;
  }, []);

  const consumeAssistantReplyIfReady = useCallback((latestAssistantId: string | null) => {
    if (!latestAssistantId || latestAssistantId === continuousReplyFloorIdRef.current) {
      return false;
    }
    continuousReplyFloorIdRef.current = latestAssistantId;
    setContinuousAwaitingAssistantReply(false);
    return true;
  }, []);

  const shouldResumeOnForeground = useCallback(
    () => continuousResumeOnForegroundRef.current,
    [],
  );

  const clearForegroundResume = useCallback(() => {
    continuousResumeOnForegroundRef.current = false;
  }, []);

  return {
    continuousConversationActive,
    continuousAwaitingAssistantReply,
    continuousPauseMessage,
    clearPauseMessage,
    markTurnStarted,
    markTurnStartFailed,
    reset,
    pause,
    markAwaitingAssistantReply,
    hasAssistantReplyReady,
    consumeAssistantReplyIfReady,
    shouldResumeOnForeground,
    clearForegroundResume,
  };
}
