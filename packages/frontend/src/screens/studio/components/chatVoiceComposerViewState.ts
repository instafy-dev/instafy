import type { ChatVoiceInteractionMode } from "../../../voice/chatSpeechReplyPreference";

export type ChatVoiceComposerViewStateInput = {
  chatVoiceInteractionMode: ChatVoiceInteractionMode;
  composerHasSendPayload: boolean;
  continuousAwaitingAssistantReply: boolean;
  continuousConversationActive: boolean;
  continuousPauseMessage: string | null;
  continuousVoiceResolving: boolean;
  voiceHoldActive: boolean;
  voiceInputListening: boolean;
  voiceInputStarting: boolean;
  voiceInputSupported: boolean;
  voiceInputTranscript: string;
  voiceInputTranscribing: boolean;
};

export type ChatVoiceComposerViewState = {
  recordingIndicatorLabel: string;
  showVoicePrimaryAction: boolean;
  showVoiceSecondaryAction: boolean;
  showVoiceStatus: boolean;
  voiceActionActive: boolean;
  voiceStatusMessage: string;
};

export function deriveChatVoiceComposerViewState(
  input: ChatVoiceComposerViewStateInput,
): ChatVoiceComposerViewState {
  const voiceTranscriptPreview = input.voiceInputTranscript.trim();
  const voiceActionActive =
    input.voiceInputStarting ||
    input.voiceInputListening ||
    input.voiceInputTranscribing ||
    input.voiceHoldActive ||
    (input.chatVoiceInteractionMode === "continuous" &&
      (input.continuousConversationActive || input.continuousAwaitingAssistantReply));

  const voiceStatusMessage =
    input.chatVoiceInteractionMode === "continuous" && input.continuousVoiceResolving
      ? "Checking the space speech provider for continuous voice…"
      : input.chatVoiceInteractionMode === "continuous" && input.continuousPauseMessage
        ? input.continuousPauseMessage
        : input.chatVoiceInteractionMode === "continuous" && input.continuousAwaitingAssistantReply
          ? "Continuous voice is waiting for the assistant reply."
          : input.chatVoiceInteractionMode === "continuous" && input.continuousConversationActive
            ? input.voiceInputStarting && !input.voiceInputListening
              ? "Starting continuous voice input."
              : input.voiceInputTranscribing
                ? "Transcribing the latest continuous voice turn…"
                : voiceTranscriptPreview.length > 0
                  ? `Continuous voice heard: ${voiceTranscriptPreview}`
                  : "Continuous voice is listening. Speak naturally and pause to send."
            : input.voiceInputStarting && !input.voiceInputListening
              ? input.chatVoiceInteractionMode === "tap"
                ? "Starting voice input. Tap again to stop."
                : "Starting voice input. Keep holding."
              : input.voiceInputTranscribing
                ? "Transcribing voice input…"
                : voiceTranscriptPreview.length > 0
                  ? `Recording. Heard: ${voiceTranscriptPreview}`
                  : input.chatVoiceInteractionMode === "tap"
                    ? "Listening. Speak now and tap again to stop."
                    : "Listening. Speak now and release to stop.";

  // Hold-to-talk owns its pointer until release. Keep a draft's dedicated mic
  // in the secondary slot for the complete hold lifecycle so React never
  // replaces the pointer-owning button with the active-strip copy mid-gesture.
  const preserveSecondaryHoldAction =
    input.voiceInputSupported &&
    input.composerHasSendPayload &&
    input.chatVoiceInteractionMode === "hold";
  const showVoicePrimaryAction =
    input.voiceInputSupported &&
    !preserveSecondaryHoldAction &&
    (!input.composerHasSendPayload ||
      input.voiceInputStarting ||
      input.voiceInputTranscribing ||
      input.voiceHoldActive ||
      (input.chatVoiceInteractionMode === "continuous" &&
        (input.continuousConversationActive || input.continuousAwaitingAssistantReply)));
  const showVoiceSecondaryAction =
    input.voiceInputSupported && input.composerHasSendPayload && !showVoicePrimaryAction;

  const showVoiceStatus =
    input.voiceHoldActive ||
    input.voiceInputStarting ||
    input.voiceInputListening ||
    input.voiceInputTranscribing ||
    (input.chatVoiceInteractionMode === "continuous" &&
      (input.continuousConversationActive ||
        input.continuousAwaitingAssistantReply ||
        Boolean(input.continuousPauseMessage)));

  const recordingIndicatorLabel =
    input.voiceInputStarting && !input.voiceInputListening
      ? "Starting voice input"
      : input.voiceInputTranscribing
        ? "Transcribing voice input"
        : "Voice input recording";

  return {
    recordingIndicatorLabel,
    showVoicePrimaryAction,
    showVoiceSecondaryAction,
    showVoiceStatus,
    voiceActionActive,
    voiceStatusMessage,
  };
}
