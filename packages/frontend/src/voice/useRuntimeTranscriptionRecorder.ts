import { useCallback, useEffect, useRef, useState } from "react";
import {
  resolveSpeechTranscriptionBackend,
  transcribeAudioWithSpeechService,
  type SpeechTranscriptionBackendDescriptor,
} from "./speechService";
import { subscribeDesktopLanDiscoverySnapshots } from "./desktopLanDiscovery";
import { createAudioArtifactFromBlob } from "./audioArtifact";
import { getRuntimeTranscriptionBackendConfig } from "./runtimeTranscriptionClient";
import {
  advanceHostedVoiceAutoStopState,
  createHostedVoiceAutoStopState,
  measureHostedVoiceAutoStopLevel,
  resolveHostedVoiceAutoStopConfig,
  type HostedVoiceAutoStopConfigInput,
} from "./hostedVoiceAutoStop";

type RecorderSession = {
  recorder: MediaRecorder;
  stream: MediaStream;
  mimeType: string;
  stopped: Promise<Blob | null>;
};

type HostedVoiceCaptureTestSessionOptions = {
  audioDataUrl: string;
  fileName?: string;
  readyDelayMs?: number;
  finalDelayMs?: number;
  transcriptText?: string;
};

type HostedVoiceCaptureTestController = {
  configure: (options: HostedVoiceCaptureTestSessionOptions) => Promise<boolean>;
  clear: () => Promise<boolean>;
};

type HostedVoiceCaptureTestWindow = Window & {
  __INSTAFY_HOSTED_VOICE_CAPTURE_TEST__?: HostedVoiceCaptureTestController;
};

type HostedVoiceCaptureStartOptions = {
  autoStop?: HostedVoiceAutoStopConfigInput | null;
};

type AudioContextWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

const PREFERRED_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];
const SPEECH_BACKEND_RESOLUTION_RETRY_MS = 1_000;

function getMediaRecorderSupport(): boolean {
  return typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined";
}

function pickPreferredMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  for (const candidate of PREFERRED_AUDIO_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

function guessRecordingFileName(mimeType: string): string {
  if (mimeType.includes("mp4")) {
    return "voice-capture.mp4";
  }
  if (mimeType.includes("ogg")) {
    return "voice-capture.ogg";
  }
  if (mimeType.includes("mpeg")) {
    return "voice-capture.mp3";
  }
  return "voice-capture.webm";
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  const runtimeWindow = window as AudioContextWindow;
  return runtimeWindow.AudioContext ?? runtimeWindow.webkitAudioContext ?? null;
}

function decodeDataUrlToBlob(dataUrl: string): Blob | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const metadata = dataUrl.slice("data:".length, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const metadataParts = metadata
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const mimeType = metadataParts[0] && metadataParts[0] !== "base64" ? metadataParts[0] : "";
  const isBase64 = metadataParts.includes("base64");

  try {
    const raw = isBase64 ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType || "application/octet-stream" });
  } catch {
    return null;
  }
}

