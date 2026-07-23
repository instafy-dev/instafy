import type { HostAudioDiagnostics, HostAudioPermissionState } from "./audioSessionDiagnostics";
import type { VoiceTurnState } from "../voice/useVoiceTurnController";

export type HostAudioSessionPhase =
  | "idle"
  | "activating"
  | "recording"
  | "transcribing"
  | "interrupted"
  | "background";

export type HostAudioRouteKind = "bluetooth" | "speaker" | "receiver" | "wired_or_builtin" | "unknown";

export type HostAudioSessionState = {
  phase: HostAudioSessionPhase;
  foreground: boolean;
  focused: boolean;
  audioSessionActive: boolean;
  voiceCaptureActive: boolean;
  interrupted: boolean;
  interruptionReason: string | null;
  routeChangeReason: string | null;
  routeKind: HostAudioRouteKind;
  preferredOutputLabel: string | null;
  microphonePermission: HostAudioPermissionState;
  captureReady: boolean;
  playbackReady: boolean;
  recommendedPlaybackRoute: "bluetooth" | "speaker" | "default";
  routeHint: string;
  warnings: string[];
};

export type HostHandsFreeVoiceAvailability = {
  state: "checking" | "foreground_only" | "background_paused" | "unavailable";
  label: string;
  detail: string;
};

export function deriveHostAudioSessionState(options: {
  diagnostics: HostAudioDiagnostics | null;
  voiceState?: VoiceTurnState;
  foreground?: boolean;
  focused?: boolean;
}): HostAudioSessionState {
  const diagnostics = options.diagnostics;
  const nativeSession = diagnostics?.nativeSession ?? null;
  const foreground = nativeSession
    ? nativeSession.appState !== "background"
    : (options.foreground ?? true);
  const focused = nativeSession
    ? nativeSession.appState === "active"
    : (options.focused ?? true);
  const voiceState = options.voiceState ?? "idle";

  const preferredOutputLabel = nativeSession?.preferredOutputLabel ?? diagnostics?.devices.preferredOutputLabel ?? null;
  const routeKind: HostAudioRouteKind = nativeSession?.routeKind ??
    (preferredOutputLabel
      ? diagnostics?.devices.bluetoothLikeOutputLabels.includes(preferredOutputLabel)
        ? "bluetooth"
        : "wired_or_builtin"
      : "unknown");

  let phase: HostAudioSessionPhase = "idle";
  if (!foreground) {
    phase = "background";
  } else if (nativeSession?.interrupted) {
    phase = "interrupted";
  } else if (voiceState === "transcribing") {
    phase = "transcribing";
  } else if (voiceState === "listening") {
    phase = "recording";
  } else if (voiceState === "starting") {
    phase = "activating";
  }

  const captureReady =
    diagnostics?.capture.microphonePermission === "granted" &&
    Boolean(diagnostics.capture.getUserMedia);
  const playbackReady =
    Boolean(diagnostics?.playback.htmlAudio) || Boolean(diagnostics?.playback.speechSynthesis);

  const warnings: string[] = [];
  if (diagnostics?.capture.microphonePermission === "denied") {
    warnings.push("Microphone permission is denied.");
  }
  if (diagnostics && !diagnostics.capture.getUserMedia) {
    warnings.push("This client cannot capture microphone audio.");
  }
  if (diagnostics && !playbackReady) {
    warnings.push("This client cannot play reply audio.");
  }
  if (diagnostics?.nativePlatform && routeKind !== "bluetooth" && diagnostics.devices.outputCount > 0) {
    warnings.push("No Bluetooth-style headset route is visible right now.");
  }
  if (nativeSession?.interrupted) {
    warnings.push(
      nativeSession.interruptionReason
        ? `Native audio session was interrupted: ${nativeSession.interruptionReason}.`
        : "Native audio session is currently interrupted.",
    );
  }
  if (routeKind === "receiver") {
    warnings.push("Phone earpiece route is active. Switch to speaker or Bluetooth for spoken replies.");
  }
  if (!foreground && voiceState !== "idle") {
    warnings.push("Voice capture may pause when the app leaves the foreground.");
  }

  const routeHint =
    routeKind === "bluetooth"
      ? `Likely headset route: ${preferredOutputLabel}`
      : routeKind === "speaker"
        ? preferredOutputLabel
          ? `Phone speaker route: ${preferredOutputLabel}`
          : "Phone speaker route is active."
        : routeKind === "receiver"
          ? preferredOutputLabel
            ? `Phone earpiece route: ${preferredOutputLabel}`
            : "Phone earpiece route is active."
      : preferredOutputLabel
        ? `Current route: ${preferredOutputLabel}`
        : diagnostics?.devices.outputCount
          ? `${diagnostics.devices.outputCount} audio output${diagnostics.devices.outputCount === 1 ? "" : "s"} visible`
          : "No labeled audio output route is visible yet.";

  return {
    phase,
    foreground,
    focused,
    audioSessionActive: nativeSession?.audioSessionActive ?? voiceState !== "idle",
    voiceCaptureActive: nativeSession?.voiceCaptureActive ?? (voiceState === "starting" || voiceState === "listening"),
    interrupted: nativeSession?.interrupted ?? false,
    interruptionReason: nativeSession?.interruptionReason ?? null,
    routeChangeReason: nativeSession?.routeChangeReason ?? null,
    routeKind,
    preferredOutputLabel,
    microphonePermission: diagnostics?.capture.microphonePermission ?? "unknown",
    captureReady,
    playbackReady,
    recommendedPlaybackRoute: routeKind === "bluetooth" ? "bluetooth" : diagnostics?.nativePlatform ? "speaker" : "default",
    routeHint,
    warnings,
  };
}

