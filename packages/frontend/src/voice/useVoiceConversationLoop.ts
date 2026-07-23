import { useCallback, useEffect, useRef } from "react";
import type { HostAudioSessionState } from "../audio/hostAudioSessionState";
import type { StatusIntent } from "../status/useStatus";
import type { HostedVoiceAutoStopConfigInput } from "./hostedVoiceAutoStop";
import { isBenignNoSpeechVoiceInputError } from "./useVoiceInput";
import type { ContinuousVoiceSessionState } from "./useContinuousVoiceSession";
import { appendVoiceDebugEvent, type VoiceDebugScope } from "./voiceDebugState";

const DEFAULT_ASSISTANT_REPLY_TIMEOUT_MS = 45_000;
const DEFAULT_CONTINUOUS_SUBMIT_FAILED_MESSAGE =
  "Voice turn submission failed. Tap once to resume continuous voice.";
const DEFAULT_CONTINUOUS_REPLY_TIMEOUT_MESSAGE =
  "Assistant reply took too long. Continuous voice paused. Tap once to resume.";
const DEFAULT_CONTINUOUS_RESUME_STATUS_MESSAGE =
  "Instafy is active again. Restarting continuous voice…";
const DEFAULT_CONTINUOUS_RESUME_FAILED_MESSAGE =
  "Instafy is active again, but continuous voice could not restart. Tap once to try again.";

type VoiceConversationLoopInteractionMode = "hold" | "tap" | "continuous";
type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;

type UseVoiceConversationLoopOptions = {
  continuousSession: ContinuousVoiceSessionState;
  voiceInteractionMode: VoiceConversationLoopInteractionMode;
  debugScope: VoiceDebugScope;
  voiceSupported: boolean;
  voiceCapture: "hosted" | "device";
  useHostedVoiceCapture: boolean;
  voiceStarting: boolean;
  voiceListening: boolean;
  voiceTranscribing: boolean;
  voiceCompletedTranscript: string;
  voiceError: string | null | undefined;
  busy: boolean;
  latestAssistantId: string | null;
  replyPlaybackSpeaking: boolean;
  hostAudioSession: HostAudioSessionState | null;
  startVoiceTurn: (options?: {
    hostedAutoStop?: HostedVoiceAutoStopConfigInput | null;
  }) => Promise<boolean>;
  stopVoiceTurn: () => Promise<string>;
  cancelVoiceTurn: () => void;
  clearVoiceTurnTranscript: () => void;
  onSubmitTranscript: (transcript: string) => Promise<boolean>;
  onTranscriptResolved?: (transcript: string) => void;
  onStatusChange: (message: string) => void;
  onClearError?: () => void;
  showStatus: ShowStatus;
  pressStartAutoStop?: boolean;
  pressStartStatusText: string;
  continuousStartStatusText: string;
  hostedPressEndStatusText: string;
  devicePressEndStatusText: string;
  stopAfterCurrentTurnStatusText: string;
  continuousStoppedStatusText: string;
  assistantReplyTimeoutMs?: number;
  continuousSubmitFailedMessage?: string;
  continuousReplyTimeoutMessage?: string;
  continuousResumeStatusMessage?: string;
  continuousResumeFailedMessage?: string;
};

