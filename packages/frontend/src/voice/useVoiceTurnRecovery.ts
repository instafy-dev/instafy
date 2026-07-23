import { useEffect, useRef } from "react";
import type { HostAudioSessionState } from "../audio/hostAudioSessionState";
import type { VoiceTurnState } from "./useVoiceTurnController";
import { appendVoiceDebugEvent, type VoiceDebugScope } from "./voiceDebugState";

export type VoiceTurnRecoveryNoticeKind =
  | "interrupt_start"
  | "interrupt_end"
  | "route_change"
  | "background_pause";

export type VoiceTurnRecoveryNotice = {
  kind: VoiceTurnRecoveryNoticeKind;
  message: string;
  tone: "info" | "warning";
  cancelActiveTurn: boolean;
};

type VoiceTurnRecoveryInteractionMode = "hold" | "tap" | "continuous";

function describeResumeInstruction(interactionMode: VoiceTurnRecoveryInteractionMode) {
  switch (interactionMode) {
    case "tap":
      return "Tap to talk again";
    case "continuous":
      return "Tap once to resume continuous voice";
    case "hold":
    default:
      return "Hold to talk again";
  }
}

function didRouteSignalChange(
  previousSession: HostAudioSessionState | null,
  currentSession: HostAudioSessionState,
) {
  if (!previousSession) {
    return false;
  }
  return (
    previousSession.routeKind !== currentSession.routeKind ||
    previousSession.preferredOutputLabel !== currentSession.preferredOutputLabel ||
    previousSession.routeChangeReason !== currentSession.routeChangeReason
  );
}

export function deriveVoiceTurnRecoveryNotice(options: {
  previousSession: HostAudioSessionState | null;
  currentSession: HostAudioSessionState | null;
  voiceState: VoiceTurnState;
  interactionMode?: VoiceTurnRecoveryInteractionMode;
  continuousSessionActive?: boolean;
}): VoiceTurnRecoveryNotice | null {
  const currentSession = options.currentSession;
  if (!currentSession) {
    return null;
  }

  const voiceActive = options.voiceState !== "idle";
  const recoveryActive = voiceActive || options.continuousSessionActive === true;
  const interactionMode = options.interactionMode ?? "hold";
  const resumeInstruction = describeResumeInstruction(interactionMode);

  if (currentSession.interrupted && !options.previousSession?.interrupted) {
    const baseMessage = currentSession.interruptionReason
      ? `Voice input was interrupted: ${currentSession.interruptionReason}.`
      : "Voice input was interrupted.";
    return {
      kind: "interrupt_start",
      message: `${baseMessage} ${resumeInstruction} when audio is ready.`,
      tone: "warning",
      cancelActiveTurn: voiceActive,
    };
  }

  if (!currentSession.interrupted && options.previousSession?.interrupted) {
    return {
      kind: "interrupt_end",
      message: `Audio interruption ended. ${resumeInstruction}.`,
      tone: "info",
      cancelActiveTurn: false,
    };
  }

  if (
    (currentSession.phase === "background" || !currentSession.foreground) &&
    options.previousSession &&
    options.previousSession.foreground &&
    options.previousSession.phase !== "background" &&
    recoveryActive
  ) {
    return {
      kind: "background_pause",
      message:
        interactionMode === "continuous"
          ? "Instafy moved to the background. Continuous voice paused and will resume when the app is active again."
          : `Instafy moved to the background. Bring it back to the foreground, then ${resumeInstruction.toLowerCase()}.`,
      tone: "warning",
      cancelActiveTurn: voiceActive,
    };
  }

  if (
    !didRouteSignalChange(options.previousSession, currentSession) ||
    !recoveryActive
  ) {
    return null;
  }

  if (currentSession.routeKind === "receiver") {
    return {
      kind: "route_change",
      message:
        `Audio route changed to the phone earpiece. Switch back to speaker or Bluetooth for spoken replies, then ${resumeInstruction.toLowerCase()}.`,
      tone: "warning",
      cancelActiveTurn: voiceActive,
    };
  }

  if (currentSession.routeKind === "bluetooth") {
    return {
      kind: "route_change",
      message: currentSession.preferredOutputLabel
        ? `Audio route changed to ${currentSession.preferredOutputLabel}.`
        : "Audio route changed to a Bluetooth headset.",
      tone: "info",
      cancelActiveTurn: false,
    };
  }

  if (currentSession.routeKind === "speaker") {
    return {
      kind: "route_change",
      message: currentSession.preferredOutputLabel
        ? `Audio route changed to ${currentSession.preferredOutputLabel}.`
        : "Audio route changed to the phone speaker.",
      tone: "info",
      cancelActiveTurn: false,
    };
  }

  return null;
}

export function useVoiceTurnRecovery(options: {
  scope: VoiceDebugScope;
  sessionState: HostAudioSessionState | null;
  voiceState: VoiceTurnState;
  interactionMode?: VoiceTurnRecoveryInteractionMode;
  continuousSessionActive?: boolean;
  cancelVoiceTurn: () => void;
  onNotice?: (notice: VoiceTurnRecoveryNotice) => void;
}) {
  const {
    cancelVoiceTurn,
    continuousSessionActive,
    interactionMode,
    onNotice,
    scope,
    sessionState,
    voiceState,
  } = options;
  const previousSessionRef = useRef<HostAudioSessionState | null>(null);

  useEffect(() => {
    const notice = deriveVoiceTurnRecoveryNotice({
      previousSession: previousSessionRef.current,
      currentSession: sessionState,
      voiceState,
      interactionMode,
      continuousSessionActive,
    });
    previousSessionRef.current = sessionState;
    if (!notice) {
      return;
    }
    if (notice.cancelActiveTurn) {
      cancelVoiceTurn();
    }
    appendVoiceDebugEvent(scope, `audio_${notice.kind}`, notice.message);
    onNotice?.(notice);
  }, [cancelVoiceTurn, continuousSessionActive, interactionMode, onNotice, scope, sessionState, voiceState]);
}
