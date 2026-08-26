import {
  type ComponentProps,
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useHostAudioDiagnostics } from "../../../audio/useHostAudioDiagnostics";
import { useHostAudioSessionState } from "../../../audio/useHostAudioSessionState";
import { serializeProviderEventIdentity } from "../../../extensions/providerEvents";
import { ProviderTriggerNotice } from "../../../extensions/ProviderTriggerNotice";
import {
  clearProviderTriggerQueue,
  dismissProviderTriggerCandidate,
  useProviderTriggerQueue,
} from "../../../extensions/providerTriggerQueue";
import type { StatusIntent } from "../../../status/useStatus";
import { useChatVoicePreferencesState } from "../../../voice/useChatVoicePreferencesState";
import {
  isBenignNoSpeechVoiceInputError,
  mergeVoiceTranscript,
} from "../../../voice/useVoiceInput";
import { useVoiceTurnController } from "../../../voice/useVoiceTurnController";
import { useVoiceTurnRecovery } from "../../../voice/useVoiceTurnRecovery";
import {
  appendVoiceDebugEvent,
  usePublishVoiceDebugState,
  useVoiceDebugState,
} from "../../../voice/voiceDebugState";
import { useContinuousVoiceSession } from "../../../voice/useContinuousVoiceSession";
import type { ChatInputHandle } from "./chat-input/ChatInput";
import type { ChatSubmitOverride } from "./chatSubmitPlanning";
import type { ChatMessage } from "../types";
import { deriveChatVoiceComposerViewState } from "./chatVoiceComposerViewState";

const CHAT_CONTINUOUS_ASSISTANT_REPLY_TIMEOUT_MS = 45_000;

type VoiceProviderTriggerNoticeProps = ComponentProps<typeof ProviderTriggerNotice> | null;
type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;
type OnInputChange = (
  conversationId: string | null,
  value: string,
  editorState: string | null,
) => void;
type SubmitMessageFn = (
  override?: ChatSubmitOverride,
  options?: { allowWhileBusy?: boolean; metadata?: Record<string, unknown> | null },
) => Promise<boolean>;

type UseChatVoiceComposerControllerOptions = {
  activeConversationId: string | null;
  activeProjectId: string | null;
  chatInputRef: MutableRefObject<ChatInputHandle | null>;
  imageAttachmentCount: number;
  inputValue: string;
  invokeSubmitMessage: SubmitMessageFn;
  isAssistantTyping: boolean;
  latestInputValueRef: MutableRefObject<string>;
  messages: ChatMessage[];
  onInputChange: OnInputChange;
  scheduleSubmitMessage: () => void;
  sendingAttachment: boolean;
  showStatus: ShowStatus;
  touchLikeInput: boolean;
};