export function useVoiceConversationLoop({
  assistantReplyTimeoutMs = DEFAULT_ASSISTANT_REPLY_TIMEOUT_MS,
  busy,
  cancelVoiceTurn,
  clearVoiceTurnTranscript,
  continuousResumeFailedMessage = DEFAULT_CONTINUOUS_RESUME_FAILED_MESSAGE,
  continuousResumeStatusMessage = DEFAULT_CONTINUOUS_RESUME_STATUS_MESSAGE,
  continuousReplyTimeoutMessage = DEFAULT_CONTINUOUS_REPLY_TIMEOUT_MESSAGE,
  continuousSession,
  continuousStartStatusText,
  continuousStoppedStatusText,
  continuousSubmitFailedMessage = DEFAULT_CONTINUOUS_SUBMIT_FAILED_MESSAGE,
  debugScope,
  devicePressEndStatusText,
  hostAudioSession,
  hostedPressEndStatusText,
  latestAssistantId,
  onStatusChange,
  onClearError,
  onSubmitTranscript,
  onTranscriptResolved,
  pressStartAutoStop = false,
  pressStartStatusText,
  replyPlaybackSpeaking,
  showStatus,
  startVoiceTurn,
  stopAfterCurrentTurnStatusText,
  stopVoiceTurn,
  useHostedVoiceCapture,
  voiceCapture,
  voiceCompletedTranscript,
  voiceError,
  voiceInteractionMode,
  voiceListening,
  voiceStarting,
  voiceSupported,
  voiceTranscribing,
}: UseVoiceConversationLoopOptions) {
  const lastSubmittedVoiceTranscriptRef = useRef("");

  useEffect(() => {
    if (voiceInteractionMode === "continuous") {
      return;
    }
    continuousSession.reset();
  }, [continuousSession, voiceInteractionMode]);

  const startVoiceCaptureTurn = useCallback(
    async ({
      autoStop,
      debugEvent,
      statusText,
    }: {
      autoStop: boolean;
      debugEvent: string;
      statusText: string;
    }) => {
      if (!voiceSupported || busy || voiceTranscribing) {
        appendVoiceDebugEvent(
          debugScope,
          `${debugEvent}_ignored`,
          !voiceSupported ? "unsupported" : busy ? "busy" : "transcribing",
        );
        return false;
      }
      appendVoiceDebugEvent(
        debugScope,
        debugEvent,
        autoStop ? "hosted_auto_stop" : voiceCapture,
      );
      lastSubmittedVoiceTranscriptRef.current = "";
      clearVoiceTurnTranscript();
      onClearError?.();
      onStatusChange(statusText);
      const started = await startVoiceTurn({
        hostedAutoStop: autoStop ? true : null,
      });
      if (started) {
        continuousSession.clearPauseMessage();
        appendVoiceDebugEvent(
          debugScope,
          `${debugEvent}_resolved`,
          autoStop ? "hosted_auto_stop" : voiceCapture,
        );
        return true;
      }
      appendVoiceDebugEvent(
        debugScope,
        `${debugEvent}_failed`,
        autoStop ? "hosted_auto_stop" : voiceCapture,
      );
      return false;
    },
    [
      busy,
      clearVoiceTurnTranscript,
      continuousSession,
      debugScope,
      onClearError,
      onStatusChange,
      startVoiceTurn,
      voiceCapture,
      voiceSupported,
      voiceTranscribing,
    ],
  );

  const startContinuousConversationTurn = useCallback(async () => {
    continuousSession.clearForegroundResume();
    const started = await startVoiceCaptureTurn({
      autoStop: true,
      debugEvent: "continuous_start",
      statusText: continuousStartStatusText,
    });
    if (started) {
      continuousSession.markTurnStarted();
    } else {
      continuousSession.markTurnStartFailed();
    }
    return started;
  }, [continuousSession, continuousStartStatusText, startVoiceCaptureTurn]);

  const handleVoicePressStart = useCallback(async () => {
    if (voiceInteractionMode === "continuous") {
      return;
    }
    await startVoiceCaptureTurn({
      autoStop: pressStartAutoStop,
      debugEvent: "press_start",
      statusText: pressStartStatusText,
    });
  }, [
    pressStartAutoStop,
    pressStartStatusText,
    startVoiceCaptureTurn,
    voiceInteractionMode,
  ]);

  const handleVoicePressEnd = useCallback(async () => {
    if (voiceInteractionMode === "continuous") {
      return;
    }
    if (!voiceSupported || busy || voiceTranscribing) {
      appendVoiceDebugEvent(
        debugScope,
        "press_end_ignored",
        !voiceSupported ? "unsupported" : busy ? "busy" : "transcribing",
      );
      return;
    }
    if (useHostedVoiceCapture) {
      if (!voiceListening && !voiceStarting) {
        appendVoiceDebugEvent(debugScope, "press_end_ignored", "hosted_not_recording");
        return;
      }
      appendVoiceDebugEvent(debugScope, "press_end", "hosted");
      onStatusChange(hostedPressEndStatusText);
      const transcript = await stopVoiceTurn();
      appendVoiceDebugEvent(
        debugScope,
        transcript ? "press_end_transcript_ready" : "press_end_transcript_empty",
        transcript || "hosted",
      );
      return;
    }
    if (voiceListening || voiceStarting) {
      appendVoiceDebugEvent(debugScope, "press_end", "device");
      void stopVoiceTurn();
      onStatusChange(devicePressEndStatusText);
      return;
    }
    appendVoiceDebugEvent(debugScope, "press_end_ignored", "device_not_recording");
  }, [
    busy,
    debugScope,
    devicePressEndStatusText,
    hostedPressEndStatusText,
    onStatusChange,
    stopVoiceTurn,
    useHostedVoiceCapture,
    voiceInteractionMode,
    voiceListening,
    voiceStarting,
    voiceSupported,
    voiceTranscribing,
  ]);

  const handleVoiceTap = useCallback(async () => {
    if (voiceInteractionMode === "continuous") {
      if (voiceListening || voiceStarting) {
        continuousSession.reset();
        appendVoiceDebugEvent(debugScope, "continuous_stop_after_current_turn", voiceCapture);
        onStatusChange(stopAfterCurrentTurnStatusText);
        await stopVoiceTurn();
        return;
      }
      if (voiceTranscribing) {
        continuousSession.reset();
        appendVoiceDebugEvent(debugScope, "continuous_stop_while_transcribing", voiceCapture);
        onStatusChange(stopAfterCurrentTurnStatusText);
        return;
      }
      if (
        continuousSession.continuousConversationActive ||
        continuousSession.continuousAwaitingAssistantReply
      ) {
        continuousSession.reset();
        cancelVoiceTurn();
        onStatusChange(continuousStoppedStatusText);
        appendVoiceDebugEvent(debugScope, "continuous_stop", voiceCapture);
        return;
      }
      await startContinuousConversationTurn();
      return;
    }
    if (voiceListening || voiceStarting) {
      await handleVoicePressEnd();
      return;
    }
    await handleVoicePressStart();
  }, [
    cancelVoiceTurn,
    continuousSession,
    continuousStoppedStatusText,
    debugScope,
    handleVoicePressEnd,
    handleVoicePressStart,
    onStatusChange,
    startContinuousConversationTurn,
    stopAfterCurrentTurnStatusText,
    stopVoiceTurn,
    voiceCapture,
    voiceInteractionMode,
    voiceListening,
    voiceStarting,
    voiceTranscribing,
  ]);

  useEffect(() => {
    const trimmedTranscript = voiceCompletedTranscript.trim();
    if (
      !trimmedTranscript ||
      voiceStarting ||
      voiceListening ||
      voiceTranscribing ||
      busy
    ) {
      return;
    }
    if (lastSubmittedVoiceTranscriptRef.current === trimmedTranscript) {
      return;
    }
    lastSubmittedVoiceTranscriptRef.current = trimmedTranscript;
    onTranscriptResolved?.(trimmedTranscript);
    appendVoiceDebugEvent(debugScope, "voice_turn_auto_submit_start", trimmedTranscript);
    void onSubmitTranscript(trimmedTranscript)
      .then((submitted) => {
        if (
          submitted &&
          voiceInteractionMode === "continuous" &&
          continuousSession.continuousConversationActive
        ) {
          continuousSession.markAwaitingAssistantReply(latestAssistantId);
        }
        appendVoiceDebugEvent(
          debugScope,
          submitted ? "voice_turn_auto_submit_success" : "voice_turn_auto_submit_skipped",
          trimmedTranscript,
        );
      })
      .catch(() => {
        if (voiceInteractionMode === "continuous") {
          continuousSession.pause(continuousSubmitFailedMessage);
        }
        appendVoiceDebugEvent(debugScope, "voice_turn_auto_submit_failed", trimmedTranscript);
      })
      .finally(() => {
        clearVoiceTurnTranscript();
      });
  }, [
    busy,
    clearVoiceTurnTranscript,
    continuousSession,
    continuousSubmitFailedMessage,
    debugScope,
    latestAssistantId,
    onSubmitTranscript,
    onTranscriptResolved,
    voiceCompletedTranscript,
    voiceInteractionMode,
    voiceListening,
    voiceStarting,
    voiceTranscribing,
  ]);

  useEffect(() => {
    if (
      voiceInteractionMode !== "continuous" ||
      !continuousSession.continuousConversationActive ||
      !continuousSession.continuousAwaitingAssistantReply ||
      busy ||
      replyPlaybackSpeaking ||
      voiceStarting ||
      voiceListening ||
      voiceTranscribing
    ) {
      return;
    }
    if (!continuousSession.hasAssistantReplyReady(latestAssistantId)) {
      return;
    }
    let cancelled = false;
    const timerId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      continuousSession.consumeAssistantReplyIfReady(latestAssistantId);
      void startContinuousConversationTurn();
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [
    busy,
    continuousSession,
    latestAssistantId,
    replyPlaybackSpeaking,
    startContinuousConversationTurn,
    voiceInteractionMode,
    voiceListening,
    voiceStarting,
    voiceTranscribing,
  ]);

  useEffect(() => {
    if (
      voiceInteractionMode !== "continuous" ||
      !continuousSession.continuousConversationActive ||
      !continuousSession.continuousAwaitingAssistantReply
    ) {
      return;
    }
    const timerId = window.setTimeout(() => {
      continuousSession.pause(continuousReplyTimeoutMessage);
      appendVoiceDebugEvent(
        debugScope,
        "continuous_reply_timeout",
        continuousReplyTimeoutMessage,
      );
      onStatusChange(continuousReplyTimeoutMessage);
    }, assistantReplyTimeoutMs);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    assistantReplyTimeoutMs,
    continuousReplyTimeoutMessage,
    continuousSession,
    debugScope,
    onStatusChange,
    voiceInteractionMode,
  ]);

  useEffect(() => {
    if (
      voiceInteractionMode !== "continuous" ||
      !continuousSession.continuousConversationActive ||
      continuousSession.continuousAwaitingAssistantReply ||
      voiceListening ||
      voiceStarting ||
      voiceTranscribing
    ) {
      return;
    }
    const currentError = voiceError?.trim() ?? "";
    if (!currentError) {
      return;
    }
    const message = isBenignNoSpeechVoiceInputError(currentError)
      ? "No speech detected. Continuous voice paused. Tap once to resume."
      : `${currentError} Tap once to resume continuous voice.`;
    continuousSession.pause(message);
    onStatusChange(message);
    appendVoiceDebugEvent(debugScope, "continuous_voice_error", message);
  }, [
    continuousSession,
    debugScope,
    onStatusChange,
    voiceError,
    voiceInteractionMode,
    voiceListening,
    voiceStarting,
    voiceTranscribing,
  ]);

  useEffect(() => {
    if (
      voiceInteractionMode !== "continuous" ||
      !continuousSession.shouldResumeOnForeground() ||
      !hostAudioSession?.foreground ||
      hostAudioSession.phase === "background" ||
      hostAudioSession.interrupted ||
      busy ||
      replyPlaybackSpeaking ||
      voiceStarting ||
      voiceListening ||
      voiceTranscribing
    ) {
      return;
    }
    let cancelled = false;
    const timerId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      continuousSession.clearForegroundResume();
      continuousSession.pause(continuousResumeStatusMessage);
      onStatusChange(continuousResumeStatusMessage);
      showStatus(continuousResumeStatusMessage, "info", 2500);
      void startContinuousConversationTurn().then((started) => {
        if (cancelled || started) {
          return;
        }
        continuousSession.pause(continuousResumeFailedMessage);
        onStatusChange(continuousResumeFailedMessage);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [
    busy,
    continuousResumeFailedMessage,
    continuousResumeStatusMessage,
    continuousSession,
    hostAudioSession,
    onStatusChange,
    replyPlaybackSpeaking,
    showStatus,
    startContinuousConversationTurn,
    voiceInteractionMode,
    voiceListening,
    voiceStarting,
    voiceTranscribing,
  ]);

  return {
    handleVoicePressEnd,
    handleVoicePressStart,
    handleVoiceTap,
    startContinuousConversationTurn,
    startVoiceCaptureTurn,
  };
}
