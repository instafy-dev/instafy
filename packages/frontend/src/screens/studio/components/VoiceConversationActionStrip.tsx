import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
  primaryActionClassName,
  outlinedActionClassName,
  actionIconClassName,
  voiceRepliesTestId = "chat-voice-replies-toggle",
  voiceInputTestId = "chat-voice-input-button",
}: VoiceConversationActionStripProps) {
  const tapLikeMode = voiceInteractionMode !== "hold";
  const activePointerIdRef = useRef<number | null>(null);
  const activeKeyboardKeyRef = useRef<" " | "Enter" | null>(null);
  const removePointerListenersRef = useRef<(() => void) | null>(null);
  const onVoicePressEndRef = useRef(onVoicePressEnd);
  onVoicePressEndRef.current = onVoicePressEnd;

  const finishOwnedPointerHold = (pointerId: number | null) => {
    if (
      activePointerIdRef.current === null ||
      (pointerId !== null && activePointerIdRef.current !== pointerId)
    ) {
      return;
    }
    activePointerIdRef.current = null;
    removePointerListenersRef.current?.();
    removePointerListenersRef.current = null;
    onVoicePressEndRef.current();
  };

  useEffect(
    () => () => {
      const ownedHold =
        activePointerIdRef.current !== null || activeKeyboardKeyRef.current !== null;
      activePointerIdRef.current = null;
      activeKeyboardKeyRef.current = null;
      removePointerListenersRef.current?.();
      removePointerListenersRef.current = null;
      if (ownedHold) {
        onVoicePressEndRef.current();
      }
    },
    [],
  );

  const handlePointerStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (
      tapLikeMode ||
      event.button !== 0 ||
      event.isPrimary === false ||
      activePointerIdRef.current !== null ||
      activeKeyboardKeyRef.current !== null
    ) {
      return;
    }
    activePointerIdRef.current = event.pointerId;
    const ownerWindow = event.currentTarget.ownerDocument.defaultView ?? window;
    const handlePointerEnd = (nativeEvent: PointerEvent) => {
      finishOwnedPointerHold(nativeEvent.pointerId);
    };
    const handleWindowBlur = () => finishOwnedPointerHold(null);
    ownerWindow.addEventListener("pointerup", handlePointerEnd, true);
    ownerWindow.addEventListener("pointercancel", handlePointerEnd, true);
    ownerWindow.addEventListener("blur", handleWindowBlur);
    removePointerListenersRef.current = () => {
      ownerWindow.removeEventListener("pointerup", handlePointerEnd, true);
      ownerWindow.removeEventListener("pointercancel", handlePointerEnd, true);
      ownerWindow.removeEventListener("blur", handleWindowBlur);
    };
    void onVoicePressStart();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (tapLikeMode) {
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (
        event.repeat ||
        activeKeyboardKeyRef.current !== null ||
        activePointerIdRef.current !== null
      ) {
        return;
      }
      activeKeyboardKeyRef.current = event.key;
      void onVoicePressStart();
    }
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (tapLikeMode) {
      return;
    }
    if (event.key === activeKeyboardKeyRef.current) {
      event.preventDefault();
      activeKeyboardKeyRef.current = null;
      onVoicePressEnd();
    }
  };

  const handleBlur = () => {
    const ownedHold = activeKeyboardKeyRef.current !== null;
    activeKeyboardKeyRef.current = null;
    if (ownedHold) {
      onVoicePressEnd();
    }
  };

  const handleVirtualPress = (event: { pointerType: string }) => {
    if (
      tapLikeMode ||
      event.pointerType !== "virtual" ||
      activePointerIdRef.current !== null ||
      activeKeyboardKeyRef.current !== null
    ) {
      return;
    }
    void onVoiceTap?.();
  };

  const handleTapToggle = () => {
    if (!tapLikeMode) {
      return;
    }
    void onVoiceTap?.();
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (activePointerIdRef.current !== null) {
      event.preventDefault();
    }
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
  const voiceButtonAccessibleLabel =
    voiceInteractionMode !== "hold"
      ? voiceButtonLabel
      : voiceTranscribing
        ? voiceButtonLabel
        : voiceListening || voiceStarting || voiceActionActive
          ? "Stop voice input; release or activate to stop"
          : "Start voice input; hold to talk or activate to toggle";

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
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={handleBlur}
        onPress={handleVirtualPress}
        onClick={handleTapToggle}
        onContextMenu={handleContextMenu}
        style={{ touchAction: "none" }}
        aria-pressed={voiceActionActive}
        variant={voiceActionActive ? "primary" : "outline"}
        size="md"
        radius="xl"
        aria-label={voiceButtonAccessibleLabel}
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
