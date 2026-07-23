import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ensureNativeHostMicrophonePermission,
  setNativeHostVoiceCaptureActive,
} from "../audio/nativeAudioSessionBridge";
import { isBenignNoSpeechVoiceInputError, useVoiceInput } from "./useVoiceInput";
import { useRuntimeTranscriptionRecorder } from "./useRuntimeTranscriptionRecorder";
import type { SpeechTranscriptionBackendDescriptor } from "./speechService";
import type { HostedVoiceAutoStopConfigInput } from "./hostedVoiceAutoStop";

export type VoiceTurnMode = "auto" | "provider" | "device";
export type VoiceTurnEffectiveMode = "provider" | "device";
export type VoiceTurnState = "idle" | "starting" | "listening" | "transcribing";

export function selectVoiceTurnCaptureRoute(options: {
  mode: VoiceTurnMode;
  hostedVoiceSupported: boolean;
  localVoiceSupported: boolean;
  preferHostedCapture: boolean;
  hostedTurnLocked?: boolean;
}) {
  if (options.hostedTurnLocked) {
    return {
      useHostedVoiceCapture: true,
      voiceSupported: true,
      effectiveMode: "provider" as const,
    };
  }

  if (options.mode === "provider") {
    return {
      useHostedVoiceCapture: true,
      voiceSupported: options.hostedVoiceSupported,
      effectiveMode: "provider" as const,
    };
  }

  if (options.mode === "device") {
    return {
      useHostedVoiceCapture: false,
      voiceSupported: options.localVoiceSupported,
      effectiveMode: "device" as const,
    };
  }

  const useHostedVoiceCapture =
    options.hostedVoiceSupported && (options.preferHostedCapture || !options.localVoiceSupported);
  return {
    useHostedVoiceCapture,
    voiceSupported: useHostedVoiceCapture ? options.hostedVoiceSupported : options.localVoiceSupported,
    effectiveMode: useHostedVoiceCapture ? ("provider" as const) : ("device" as const),
  };
}

export function selectVoiceTurnState(options: {
  starting: boolean;
  listening: boolean;
  transcribing: boolean;
}): VoiceTurnState {
  if (options.transcribing) {
    return "transcribing";
  }
  if (options.listening) {
    return "listening";
  }
  if (options.starting) {
    return "starting";
  }
  return "idle";
}

export function shouldBypassVoiceTurnMicrophonePermission(options: {
  useHostedVoiceCapture: boolean;
  hostedTestCaptureConfigured: boolean;
}) {
  return options.useHostedVoiceCapture && options.hostedTestCaptureConfigured;
}

export type VoiceTurnController = {
  supported: boolean;
  hostedCaptureSupported: boolean;
  effectiveMode: VoiceTurnEffectiveMode;
  useHostedVoiceCapture: boolean;
  capture: "hosted" | "device";
  backendKind: SpeechTranscriptionBackendDescriptor["kind"];
  backendLabel: string | null;
  backendConfigPresent: boolean;
  mediaRecorderSupported: boolean;
  backendResolutionStatus: "pending" | "ready" | "error";
  backendResolutionError: string | null;
  state: VoiceTurnState;
  starting: boolean;
  listening: boolean;
  transcribing: boolean;
  error: string | null;
  liveTranscript: string;
  completedTranscript: string;
  hostedTestCaptureConfigured: boolean;
  start: (options?: {
    hostedAutoStop?: HostedVoiceAutoStopConfigInput | null;
  }) => Promise<boolean>;
  stop: () => Promise<string>;
  cancel: () => void;
  clearTranscript: () => void;
  isBenignNoSpeechError: (message: string) => boolean;
};