export function useChatVoiceComposerController({
  activeConversationId,
  activeProjectId,
  chatInputRef,
  imageAttachmentCount,
  inputValue,
  invokeSubmitMessage,
  isAssistantTyping,
  latestInputValueRef,
  messages,
  onInputChange,
  scheduleSubmitMessage,
  sendingAttachment,
  showStatus,
  touchLikeInput,
}: UseChatVoiceComposerControllerOptions) {
  const voiceDraftBaseRef = useRef<string | null>(null);
  const voiceHoldRequestedRef = useRef(false);
  const voiceStartAttemptRef = useRef(0);
  const voicePendingFinalTranscriptTimerRef = useRef<number | null>(null);
  const voiceConversationTurnRef = useRef<{
    attemptId: number;
    autoSubmit: boolean;
    submitted: boolean;
  } | null>(null);
  const voiceAutoSubmittingRef = useRef(false);
  const wakeWordAutoStartTriggerRef = useRef<string | null>(null);

  const [voiceHoldActive, setVoiceHoldActive] = useState(false);
  const {
    chatVoiceInteractionMode,
    chatWakeWordArmed,
    setChatVoiceInteractionMode,
    setChatWakeWordArmed,
  } = useChatVoicePreferencesState(activeProjectId);
  const {
    continuousConversationActive,
    continuousAwaitingAssistantReply,
    continuousPauseMessage,
    clearPauseMessage: clearContinuousPauseMessage,
    markTurnStarted: markContinuousTurnStarted,
    markTurnStartFailed: markContinuousTurnStartFailed,
    reset: resetContinuousSession,
    pause: pauseContinuousSession,
    markAwaitingAssistantReply: markContinuousAwaitingAssistantReply,
    hasAssistantReplyReady,
    consumeAssistantReplyIfReady,
    shouldResumeOnForeground,
    clearForegroundResume,
  } = useContinuousVoiceSession();

  const providerTriggerCandidates = useProviderTriggerQueue();
  const primaryProviderTriggerCandidate = providerTriggerCandidates[0] ?? null;
  const primaryWakeWordTriggerCandidate =
    primaryProviderTriggerCandidate?.latestEvent.kind === "audio.wake_word_detected"
      ? primaryProviderTriggerCandidate
      : null;
  const primaryWakeWordTriggerIdentity = primaryWakeWordTriggerCandidate
    ? serializeProviderEventIdentity(
        primaryWakeWordTriggerCandidate.latestEvent as Record<string, unknown>,
      )
    : null;

  const handleVoiceInputError = useCallback(
    (message: string) => {
      if (voicePendingFinalTranscriptTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(voicePendingFinalTranscriptTimerRef.current);
        voicePendingFinalTranscriptTimerRef.current = null;
      }
      voiceHoldRequestedRef.current = false;
      voiceConversationTurnRef.current = null;
      voiceAutoSubmittingRef.current = false;
      voiceDraftBaseRef.current = null;
      setVoiceHoldActive(false);
      if (!isBenignNoSpeechVoiceInputError(message)) {
        showStatus(message, "error", 0);
      }
    },
    [showStatus],
  );

  const voiceTurn = useVoiceTurnController({
    mode: "auto",
    preferHostedCapture: chatVoiceInteractionMode === "continuous",
    hostedBackendResolutionEnabled: chatVoiceInteractionMode === "continuous",
    onError: handleVoiceInputError,
    projectId: activeProjectId,
  });
  const supportsContinuousVoiceMode = voiceTurn.hostedCaptureSupported;
  const continuousVoiceResolving =
    chatVoiceInteractionMode === "continuous" &&
    voiceTurn.backendResolutionStatus === "pending" &&
    !supportsContinuousVoiceMode;
  const voiceInputSupported = voiceTurn.supported;
  const voiceInputStarting = voiceTurn.starting;
  const voiceInputListening = voiceTurn.listening;
  const voiceInputTranscribing = voiceTurn.transcribing;
  const voiceInputRoute = voiceTurn.effectiveMode;
  const voiceInputCapture = voiceTurn.useHostedVoiceCapture ? "hosted" : "device";
  const voiceInputBackendLabel = voiceTurn.backendLabel;
  const voiceInputError = voiceTurn.error;
  const voiceInputState = voiceTurn.state;

  const { value: chatHostAudioDiagnostics } = useHostAudioDiagnostics({
    enabled: voiceInputSupported,
    refreshIntervalMs: 15_000,
  });
  const { value: chatHostAudioSession } = useHostAudioSessionState({
    enabled: voiceInputSupported,
    diagnostics: chatHostAudioDiagnostics,
    voiceState: voiceInputState,
  });

  const voiceDebugState = useVoiceDebugState({
    route: voiceInputRoute,
    capture: voiceInputCapture,
    state: voiceInputState,
    supported: voiceInputSupported,
    transcriptionBackendLabel: voiceInputBackendLabel,
    mode: "auto",
    interactionMode: `chat:${chatVoiceInteractionMode}`,
    lastError: voiceInputError,
  });
  useVoiceTurnRecovery({
    scope: "chatComposer",
    sessionState: chatHostAudioSession,
    voiceState: voiceInputState,
    interactionMode: chatVoiceInteractionMode,
    continuousSessionActive: continuousConversationActive || continuousAwaitingAssistantReply,
    cancelVoiceTurn: voiceTurn.cancel,
    onNotice: (notice) => {
      if (chatVoiceInteractionMode === "continuous") {
        pauseContinuousSession(notice.message, {
          resumeOnForeground: notice.kind === "background_pause",
        });
      }
      showStatus(notice.message, notice.tone, notice.tone === "warning" ? 4200 : 2800);
    },
  });
  usePublishVoiceDebugState("chatComposer", voiceDebugState);

  const voiceInputTranscript =
    voiceTurn.liveTranscript.trim().length > 0
      ? voiceTurn.liveTranscript
      : voiceTurn.completedTranscript;
  const startVoiceInput = voiceTurn.start;
  const stopVoiceInput = voiceTurn.stop;
  const cancelVoiceInput = voiceTurn.cancel;
  const clearVoiceInputTranscript = voiceTurn.clearTranscript;

  const latestAssistantMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.content.trim()) {
        return message;
      }
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (chatVoiceInteractionMode !== "hold") {
      setChatVoiceInteractionMode("hold");
    }
  }, [chatVoiceInteractionMode, setChatVoiceInteractionMode]);

  useEffect(() => {
    if (chatVoiceInteractionMode === "continuous") {
      return;
    }
    resetContinuousSession();
  }, [chatVoiceInteractionMode, resetContinuousSession]);

  useEffect(() => {
    if (voicePendingFinalTranscriptTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(voicePendingFinalTranscriptTimerRef.current);
      voicePendingFinalTranscriptTimerRef.current = null;
    }
    voiceHoldRequestedRef.current = false;
    voiceConversationTurnRef.current = null;
    voiceAutoSubmittingRef.current = false;
    setVoiceHoldActive(false);
    resetContinuousSession();
    voiceDraftBaseRef.current = null;
    clearVoiceInputTranscript();
    cancelVoiceInput();
  }, [activeConversationId, cancelVoiceInput, clearVoiceInputTranscript, resetContinuousSession]);

  useEffect(() => {
    if (voiceAutoSubmittingRef.current) {
      return;
    }
    if (
      voicePendingFinalTranscriptTimerRef.current !== null &&
      (
        voiceInputListening ||
        voiceInputTranscribing ||
        voiceHoldActive ||
        voiceInputTranscript.length > 0
      ) &&
      typeof window !== "undefined"
    ) {
      window.clearTimeout(voicePendingFinalTranscriptTimerRef.current);
      voicePendingFinalTranscriptTimerRef.current = null;
    }
    if (voiceDraftBaseRef.current == null || !voiceInputTranscript) {
      if (
        voiceDraftBaseRef.current != null &&
        !voiceInputListening &&
        !voiceInputTranscribing &&
        !voiceHoldActive &&
        voiceInputTranscript.length === 0 &&
        typeof window !== "undefined"
      ) {
        if (voicePendingFinalTranscriptTimerRef.current !== null) {
          window.clearTimeout(voicePendingFinalTranscriptTimerRef.current);
        }
        voicePendingFinalTranscriptTimerRef.current = window.setTimeout(() => {
          voiceDraftBaseRef.current = null;
          voicePendingFinalTranscriptTimerRef.current = null;
        }, 1600);
      }
      return;
    }

    if (voicePendingFinalTranscriptTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(voicePendingFinalTranscriptTimerRef.current);
      voicePendingFinalTranscriptTimerRef.current = null;
    }

    const nextValue = mergeVoiceTranscript(voiceDraftBaseRef.current, voiceInputTranscript);
    if (nextValue === latestInputValueRef.current) {
      return;
    }
    latestInputValueRef.current = nextValue;
    onInputChange(activeConversationId, nextValue, null);
    if (!touchLikeInput) {
      chatInputRef.current?.focusAfterValueSync();
    }
  }, [
    activeConversationId,
    chatInputRef,
    latestInputValueRef,
    onInputChange,
    touchLikeInput,
    voiceHoldActive,
    voiceInputListening,
    voiceInputTranscribing,
    voiceInputTranscript,
  ]);

  const startChatVoiceCaptureTurn = useCallback(
    async ({
      autoStop,
      debugEvent,
      holdLike,
    }: {
      autoStop: boolean;
      debugEvent: string;
      holdLike: boolean;
    }) => {
      if (voiceInputStarting || voiceInputListening || voiceInputTranscribing || voiceHoldRequestedRef.current) {
        appendVoiceDebugEvent(
          "chatComposer",
          `${debugEvent}_ignored`,
          voiceHoldRequestedRef.current
            ? "hold_requested"
            : voiceInputTranscribing
              ? "transcribing"
              : voiceInputListening
                ? "listening"
                : "starting",
        );
        return false;
      }
      if (touchLikeInput && typeof document !== "undefined") {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) {
          activeElement.blur();
        }
      }
      voiceHoldRequestedRef.current = holdLike;
      setVoiceHoldActive(holdLike);
      if (!holdLike) {
        clearContinuousPauseMessage();
      }
      voiceDraftBaseRef.current = latestInputValueRef.current;
      const attemptId = voiceStartAttemptRef.current + 1;
      voiceStartAttemptRef.current = attemptId;
      voiceConversationTurnRef.current = {
        attemptId,
        autoSubmit:
          latestInputValueRef.current.trim().length === 0 &&
          imageAttachmentCount === 0,
        submitted: false,
      };
      appendVoiceDebugEvent(
        "chatComposer",
        debugEvent,
        autoStop ? "hosted_auto_stop" : voiceInputCapture,
      );
      const started = await startVoiceInput({
        hostedAutoStop: autoStop ? true : null,
      });
      if (!started) {
        if (voiceStartAttemptRef.current === attemptId) {
          voiceHoldRequestedRef.current = false;
          setVoiceHoldActive(false);
        }
        voiceConversationTurnRef.current = null;
        voiceDraftBaseRef.current = null;
        appendVoiceDebugEvent(
          "chatComposer",
          `${debugEvent}_failed`,
          autoStop ? "hosted_auto_stop" : voiceInputCapture,
        );
        return false;
      }
      appendVoiceDebugEvent(
        "chatComposer",
        `${debugEvent}_resolved`,
        autoStop ? "hosted_auto_stop" : voiceInputCapture,
      );
      if (!touchLikeInput) {
        chatInputRef.current?.focus();
      }
      if (holdLike && !voiceHoldRequestedRef.current) {
        appendVoiceDebugEvent("chatComposer", "press_end_early", voiceInputCapture);
        void stopVoiceInput();
        setVoiceHoldActive(false);
      }
      return true;
    },
    [
      chatInputRef,
      clearContinuousPauseMessage,
      imageAttachmentCount,
      latestInputValueRef,
      startVoiceInput,
      stopVoiceInput,
      touchLikeInput,
      voiceInputCapture,
      voiceInputListening,
      voiceInputStarting,
      voiceInputTranscribing,
    ],
  );

  const handleStartVoiceInputHold = useCallback(async () => {
    if (chatVoiceInteractionMode === "continuous") {
      return;
    }
    await startChatVoiceCaptureTurn({
      autoStop: false,
      debugEvent: "press_start",
      holdLike: true,
    });
  }, [chatVoiceInteractionMode, startChatVoiceCaptureTurn]);

  const startContinuousChatVoiceTurn = useCallback(async () => {
    clearForegroundResume();
    const started = await startChatVoiceCaptureTurn({
      autoStop: true,
      debugEvent: "continuous_start",
      holdLike: false,
    });
    if (started) {
      markContinuousTurnStarted();
    } else {
      markContinuousTurnStartFailed();
    }
    return started;
  }, [clearForegroundResume, markContinuousTurnStartFailed, markContinuousTurnStarted, startChatVoiceCaptureTurn]);

  const handleStopVoiceInputHold = useCallback(() => {
    voiceHoldRequestedRef.current = false;
    setVoiceHoldActive(false);
    if (voiceInputListening || voiceInputStarting) {
      appendVoiceDebugEvent("chatComposer", "press_end", voiceInputCapture);
      void stopVoiceInput();
      return;
    }
    appendVoiceDebugEvent("chatComposer", "press_end_ignored", "not_recording");
  }, [stopVoiceInput, voiceInputCapture, voiceInputListening, voiceInputStarting]);

  const handleChatVoiceTap = useCallback(() => {
    if (chatVoiceInteractionMode === "continuous") {
      if (voiceInputListening || voiceInputStarting) {
        resetContinuousSession();
        voiceHoldRequestedRef.current = false;
        setVoiceHoldActive(false);
        appendVoiceDebugEvent("chatComposer", "continuous_stop_after_current_turn", voiceInputCapture);
        void stopVoiceInput();
        return;
      }
      if (voiceInputTranscribing) {
        resetContinuousSession();
        appendVoiceDebugEvent("chatComposer", "continuous_stop_while_transcribing", voiceInputCapture);
        return;
      }
      if (continuousConversationActive || continuousAwaitingAssistantReply) {
        resetContinuousSession();
        voiceConversationTurnRef.current = null;
        voiceDraftBaseRef.current = null;
        voiceHoldRequestedRef.current = false;
        setVoiceHoldActive(false);
        cancelVoiceInput();
        appendVoiceDebugEvent("chatComposer", "continuous_stop", voiceInputCapture);
        return;
      }
      void startContinuousChatVoiceTurn();
      return;
    }
    if (voiceInputTranscribing) {
      appendVoiceDebugEvent("chatComposer", "tap_ignored", "transcribing");
      return;
    }
    if (voiceInputListening || voiceInputStarting || voiceHoldActive) {
      handleStopVoiceInputHold();
      return;
    }
    void handleStartVoiceInputHold();
  }, [
    cancelVoiceInput,
    chatVoiceInteractionMode,
    continuousAwaitingAssistantReply,
    continuousConversationActive,
    handleStartVoiceInputHold,
    handleStopVoiceInputHold,
    resetContinuousSession,
    startContinuousChatVoiceTurn,
    voiceInputCapture,
    voiceHoldActive,
    voiceInputListening,
    voiceInputStarting,
    voiceInputTranscribing,
    stopVoiceInput,
  ]);

  useEffect(() => {
    const transcript = voiceInputTranscript.trim();
    const activeTurn = voiceConversationTurnRef.current;
    if (
      !activeTurn?.autoSubmit ||
      activeTurn.submitted ||
      voiceAutoSubmittingRef.current ||
      voiceHoldActive ||
      voiceInputStarting ||
      voiceInputListening ||
      voiceInputTranscribing ||
      transcript.length === 0
    ) {
      return;
    }

    activeTurn.submitted = true;
    voiceAutoSubmittingRef.current = true;
    appendVoiceDebugEvent("chatComposer", "voice_turn_auto_submit_start", transcript);

    let cancelled = false;
    void (async () => {
      let ok = false;
      try {
        ok = await invokeSubmitMessage(
          {
            message: transcript,
            editorState: null,
          },
          { allowWhileBusy: false },
        );
      } finally {
        voiceDraftBaseRef.current = null;
        clearVoiceInputTranscript();
        voiceConversationTurnRef.current = null;
        voiceAutoSubmittingRef.current = false;
      }

      if (cancelled) {
        return;
      }

      if (ok) {
        if (activeConversationId && latestInputValueRef.current.trim() === transcript) {
          latestInputValueRef.current = "";
          onInputChange(activeConversationId, "", null);
        }
        if (chatVoiceInteractionMode === "continuous" && continuousConversationActive) {
          markContinuousAwaitingAssistantReply(latestAssistantMessage?.id ?? null);
        }
        appendVoiceDebugEvent("chatComposer", "voice_turn_auto_submit_success", transcript);
        return;
      }

      if (chatVoiceInteractionMode === "continuous") {
        pauseContinuousSession("Voice turn submission failed. Tap once to resume continuous voice.");
      }
      if (activeConversationId && latestInputValueRef.current.trim().length === 0) {
        latestInputValueRef.current = transcript;
        onInputChange(activeConversationId, transcript, null);
      }
      appendVoiceDebugEvent("chatComposer", "voice_turn_auto_submit_failed", transcript);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeConversationId,
    chatVoiceInteractionMode,
    clearVoiceInputTranscript,
    continuousConversationActive,
    invokeSubmitMessage,
    latestAssistantMessage?.id,
    latestInputValueRef,
    markContinuousAwaitingAssistantReply,
    onInputChange,
    pauseContinuousSession,
    voiceHoldActive,
    voiceInputListening,
    voiceInputStarting,
    voiceInputTranscript,
    voiceInputTranscribing,
  ]);

  useEffect(() => {
    if (
      chatVoiceInteractionMode !== "continuous" ||
      !continuousConversationActive ||
      !continuousAwaitingAssistantReply ||
      sendingAttachment ||
      isAssistantTyping ||
      voiceInputStarting ||
      voiceInputListening ||
      voiceInputTranscribing
    ) {
      return;
    }
    const latestAssistantId = latestAssistantMessage?.id ?? null;
    if (!hasAssistantReplyReady(latestAssistantId)) {
      return;
    }
    let cancelled = false;
    const timerId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      consumeAssistantReplyIfReady(latestAssistantId);
      void startContinuousChatVoiceTurn();
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [
    chatVoiceInteractionMode,
    continuousAwaitingAssistantReply,
    continuousConversationActive,
    hasAssistantReplyReady,
    consumeAssistantReplyIfReady,
    isAssistantTyping,
    latestAssistantMessage?.id,
    sendingAttachment,
    startContinuousChatVoiceTurn,
    voiceInputListening,
    voiceInputStarting,
    voiceInputTranscribing,
  ]);

  useEffect(() => {
    if (
      chatVoiceInteractionMode !== "continuous" ||
      !continuousConversationActive ||
      !continuousAwaitingAssistantReply
    ) {
      return;
    }
    const timerId = window.setTimeout(() => {
      const message = "Assistant reply took too long. Continuous voice paused. Tap once to resume.";
      pauseContinuousSession(message);
      appendVoiceDebugEvent("chatComposer", "continuous_reply_timeout", message);
    }, CHAT_CONTINUOUS_ASSISTANT_REPLY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    chatVoiceInteractionMode,
    continuousAwaitingAssistantReply,
    continuousConversationActive,
    pauseContinuousSession,
  ]);

  useEffect(() => {
    if (
      chatVoiceInteractionMode !== "continuous" ||
      !continuousConversationActive ||
      continuousAwaitingAssistantReply ||
      voiceInputListening ||
      voiceInputStarting ||
      voiceInputTranscribing
    ) {
      return;
    }
    const currentError = voiceInputError?.trim() ?? "";
    if (!currentError) {
      return;
    }
    const message = isBenignNoSpeechVoiceInputError(currentError)
      ? "No speech detected. Continuous voice paused. Tap once to resume."
      : `${currentError} Tap once to resume continuous voice.`;
    pauseContinuousSession(message);
  }, [
    chatVoiceInteractionMode,
    continuousAwaitingAssistantReply,
    continuousConversationActive,
    pauseContinuousSession,
    voiceInputError,
    voiceInputListening,
    voiceInputStarting,
    voiceInputTranscribing,
  ]);

  useEffect(() => {
    if (
      chatVoiceInteractionMode !== "continuous" ||
      !shouldResumeOnForeground() ||
      !chatHostAudioSession?.foreground ||
      chatHostAudioSession.phase === "background" ||
      chatHostAudioSession.interrupted ||
      sendingAttachment ||
      isAssistantTyping ||
      voiceInputStarting ||
      voiceInputListening ||
      voiceInputTranscribing
    ) {
      return;
    }
    let cancelled = false;
    const timerId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      clearForegroundResume();
      const message = "Instafy is active again. Restarting continuous voice…";
      pauseContinuousSession(message);
      showStatus(message, "info", 2500);
      void startContinuousChatVoiceTurn().then((started) => {
        if (cancelled || started) {
          return;
        }
        const failedMessage =
          "Instafy is active again, but continuous voice could not restart. Tap once to try again.";
        pauseContinuousSession(failedMessage);
        showStatus(failedMessage, "warning", 3500);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [
    clearForegroundResume,
    chatHostAudioSession,
    chatVoiceInteractionMode,
    isAssistantTyping,
    pauseContinuousSession,
    sendingAttachment,
    showStatus,
    startContinuousChatVoiceTurn,
    shouldResumeOnForeground,
    voiceInputListening,
    voiceInputStarting,
    voiceInputTranscribing,
  ]);

  const composerHasSendPayload = inputValue.trim().length > 0 || imageAttachmentCount > 0;
  const handleSendButtonPress = useCallback(() => {
    if (
      voiceInputStarting ||
      voiceInputListening ||
      voiceInputTranscribing ||
      voiceHoldActive
    ) {
      return;
    }
    scheduleSubmitMessage();
  }, [scheduleSubmitMessage, voiceHoldActive, voiceInputListening, voiceInputStarting, voiceInputTranscribing]);

  const {
    recordingIndicatorLabel,
    showVoicePrimaryAction,
    showVoiceSecondaryAction,
    showVoiceStatus,
    voiceActionActive,
    voiceStatusMessage,
  } = deriveChatVoiceComposerViewState({
    chatVoiceInteractionMode,
    composerHasSendPayload,
    continuousAwaitingAssistantReply,
    continuousConversationActive,
    continuousPauseMessage,
    continuousVoiceResolving,
    voiceHoldActive,
    voiceInputListening,
    voiceInputStarting,
    voiceInputSupported,
    voiceInputTranscript,
    voiceInputTranscribing,
  });

  useEffect(() => {
    wakeWordAutoStartTriggerRef.current = null;
  }, [primaryWakeWordTriggerIdentity]);

  const handleToggleWakeWordArmed = useCallback(() => {
    const nextValue = !chatWakeWordArmed;
    setChatWakeWordArmed(nextValue);
    showStatus(
      nextValue
        ? "Wake word arming enabled for this space while Instafy stays foregrounded."
        : "Wake word arming disabled for this space.",
      "info",
      3200,
    );
  }, [chatWakeWordArmed, setChatWakeWordArmed, showStatus]);

  const providerTriggerNoticeProps = useMemo<VoiceProviderTriggerNoticeProps>(() => {
    if (!primaryProviderTriggerCandidate) {
      return null;
    }
    return {
      candidate: primaryProviderTriggerCandidate,
      candidateCount: providerTriggerCandidates.length,
      wakeWordMode: chatWakeWordArmed ? "armed" : "manual",
      actionLabel: primaryWakeWordTriggerCandidate
        ? chatWakeWordArmed
          ? "Disarm wake word"
          : "Arm wake word"
        : null,
      onAction: primaryWakeWordTriggerCandidate ? handleToggleWakeWordArmed : null,
      onDismiss: () => dismissProviderTriggerCandidate(primaryProviderTriggerCandidate),
      onClearAll:
        providerTriggerCandidates.length > 1 ? () => clearProviderTriggerQueue() : null,
      className: "mb-2",
      testIdPrefix: "chat-provider-trigger",
    };
  }, [
    chatWakeWordArmed,
    handleToggleWakeWordArmed,
    primaryProviderTriggerCandidate,
    primaryWakeWordTriggerCandidate,
    providerTriggerCandidates.length,
  ]);

  return {
    handleChatVoiceTap,
    handleSendButtonPress,
    handleStartVoiceInputHold,
    handleStopVoiceInputHold,
    providerTriggerNoticeProps,
    recordingIndicatorLabel,
    showVoicePrimaryAction,
    showVoiceSecondaryAction,
    showVoiceStatus,
    voiceActionActive,
    voiceDebugState,
    voiceHoldActive,
    voiceInputListening,
    voiceInputStarting,
    voiceInputTranscribing,
    voiceStatusMessage,
  };
}