export function useRuntimeTranscriptionRecorder({
  onError,
  projectId,
  accessToken,
  resolveBackend: resolveBackendEnabled = true,
  resolutionKey = null,
}: {
  onError?: (message: string) => void;
  projectId?: string | null;
  accessToken?: string | null;
  resolveBackend?: boolean;
  resolutionKey?: string | null;
}) {
  const mediaRecorderSupported = getMediaRecorderSupport();
  const backendConfigPresent = Boolean(getRuntimeTranscriptionBackendConfig());
  const [backend, setBackend] = useState<SpeechTranscriptionBackendDescriptor>({
    kind: "none",
    label: null,
    providerId: null,
  });
  const [backendResolutionStatus, setBackendResolutionStatus] = useState<"pending" | "ready" | "error">("pending");
  const [backendResolutionError, setBackendResolutionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedTranscript, setCompletedTranscript] = useState("");
  const [hostedTestCaptureConfigured, setHostedTestCaptureConfigured] = useState(false);
  const sessionRef = useRef<RecorderSession | null>(null);
  const hostedTestSessionRef = useRef<HostedVoiceCaptureTestSessionOptions | null>(null);
  const startPromiseRef = useRef<Promise<boolean> | null>(null);
  const stopPromiseRef = useRef<Promise<string> | null>(null);
  const operationVersionRef = useRef(0);
  const startingRef = useRef(false);
  const recordingRef = useRef(false);
  const autoStopCleanupRef = useRef<(() => void) | null>(null);
  const backendResolutionRetryRef = useRef<number | null>(null);

  const updateStarting = useCallback((value: boolean) => {
    startingRef.current = value;
    setStarting(value);
  }, []);

  const updateRecording = useCallback((value: boolean) => {
    recordingRef.current = value;
    setRecording(value);
  }, []);

  const clearAutoStopMonitor = useCallback(() => {
    const cleanup = autoStopCleanupRef.current;
    autoStopCleanupRef.current = null;
    cleanup?.();
  }, []);

  const clearBackendResolutionRetry = useCallback(() => {
    if (backendResolutionRetryRef.current === null) {
      return;
    }
    window.clearTimeout(backendResolutionRetryRef.current);
    backendResolutionRetryRef.current = null;
  }, []);

  const cleanupSession = useCallback((sessionOverride?: RecorderSession | null) => {
    const session = sessionOverride ?? sessionRef.current;
    if (!session) {
      return;
    }
    if (!sessionOverride) {
      sessionRef.current = null;
    }
    for (const track of session.stream.getTracks()) {
      track.stop();
    }
  }, []);

  const clearCompletedTranscript = useCallback(() => {
    setCompletedTranscript("");
    setError(null);
  }, []);

  useEffect(() => () => {
    clearAutoStopMonitor();
    clearBackendResolutionRetry();
    cleanupSession();
  }, [cleanupSession, clearAutoStopMonitor, clearBackendResolutionRetry]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const runtimeWindow = window as HostedVoiceCaptureTestWindow;
    const controller: HostedVoiceCaptureTestController = {
      configure: async (options) => {
        hostedTestSessionRef.current = {
          audioDataUrl: options.audioDataUrl,
          fileName: options.fileName,
          readyDelayMs: options.readyDelayMs,
          finalDelayMs: options.finalDelayMs,
          transcriptText: options.transcriptText,
        };
        setHostedTestCaptureConfigured(true);
        return true;
      },
      clear: async () => {
        hostedTestSessionRef.current = null;
        setHostedTestCaptureConfigured(false);
        return true;
      },
    };
    runtimeWindow.__INSTAFY_HOSTED_VOICE_CAPTURE_TEST__ = controller;
    return () => {
      if (runtimeWindow.__INSTAFY_HOSTED_VOICE_CAPTURE_TEST__ === controller) {
        delete runtimeWindow.__INSTAFY_HOSTED_VOICE_CAPTURE_TEST__;
      }
      hostedTestSessionRef.current = null;
      setHostedTestCaptureConfigured(false);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!resolveBackendEnabled) {
      clearBackendResolutionRetry();
      setBackend({
        kind: "none",
        label: null,
        providerId: null,
      });
      setBackendResolutionStatus("ready");
      setBackendResolutionError(null);
      return () => {
        cancelled = true;
      };
    }
    const scheduleRetry = () => {
      clearBackendResolutionRetry();
      backendResolutionRetryRef.current = window.setTimeout(() => {
        void resolveBackend();
      }, SPEECH_BACKEND_RESOLUTION_RETRY_MS);
    };
    const resolveBackend = async () => {
      clearBackendResolutionRetry();
      setBackendResolutionStatus("pending");
      setBackendResolutionError(null);
      try {
        const value = await resolveSpeechTranscriptionBackend({
          projectId: projectId ?? null,
          accessToken: accessToken ?? null,
        });
        if (cancelled) {
          return;
        }
        setBackend(value);
        setBackendResolutionStatus("ready");
        setBackendResolutionError(null);
        if (value.kind === "none") {
          scheduleRetry();
        }
      } catch (resolveError) {
        if (cancelled) {
          return;
        }
        setBackend({
          kind: "none",
          label: null,
          providerId: null,
        });
        setBackendResolutionStatus("error");
        setBackendResolutionError(
          resolveError instanceof Error ? resolveError.message : String(resolveError),
        );
        scheduleRetry();
      }
    };
    const handleVisibilityRefresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void resolveBackend();
    };

    void resolveBackend();
    const unsubscribeDesktopLanDiscovery = subscribeDesktopLanDiscoverySnapshots((snapshot) => {
      if (!snapshot) {
        return;
      }
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void resolveBackend();
    });
    window.addEventListener("focus", handleVisibilityRefresh);
    document.addEventListener("visibilitychange", handleVisibilityRefresh);
    return () => {
      cancelled = true;
      clearBackendResolutionRetry();
      unsubscribeDesktopLanDiscovery();
      window.removeEventListener("focus", handleVisibilityRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityRefresh);
    };
  }, [accessToken, clearBackendResolutionRetry, projectId, resolutionKey, resolveBackendEnabled]);

  const finishCapture = useCallback(
    async ({
      transcribe,
      reason,
    }: {
      transcribe: boolean;
      reason: "manual" | "silence" | "max-duration" | "no-speech";
    }) => {
      if (stopPromiseRef.current) {
        return stopPromiseRef.current;
      }
      const finisher = (async () => {
        if (startPromiseRef.current) {
          await startPromiseRef.current;
        }
        clearAutoStopMonitor();

        const session = sessionRef.current;
        const hostedTestSession = hostedTestSessionRef.current;
        if (!session && !hostedTestSession) {
          return "";
        }

        updateRecording(false);
        updateStarting(false);

        if (!transcribe) {
          if (session) {
            try {
              if (session.recorder.state !== "inactive") {
                session.recorder.stop();
              }
            } catch {
              // Ignore stop races during cancellation.
            }
            await session.stopped.catch(() => null);
            cleanupSession(session);
            sessionRef.current = null;
          }
          setCompletedTranscript("");
          const message = reason === "no-speech" ? "No speech detected." : null;
          if (message) {
            setError(message);
            onError?.(message);
          }
          return "";
        }

        try {
          const operationVersion = operationVersionRef.current;
          let audioBlob: Blob | null = null;
          let mimeType = "audio/wav";
          let fileName = "voice-capture.wav";

          if (session) {
            if (session.recorder.state !== "inactive") {
              session.recorder.stop();
            }
            audioBlob = await session.stopped;
            cleanupSession(session);
            sessionRef.current = null;
            mimeType = session.mimeType;
            fileName = guessRecordingFileName(session.mimeType);
          } else if (hostedTestSession) {
            const finalDelayMs = Math.max(0, hostedTestSession.finalDelayMs ?? 0);
            if (finalDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, finalDelayMs));
            }
            const hostedTestTranscript = hostedTestSession.transcriptText?.trim();
            if (hostedTestTranscript) {
              setCompletedTranscript(hostedTestTranscript);
              setError(null);
              return hostedTestTranscript;
            }
            const decodedHostedAudioBlob = decodeDataUrlToBlob(hostedTestSession.audioDataUrl);
            const hostedAudioBlob = decodedHostedAudioBlob
              ? decodedHostedAudioBlob
              : await fetch(hostedTestSession.audioDataUrl).then((response) => response.blob());
            audioBlob = hostedAudioBlob;
            mimeType = hostedAudioBlob.type || "audio/wav";
            fileName = hostedTestSession.fileName ?? guessRecordingFileName(mimeType);
          }

          if (!audioBlob) {
            throw new Error("No audio was captured for transcription.");
          }
          const capturedAudioBlob = audioBlob;
          if (operationVersionRef.current !== operationVersion) {
            return "";
          }

          setTranscribing(true);
          const artifact = createAudioArtifactFromBlob(capturedAudioBlob, {
            baseName: "voice-capture",
            fileName,
            mimeType,
          });
          const result = await transcribeAudioWithSpeechService({
            artifact,
            projectId: projectId ?? null,
            accessToken: accessToken ?? null,
          });
          if (operationVersionRef.current !== operationVersion) {
            return "";
          }
          const transcript = result.transcript.trim();
          setCompletedTranscript(transcript);
          setError(null);
          return transcript;
        } catch (finishError) {
          const message =
            finishError instanceof Error ? finishError.message : "Speech transcription failed.";
          setError(message);
          onError?.(message);
          return "";
        } finally {
          setTranscribing(false);
        }
      })().finally(() => {
        stopPromiseRef.current = null;
      });

      stopPromiseRef.current = finisher;
      return finisher;
    },
    [
      accessToken,
      cleanupSession,
      clearAutoStopMonitor,
      onError,
      projectId,
      updateRecording,
      updateStarting,
    ],
  );

  const armAutoStopMonitor = useCallback(
    ({
      stream,
      config,
      operationVersion,
      hostedTestSession,
    }: {
      stream?: MediaStream | null;
      config: NonNullable<ReturnType<typeof resolveHostedVoiceAutoStopConfig>>;
      operationVersion: number;
      hostedTestSession?: HostedVoiceCaptureTestSessionOptions | null;
    }) => {
      clearAutoStopMonitor();

      if (hostedTestSession) {
        const autoStopDelayMs = Math.max(
          config.minSpeechDurationMs + config.silenceDurationMs,
          (hostedTestSession.finalDelayMs ?? 0) + 1_200,
        );
        const timerId = window.setTimeout(() => {
          if (operationVersionRef.current !== operationVersion) {
            return;
          }
          void finishCapture({
            transcribe: true,
            reason: "silence",
          });
        }, autoStopDelayMs);
        autoStopCleanupRef.current = () => {
          window.clearTimeout(timerId);
        };
        return;
      }

      if (!stream) {
        return;
      }

      const AudioContextCtor = getAudioContextConstructor();
      let intervalId: number | null = null;
      let audioContext: AudioContext | null = null;
      let sourceNode: MediaStreamAudioSourceNode | null = null;
      let analyserNode: AnalyserNode | null = null;

      const cleanup = () => {
        if (intervalId !== null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
        try {
          sourceNode?.disconnect();
        } catch {
          // Ignore disconnect races during cleanup.
        }
        try {
          analyserNode?.disconnect();
        } catch {
          // Ignore disconnect races during cleanup.
        }
        sourceNode = null;
        analyserNode = null;
        if (audioContext) {
          void audioContext.close().catch(() => {
            // Ignore close failures during teardown.
          });
          audioContext = null;
        }
      };

      try {
        const data = new Uint8Array(2048);
        let state = createHostedVoiceAutoStopState(Date.now());

        if (AudioContextCtor) {
          audioContext = new AudioContextCtor();
          sourceNode = audioContext.createMediaStreamSource(stream);
          analyserNode = audioContext.createAnalyser();
          analyserNode.fftSize = 2048;
          analyserNode.smoothingTimeConstant = 0.12;
          sourceNode.connect(analyserNode);
        }

        intervalId = window.setInterval(() => {
          if (operationVersionRef.current !== operationVersion) {
            cleanup();
            return;
          }
          let level = 0;
          if (analyserNode) {
            analyserNode.getByteTimeDomainData(data);
            level = measureHostedVoiceAutoStopLevel(data);
          }
          const decision = advanceHostedVoiceAutoStopState(state, {
            nowMs: Date.now(),
            level,
            config,
          });
          state = decision.state;
          if (decision.action === "continue") {
            return;
          }
          cleanup();
          void finishCapture({
            transcribe: decision.action === "stop",
            reason: decision.reason ?? "silence",
          });
        }, config.sampleIntervalMs);

        autoStopCleanupRef.current = cleanup;
      } catch {
        cleanup();
        const timerId = window.setTimeout(() => {
          if (operationVersionRef.current !== operationVersion) {
            return;
          }
          void finishCapture({
            transcribe: true,
            reason: "max-duration",
          });
        }, config.maxDurationMs);
        autoStopCleanupRef.current = () => {
          window.clearTimeout(timerId);
        };
      }
    },
    [clearAutoStopMonitor, finishCapture],
  );

  const start = useCallback(
    async (options?: HostedVoiceCaptureStartOptions) => {
      const hostedTestSession = hostedTestSessionRef.current;
      if (!hostedTestSession && backend.kind === "none") {
        const message = "Speech transcription is not configured.";
        setError(message);
        onError?.(message);
        return false;
      }
      if (!hostedTestSession && !getMediaRecorderSupport()) {
        const message = "This client cannot record audio for the configured speech service.";
        setError(message);
        onError?.(message);
        return false;
      }
      if (sessionRef.current || starting || recording || transcribing || stopPromiseRef.current) {
        return false;
      }

      const starter = (async () => {
        const operationVersion = operationVersionRef.current + 1;
        operationVersionRef.current = operationVersion;
        updateStarting(true);
        clearCompletedTranscript();
        clearAutoStopMonitor();

        try {
          const autoStopConfig = resolveHostedVoiceAutoStopConfig(options?.autoStop);
          if (hostedTestSession) {
            const readyDelayMs = Math.max(0, hostedTestSession.readyDelayMs ?? 0);
            if (readyDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, readyDelayMs));
            }
            if (operationVersionRef.current !== operationVersion) {
              return false;
            }
            updateRecording(true);
            if (autoStopConfig) {
              armAutoStopMonitor({
                config: autoStopConfig,
                operationVersion,
                hostedTestSession,
              });
            }
            return true;
          }

          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (operationVersionRef.current !== operationVersion) {
            for (const track of stream.getTracks()) {
              track.stop();
            }
            return false;
          }
          const preferredMimeType = pickPreferredMimeType();
          const chunks: Blob[] = [];
          let resolveStopped: (value: Blob | null) => void = () => {};
          const stopped = new Promise<Blob | null>((resolve) => {
            resolveStopped = resolve;
          });
          const recorder = preferredMimeType
            ? new MediaRecorder(stream, { mimeType: preferredMimeType })
            : new MediaRecorder(stream);
          recorder.addEventListener("dataavailable", (event: BlobEvent) => {
            if (event.data.size > 0) {
              chunks.push(event.data);
            }
          });
          recorder.addEventListener(
            "stop",
            () => {
              const resolvedMimeType =
                recorder.mimeType || preferredMimeType || chunks[0]?.type || "audio/webm";
              resolveStopped(
                chunks.length > 0
                  ? new Blob(chunks, {
                      type: resolvedMimeType,
                    })
                  : null,
              );
            },
            { once: true },
          );
          recorder.addEventListener(
            "error",
            () => {
              resolveStopped(null);
            },
            { once: true },
          );
          recorder.start();
          if (operationVersionRef.current !== operationVersion) {
            try {
              recorder.stop();
            } catch {
              // Ignore stop races during cancellation.
            }
            for (const track of stream.getTracks()) {
              track.stop();
            }
            return false;
          }
          sessionRef.current = {
            recorder,
            stream,
            mimeType: recorder.mimeType || preferredMimeType || "audio/webm",
            stopped,
          };
          updateRecording(true);
          if (autoStopConfig) {
            armAutoStopMonitor({
              stream,
              config: autoStopConfig,
              operationVersion,
            });
          }
          return true;
        } catch (startError) {
          const message =
            startError instanceof Error
              ? startError.message
              : "Microphone access failed for speech recording.";
          setError(message);
          onError?.(message);
          clearAutoStopMonitor();
          cleanupSession();
          return false;
        } finally {
          updateStarting(false);
          startPromiseRef.current = null;
        }
      })();

      startPromiseRef.current = starter;
      return starter;
    },
    [
      armAutoStopMonitor,
      backend.kind,
      cleanupSession,
      clearAutoStopMonitor,
      clearCompletedTranscript,
      onError,
      recording,
      starting,
      transcribing,
      updateRecording,
      updateStarting,
    ],
  );

  const stopAndTranscribe = useCallback(async () => {
    return await finishCapture({
      transcribe: true,
      reason: "manual",
    });
  }, [finishCapture]);

  const cancel = useCallback(() => {
    operationVersionRef.current += 1;
    startPromiseRef.current = null;
    stopPromiseRef.current = null;
    clearAutoStopMonitor();
    updateStarting(false);
    updateRecording(false);
    setTranscribing(false);
    setError(null);
    setCompletedTranscript("");
    const session = sessionRef.current;
    if (session) {
      try {
        if (session.recorder.state !== "inactive") {
          session.recorder.stop();
        }
      } catch {
        // Ignore recorder stop races during cancellation.
      }
    }
    cleanupSession();
  }, [cleanupSession, clearAutoStopMonitor, updateRecording, updateStarting]);

  return {
    backend,
    supported:
      hostedTestCaptureConfigured || (backend.kind !== "none" && mediaRecorderSupported),
    backendConfigPresent,
    mediaRecorderSupported,
    backendResolutionStatus,
    backendResolutionError,
    starting,
    recording,
    transcribing,
    error,
    completedTranscript,
    hostedTestCaptureConfigured,
    start,
    stopAndTranscribe,
    cancel,
    clearCompletedTranscript,
  };
}