export function describeHostAudioSessionState(value: HostAudioSessionState | null) {
  if (!value) {
    return "Audio session unavailable.";
  }
  const phaseLabel =
    value.phase === "interrupted"
      ? "Voice session interrupted"
      : value.phase === "activating"
      ? "Voice session activating"
      : value.phase === "recording"
        ? "Voice session recording"
        : value.phase === "transcribing"
          ? "Voice session transcribing"
          : value.phase === "background"
            ? "App in background"
            : "Voice session idle";
  return `${phaseLabel} · ${value.routeHint}`;
}

export function deriveHostHandsFreeVoiceAvailability(options: {
  diagnostics: HostAudioDiagnostics | null;
  sessionState: HostAudioSessionState | null;
}): HostHandsFreeVoiceAvailability {
  if (!options.diagnostics || !options.sessionState) {
    return {
      state: "checking",
      label: "Checking…",
      detail: "Instafy is still checking whether this device can keep voice capture and playback ready.",
    };
  }

  if (options.sessionState.phase === "background" || !options.sessionState.foreground) {
    return {
      state: "background_paused",
      label: "Paused in background",
      detail:
        "Current voice loops pause when Instafy leaves the foreground. Bring the app back and keep it awake to resume.",
    };
  }

  if (!options.sessionState.captureReady) {
    const permission = options.sessionState.microphonePermission;
    return {
      state: "unavailable",
      label:
        permission === "denied"
          ? "Needs microphone access"
          : permission === "unsupported"
            ? "Capture unavailable"
            : "Capture not ready",
      detail:
        permission === "denied"
          ? "Grant microphone access before trying tap, continuous, or future hands-free voice modes."
          : permission === "unsupported"
            ? "This device cannot capture microphone audio, so hands-free voice is unavailable here."
            : "Voice capture is not ready yet on this device.",
    };
  }

  return {
    state: "foreground_only",
    label: "Foreground only",
    detail:
      "Hold, tap, and continuous voice work while Instafy stays open and awake. Background or wake-word capture is not implemented yet.",
  };
}
