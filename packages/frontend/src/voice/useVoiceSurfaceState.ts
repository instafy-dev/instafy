import { useMemo } from "react";
import {
  describeHostAudioDiagnostics,
  type HostAudioDiagnostics,
} from "../audio/audioSessionDiagnostics";
import {
  describeHostAudioSessionState,
  deriveHostHandsFreeVoiceAvailability,
  type HostHandsFreeVoiceAvailability,
  type HostAudioSessionState,
} from "../audio/hostAudioSessionState";
import { useHostAudioSessionState } from "../audio/useHostAudioSessionState";
import {
  describeSpeechServiceConnection,
  describeSpeechTranscriptionBackendRoute,
  type SpeechDependencyStatus,
  type SpeechServiceConnectionSummary,
  type SpeechTranscriptionBackendDescriptor,
} from "./speechService";
import {
  useVoiceDebugState,
  type VoiceDebugCapture,
  type VoiceDebugState,
} from "./voiceDebugState";
import type {
  VoiceTurnEffectiveMode,
  VoiceTurnMode,
  VoiceTurnState,
} from "./useVoiceTurnController";

type ReplyPlaybackBackend = "provider" | "http" | "browser" | "none" | null;

export type VoiceSurfaceState = {
  speechServiceReachable: boolean;
  speechProviderSummary: SpeechServiceConnectionSummary;
  speechRouteSummary: SpeechServiceConnectionSummary;
  hostAudioSession: HostAudioSessionState | null;
  hostAudioSummary: string;
  handsFreeAvailability: HostHandsFreeVoiceAvailability;
  replyPlaybackSummaryLabel: string;
  voiceDebugState: VoiceDebugState;
};

type UseVoiceSurfaceStateOptions = {
  route: VoiceTurnEffectiveMode;
  capture: VoiceDebugCapture;
  state: VoiceTurnState;
  supported: boolean;
  transcriptionBackend: SpeechTranscriptionBackendDescriptor;
  speechMode: VoiceTurnMode;
  interactionMode: string;
  speechDependencyStatus: SpeechDependencyStatus | null;
  hostAudioDiagnostics: HostAudioDiagnostics | null;
  currentError: string | null;
  voiceRepliesEnabled: boolean;
  latestReplyContent?: string | null;
  replyPlaybackLastBackend: ReplyPlaybackBackend;
  replyPlaybackLastBackendLabel: string | null;
};

export function buildVoiceReplyPlaybackSummaryLabel(options: {
  enabled: boolean;
  lastBackend: ReplyPlaybackBackend;
  lastBackendLabel: string | null;
  latestReplyContent?: string | null;
}) {
  if (!options.enabled) {
    return "Off";
  }
  if (options.lastBackendLabel) {
    return options.lastBackendLabel;
  }
  if (options.lastBackend === "browser") {
    return "This device";
  }
  if (options.lastBackend === "none") {
    return "Unavailable";
  }
  if (options.latestReplyContent?.trim()) {
    return "Waiting for playback";
  }
  return "Waiting for first reply";
}

export function useVoiceSurfaceState(
  options: UseVoiceSurfaceStateOptions,
): VoiceSurfaceState {
  const speechServiceReachable =
    options.transcriptionBackend.kind === "http" ||
    options.speechDependencyStatus?.localService?.health?.reachable === true;

  const speechProviderSummary = useMemo(
    () => describeSpeechServiceConnection(options.speechDependencyStatus),
    [options.speechDependencyStatus],
  );
  const speechRouteSummary = useMemo(
    () =>
      describeSpeechTranscriptionBackendRoute({
        backend: options.transcriptionBackend,
        dependencyStatus: options.speechDependencyStatus,
      }),
    [options.speechDependencyStatus, options.transcriptionBackend],
  );

  const { value: hostAudioSession } = useHostAudioSessionState({
    enabled: true,
    diagnostics: options.hostAudioDiagnostics,
    voiceState: options.state,
  });

  const hostAudioSummary = useMemo(
    () =>
      `${describeHostAudioSessionState(hostAudioSession)} · ${describeHostAudioDiagnostics(
        options.hostAudioDiagnostics,
      )}`,
    [hostAudioSession, options.hostAudioDiagnostics],
  );

  const handsFreeAvailability = useMemo(
    () =>
      deriveHostHandsFreeVoiceAvailability({
        diagnostics: options.hostAudioDiagnostics,
        sessionState: hostAudioSession,
      }),
    [hostAudioSession, options.hostAudioDiagnostics],
  );

  const replyPlaybackSummaryLabel = useMemo(
    () =>
      buildVoiceReplyPlaybackSummaryLabel({
        enabled: options.voiceRepliesEnabled,
        lastBackend: options.replyPlaybackLastBackend,
        lastBackendLabel: options.replyPlaybackLastBackendLabel,
        latestReplyContent: options.latestReplyContent,
      }),
    [
      options.latestReplyContent,
      options.replyPlaybackLastBackend,
      options.replyPlaybackLastBackendLabel,
      options.voiceRepliesEnabled,
    ],
  );

  const voiceDebugState = useVoiceDebugState({
    route: options.route,
    capture: options.capture,
    state: options.state,
    supported: options.supported,
    transcriptionBackendLabel: options.transcriptionBackend.label,
    mode: options.speechMode,
    interactionMode: options.interactionMode,
    providerReachable: speechServiceReachable,
    lastError: options.currentError,
  });

  return {
    speechServiceReachable,
    speechProviderSummary,
    speechRouteSummary,
    hostAudioSession,
    hostAudioSummary,
    handsFreeAvailability,
    replyPlaybackSummaryLabel,
    voiceDebugState,
  };
}
