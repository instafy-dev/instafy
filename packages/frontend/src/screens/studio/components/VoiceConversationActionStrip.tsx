import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Microphone, SoundHigh, SoundOff } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";

export type VoiceConversationActionStripProps = {
  showVoiceRepliesToggle: boolean;
  voiceRepliesEnabled?: boolean;
  replySpeaking?: boolean;
  replyBackendLabel?: string | null;
  replyError?: string | null;
  onToggleVoiceReplies?: () => void;
  voiceActionActive: boolean;
  voiceListening: boolean;
  voiceStarting: boolean;
  voiceTranscribing: boolean;
  voiceState: string;
  voiceRoute: string;
  voiceCapture: string;
  voiceBackendLabel?: string | null;
  voiceError?: string | null;
  voiceInteractionMode?: "hold" | "tap" | "continuous";
  disabled?: boolean;
  onVoicePressStart: () => void | Promise<void>;
  onVoicePressEnd: () => void;
  onVoiceTap?: () => void | Promise<void>;
  onPointerCaptureStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCaptureEnd?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  primaryActionClassName: string;
  outlinedActionClassName: string;
  actionIconClassName: string;
  voiceRepliesTestId?: string;
  voiceInputTestId?: string;
};

export function VoiceConversationActionStrip({
  showVoiceRepliesToggle,
  voiceRepliesEnabled = false,
  replySpeaking = false,
  replyBackendLabel,
  replyError,
  onToggleVoiceReplies,
  voiceActionActive,
  voiceListening,
  voiceStarting,
  voiceTranscribing,
  voiceState,
  voiceRoute,
  voiceCapture,
  voiceBackendLabel,
  voiceError,
  voiceInteractionMode = "hold",
  disabled = false,
  onVoicePressStart,
  onVoicePressEnd,
  onVoiceTap,
  onPointerCaptureStart,
  onPointerCaptureEnd,
  primaryActionClassName,
  outlinedActionClassName,
  actionIconClassName,
  voiceRepliesTestId = "chat-voice-replies-toggle",
  voiceInputTestId = "chat-voice-input-button",
}: VoiceConversationActionStripProps) {
  const tapLikeMode = voiceInteractionMode !== "hold";

  const handlePointerStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (tapLikeMode) {
      return;
    }
    onPointerCaptureStart?.(event);
    void onVoicePressStart();
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (tapLikeMode) {
      return;
    }
    onPointerCaptureEnd?.(event);
    onVoicePressEnd();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (tapLikeMode) {
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      void onVoicePressStart();
    }
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (tapLikeMode) {
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      onVoicePressEnd();
    }
  };

  const handleTapToggle = () => {
    if (!tapLikeMode) {
      return;
    }
    void onVoiceTap?.();
  };

  const voiceButtonLabel =
    voiceListening || voiceStarting
      ? voiceInteractionMode === "continuous"
        ? "Tap to stop continuous voice conversation"
        : voiceInteractionMode === "tap"
        ? "Tap to stop voice input"
        : "Release to stop voice input"
      : voiceTranscribing
        ? "Transcribing voice input"
        : voiceInteractionMode === "continuous" && voiceActionActive
          ? "Tap to stop continuous voice conversation"
        : voiceInteractionMode === "continuous"
          ? "Tap to start continuous voice conversation"
        : voiceInteractionMode === "tap"
          ? "Tap to talk"
          : "Hold to talk";

  return (
    <>
      {showVoiceRepliesToggle ? (
        <IconButton
          type="button"
          onPress={onToggleVoiceReplies}
          variant={voiceRepliesEnabled ? "primary" : "outline"}
          size="md"
          radius="xl"
          aria-label={
            voiceRepliesEnabled
              ? "Turn off spoken assistant replies"
              : "Turn on spoken assistant replies"
          }
          title={
            replySpeaking
              ? "Speaking the latest assistant reply"
              : voiceRepliesEnabled
                ? "Turn off spoken assistant replies"
                : "Turn on spoken assistant replies"
          }
          isDisabled={disabled}
          data-testid={voiceRepliesTestId}
          data-voice-replies-enabled={voiceRepliesEnabled ? "true" : "false"}
          data-voice-replies-speaking={replySpeaking ? "true" : "false"}
          data-voice-replies-backend={replyBackendLabel ?? ""}
          data-voice-replies-error={replyError ?? ""}
          className={voiceRepliesEnabled ? primaryActionClassName : outlinedActionClassName}
        >
          <span className="sr-only">
            {voiceRepliesEnabled
              ? "Turn off spoken assistant replies"
              : "Turn on spoken assistant replies"}
          </span>
          {replySpeaking ? (
            <Spinner aria-hidden="true" tone="primary" size="xs" className="h-[22px] w-[22px]" />
          ) : voiceRepliesEnabled ? (
            <SoundHigh className={actionIconClassName} aria-hidden="true" />
          ) : (
            <SoundOff className={actionIconClassName} aria-hidden="true" />
          )}
        </IconButton>
      ) : null}
      <IconButton
        type="button"
        onPointerDown={handlePointerStart}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerLeave={handlePointerEnd}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onClick={handleTapToggle}
        aria-pressed={voiceActionActive}
        variant={voiceActionActive ? "primary" : "outline"}
        size="md"
        radius="xl"
        aria-label={voiceButtonLabel}
        title={voiceButtonLabel}
        isDisabled={disabled}
        data-testid={voiceInputTestId}
        data-voice-route={voiceRoute}
        data-voice-capture={voiceCapture}
        data-voice-state={voiceState}
        data-voice-backend={voiceBackendLabel ?? ""}
        data-voice-error={voiceError ?? ""}
        className={voiceActionActive ? primaryActionClassName : outlinedActionClassName}
      >
        {voiceActionActive ? (
          <Microphone className={`${actionIconClassName} animate-pulse`} aria-hidden="true" />
        ) : (
          <Microphone className={actionIconClassName} aria-hidden="true" />
        )}
      </IconButton>
    </>
  );
}