export function useVoiceTurnController(options: {
  mode: VoiceTurnMode;
  preferHostedCapture: boolean;
  hostedBackendResolutionEnabled?: boolean;
  onError?: (message: string) => void;
  projectId?: string | null;
  accessToken?: string | null;
  routeResolutionKey?: string | null;
}): VoiceTurnController {
  const {
    accessToken = null,
    hostedBackendResolutionEnabled,
    mode,
    onError,
    preferHostedCapture,
    projectId = null,
    routeResolutionKey = null,
  } = options;
  const {
    supported: localVoiceSupported,
    starting: localVoiceStarting,
    listening: localVoiceListening,
    transcript: localVoiceTranscript,
    error: localVoiceError,
    start: startVoiceInput,
    stop: stopVoiceInput,
    cancel: cancelVoiceInput,
    clearTranscript: clearLocalVoiceTranscript,
  } = useVoiceInput({
    onError,
  });
  const resolveHostedBackend = (hostedBackendResolutionEnabled ?? true) || !localVoiceSupported;
  const {
    backend: transcriptionBackend,
    supported: hostedVoiceSupported,
    backendConfigPresent: hostedBackendConfigPresent,
    mediaRecorderSupported: hostedMediaRecorderSupported,
    backendResolutionStatus: hostedBackendResolutionStatus,
    backendResolutionError: hostedBackendResolutionError,
    starting: hostedVoiceStarting,
    recording: hostedVoiceRecording,
    transcribing: hostedVoiceTranscribing,
    error: hostedVoiceError,
    completedTranscript: hostedCompletedTranscript,
    hostedTestCaptureConfigured,
    start: startHostedVoiceCapture,
    stopAndTranscribe: stopHostedVoiceCapture,
    cancel: cancelHostedVoiceCapture,
    clearCompletedTranscript: clearHostedVoiceTranscript,
  } = useRuntimeTranscriptionRecorder({
    onError,
    projectId,
    accessToken,
    resolveBackend: resolveHostedBackend,
    resolutionKey: routeResolutionKey,
  });
  const [hostedTurnLocked, setHostedTurnLocked] = useState(false);

  const route = useMemo(
    () =>
      selectVoiceTurnCaptureRoute({
        mode,
        hostedVoiceSupported,
        localVoiceSupported,
        preferHostedCapture,
        hostedTurnLocked,
      }),
    [hostedTurnLocked, hostedVoiceSupported, localVoiceSupported, mode, preferHostedCapture],
  );

  const starting = route.useHostedVoiceCapture ? hostedVoiceStarting : localVoiceStarting;
  const listening = route.useHostedVoiceCapture ? hostedVoiceRecording : localVoiceListening;
  const error = route.useHostedVoiceCapture ? hostedVoiceError : localVoiceError;
  const state = selectVoiceTurnState({
    starting,
    listening,
    transcribing: hostedVoiceTranscribing,
  });
  const [completedTranscript, setCompletedTranscript] = useState("");
  const nativeVoiceCaptureActive = starting || listening;

  const clearTranscript = useCallback(() => {
    clearLocalVoiceTranscript();
    clearHostedVoiceTranscript();
    setCompletedTranscript("");
  }, [clearHostedVoiceTranscript, clearLocalVoiceTranscript]);

  useEffect(() => {
    if (route.useHostedVoiceCapture) {
      return;
    }
    const trimmedTranscript = localVoiceTranscript.trim();
    if (!trimmedTranscript || starting || listening) {
      return;
    }
    setCompletedTranscript((currentValue) =>
      currentValue === trimmedTranscript ? currentValue : trimmedTranscript,
    );
  }, [listening, localVoiceTranscript, route.useHostedVoiceCapture, starting]);

  useEffect(() => {
    if (!route.useHostedVoiceCapture) {
      return;
    }
    const trimmedTranscript = hostedCompletedTranscript.trim();
    if (!trimmedTranscript) {
      return;
    }
    setCompletedTranscript((currentValue) =>
      currentValue === trimmedTranscript ? currentValue : trimmedTranscript,
    );
  }, [hostedCompletedTranscript, route.useHostedVoiceCapture]);

  useEffect(() => {
    if (!hostedTurnLocked) {
      return;
    }
    if (hostedVoiceStarting || hostedVoiceRecording || hostedVoiceTranscribing) {
      return;
    }
    setHostedTurnLocked(false);
  }, [hostedTurnLocked, hostedVoiceRecording, hostedVoiceStarting, hostedVoiceTranscribing]);

  useEffect(() => {
    void setNativeHostVoiceCaptureActive(nativeVoiceCaptureActive);
    return () => {
      if (nativeVoiceCaptureActive) {
        void setNativeHostVoiceCaptureActive(false);
      }
    };
  }, [nativeVoiceCaptureActive]);

  const start = useCallback(async (startOptions?: { hostedAutoStop?: HostedVoiceAutoStopConfigInput | null }) => {
    if (!route.voiceSupported || hostedVoiceTranscribing) {
      return false;
    }
    if (
      !shouldBypassVoiceTurnMicrophonePermission({
        useHostedVoiceCapture: route.useHostedVoiceCapture,
        hostedTestCaptureConfigured,
      })
    ) {
      const nativePermission = await ensureNativeHostMicrophonePermission();
      if (nativePermission && nativePermission !== "granted") {
        const message =
          nativePermission === "denied"
            ? "Microphone permission is denied on this device."
            : "Microphone permission is required before voice input can start.";
        onError?.(message);
        return false;
      }
    }
    clearTranscript();
    if (route.useHostedVoiceCapture) {
      const started = await startHostedVoiceCapture({
        autoStop: startOptions?.hostedAutoStop,
      });
      if (started) {
        setHostedTurnLocked(true);
      }
      return started;
    }
    return await startVoiceInput();
  }, [
    clearTranscript,
    hostedVoiceTranscribing,
    hostedTestCaptureConfigured,
    onError,
    route.useHostedVoiceCapture,
    route.voiceSupported,
    setHostedTurnLocked,
    startHostedVoiceCapture,
    startVoiceInput,
  ]);

  const stop = useCallback(async () => {
    if (route.useHostedVoiceCapture) {
      if (!hostedVoiceRecording && !hostedVoiceStarting) {
        return "";
      }
      const transcript = (await stopHostedVoiceCapture()).trim();
      if (transcript) {
        setCompletedTranscript(transcript);
      }
      return transcript;
    }
    if (localVoiceListening || localVoiceStarting) {
      stopVoiceInput();
    }
    return "";
  }, [
    hostedVoiceRecording,
    hostedVoiceStarting,
    localVoiceListening,
    localVoiceStarting,
    route.useHostedVoiceCapture,
    stopHostedVoiceCapture,
    stopVoiceInput,
  ]);

  const cancel = useCallback(() => {
    clearTranscript();
    if (route.useHostedVoiceCapture) {
      setHostedTurnLocked(false);
      cancelHostedVoiceCapture();
      return;
    }
    cancelVoiceInput();
  }, [cancelHostedVoiceCapture, cancelVoiceInput, clearTranscript, route.useHostedVoiceCapture]);

  return {
    supported: route.voiceSupported,
    hostedCaptureSupported: hostedVoiceSupported,
    effectiveMode: route.effectiveMode,
    useHostedVoiceCapture: route.useHostedVoiceCapture,
    capture: route.useHostedVoiceCapture ? "hosted" : "device",
    backendKind: transcriptionBackend.kind,
    backendLabel: transcriptionBackend.label,
    backendConfigPresent: hostedBackendConfigPresent,
    mediaRecorderSupported: hostedMediaRecorderSupported,
    backendResolutionStatus: hostedBackendResolutionStatus,
    backendResolutionError: hostedBackendResolutionError,
    state,
    starting,
    listening,
    transcribing: hostedVoiceTranscribing,
    error,
    liveTranscript: localVoiceTranscript,
    completedTranscript,
    hostedTestCaptureConfigured,
    start,
    stop,
    cancel,
    clearTranscript,
    isBenignNoSpeechError: isBenignNoSpeechVoiceInputError,
  };
}
