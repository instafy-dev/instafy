import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { logAppError, logAppInfo, logAppWarn } from "../debug/appLogs";

export const NATIVE_VOICE_INPUT_EVENT = "instafy:native-voice-input";
const NATIVE_VOICE_INPUT_BRIDGE = "instafyVoiceInput";

type NativeVoiceInputEventDetail =
  | {
      type: "state";
      listening: boolean;
    }
  | {
      type: "transcript";
      transcript: string;
      listening?: boolean;
    }
  | {
      type: "error";
      message: string;
    };

type NativeVoiceBridge = {
  postMessage: (message: { type: "start" | "stop" | "cancel" }) => void;
};

type NativeAndroidVoiceInputEvent = NativeVoiceInputEventDetail;

type NativeAndroidVoiceInputPlugin = {
  addListener(
    eventName: "voiceInput",
    listenerFunc: (event: NativeAndroidVoiceInputEvent) => void,
  ): Promise<PluginListenerHandle>;
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  cancelListening(): Promise<void>;
  configureTestSession(options: {
    transcript: string;
    partialTranscript?: string;
    readyDelayMs?: number;
    finalDelayMs?: number;
  }): Promise<void>;
  clearTestSession(): Promise<void>;
};

type NativeVoiceInputTestController = {
  configure: (options: {
    transcript: string;
    partialTranscript?: string;
    readyDelayMs?: number;
    finalDelayMs?: number;
  }) => Promise<boolean>;
  clear: () => Promise<boolean>;
};

type WebkitBridgeWindow = Window & {
  webkit?: {
    messageHandlers?: Record<string, NativeVoiceBridge | undefined>;
  };
};

type NativeVoiceInputTestWindow = Window & {
  __INSTAFY_NATIVE_VOICE_INPUT_TEST__?: NativeVoiceInputTestController;
};

let nativeAndroidVoiceInputPlugin: NativeAndroidVoiceInputPlugin | null = null;
let nativeAndroidVoiceInputPluginInitialized = false;

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: {
    transcript: string;
  };
};

type SpeechRecognitionResultListLike = {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
};

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
};

type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
  message?: string;
};

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getNativeVoiceBridge(): NativeVoiceBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const webkitWindow = window as WebkitBridgeWindow;
  return webkitWindow.webkit?.messageHandlers?.[NATIVE_VOICE_INPUT_BRIDGE] ?? null;
}

function getNativeAndroidVoiceInputPlugin(): NativeAndroidVoiceInputPlugin | null {
  if (Capacitor.getPlatform() !== "android") {
    return null;
  }
  if (!nativeAndroidVoiceInputPluginInitialized) {
    nativeAndroidVoiceInputPlugin =
      registerPlugin<NativeAndroidVoiceInputPlugin>("InstafyVoiceInputBridge");
    nativeAndroidVoiceInputPluginInitialized = true;
  }
  return nativeAndroidVoiceInputPlugin;
}

function getWebSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const source = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return source.SpeechRecognition ?? source.webkitSpeechRecognition ?? null;
}

export function mergeVoiceTranscript(baseDraft: string, transcript: string): string {
  const trimmedBase = baseDraft.trimEnd();
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) {
    return trimmedBase;
  }
  if (!trimmedBase) {
    return trimmedTranscript;
  }
  return `${trimmedBase}${/\s$/.test(trimmedBase) ? "" : " "}${trimmedTranscript}`;
}

export function getNativeVoiceRestartCooldownMs(message: string): number {
  const normalized = message.trim().toLowerCase();
  if (normalized.includes("kafassistanterrordomain error 1107")) {
    return 2500;
  }
  if (normalized.includes("kafassistanterrordomain error 1100")) {
    return 1200;
  }
  return 0;
}

export function getNativeVoiceInputErrorMessage(message: string): string {
  const trimmed = message.trim();
  const normalized = trimmed.toLowerCase();

  if (!trimmed) {
    return "Voice input failed.";
  }
  if (normalized.includes("kafassistanterrordomain error 1107")) {
    return "Voice input was interrupted. Try holding to talk again.";
  }
  if (normalized.includes("kafassistanterrordomain error 1100")) {
    return "Voice input is resetting. Try again in a moment.";
  }
  return trimmed;
}

export function shouldAutoRetryNativeVoiceError(
  message: string,
  desiredActive: boolean,
  retryCount: number,
): boolean {
  return desiredActive && retryCount < 1 && getNativeVoiceRestartCooldownMs(message) > 0;
}

export function isBenignNoSpeechVoiceInputError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized.includes("no speech") || normalized.includes("kafassistanterrordomain error 1110");
}

export function getWebVoiceInputErrorMessage(errorCode?: string, detailedMessage?: string): string {
  const normalizedCode = typeof errorCode === "string" ? errorCode.trim().toLowerCase() : "";
  const normalizedDetail = typeof detailedMessage === "string" ? detailedMessage.trim() : "";

  switch (normalizedCode) {
    case "audio-capture":
      return "Voice input could not access your microphone.";
    case "not-allowed":
      return "Microphone permission was denied for browser voice input.";
    case "service-not-allowed":
      return "This browser blocked its speech recognition service.";
    case "language-not-supported":
      return "This browser does not support voice input for your current language.";
    case "network":
      return typeof navigator !== "undefined" && navigator.onLine === false
        ? "Browser voice input needs an internet connection."
        : "Browser voice input could not reach its speech recognition service.";
    default:
      if (normalizedDetail.length > 0) {
        return `Voice input failed: ${normalizedDetail}`;
      }
      if (normalizedCode.length > 0) {
        return `Voice input failed: ${normalizedCode}.`;
      }
      return "Voice input failed.";
  }
}

export function useVoiceInput({
  onError,
}: {
  onError?: (message: string) => void;
}) {
  const nativeBridge = getNativeVoiceBridge();
  const nativeAndroidVoiceInputPlugin = getNativeAndroidVoiceInputPlugin();
  const supportsNativeBridge =
    Capacitor.isNativePlatform() &&
    ((Capacitor.getPlatform() === "ios" && Boolean(nativeBridge)) ||
      (Capacitor.getPlatform() === "android" && Boolean(nativeAndroidVoiceInputPlugin)));
  const supportsWebSpeech = Boolean(getWebSpeechRecognitionConstructor());
  const supported = supportsNativeBridge || supportsWebSpeech;
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [starting, setStarting] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const loggedTranscriptThisSessionRef = useRef(false);
  const nativeRestartBlockedUntilRef = useRef(0);
  const nativeStartPendingRef = useRef(false);
  const nativeDesiredActiveRef = useRef(false);
  const nativeAutoRetryTimerRef = useRef<number | null>(null);
  const nativeAutoRetryCountRef = useRef(0);
  const startingRef = useRef(false);
  const listeningRef = useRef(false);

  useEffect(() => {
    startingRef.current = starting;
  }, [starting]);

  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);

  const clearTranscript = useCallback(() => {
    setTranscript("");
    setError(null);
  }, []);

  const clearNativeAutoRetry = useCallback(() => {
    if (nativeAutoRetryTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(nativeAutoRetryTimerRef.current);
      nativeAutoRetryTimerRef.current = null;
    }
  }, []);

  const beginNativeVoiceInputStart = useCallback(
    (resetRetryCount: boolean) => {
      if (resetRetryCount) {
        nativeAutoRetryCountRef.current = 0;
      }
      clearNativeAutoRetry();
      setError(null);
      setTranscript("");
      loggedTranscriptThisSessionRef.current = false;
      nativeDesiredActiveRef.current = true;
      if (nativeStartPendingRef.current || startingRef.current || listeningRef.current) {
        return false;
      }
      const blockedForMs = nativeRestartBlockedUntilRef.current - Date.now();
      if (blockedForMs > 0) {
        nativeDesiredActiveRef.current = false;
        const nextMessage = "Voice input is resetting. Try again in a moment.";
        setStarting(false);
        setListening(false);
        setError(nextMessage);
        logAppWarn(`${nextMessage} (${blockedForMs}ms remaining)`);
        onError?.(nextMessage);
        return false;
      }
      nativeStartPendingRef.current = true;
      setStarting(true);
      logAppInfo("Voice input start requested (native).");
      if (Capacitor.getPlatform() === "android") {
        void nativeAndroidVoiceInputPlugin?.startListening().catch((error) => {
          nativeStartPendingRef.current = false;
          setStarting(false);
          const nextMessage =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Unable to start voice input.";
          setError(nextMessage);
          onError?.(nextMessage);
        });
      } else {
        nativeBridge?.postMessage({ type: "start" });
      }
      return true;
    },
    [clearNativeAutoRetry, nativeAndroidVoiceInputPlugin, nativeBridge, onError],
  );

  const handleNativeVoiceInputDetail = useCallback(
    (detail: NativeVoiceInputEventDetail | undefined) => {
      if (!detail || typeof detail !== "object") {
        return;
      }

      if (detail.type === "state") {
        nativeStartPendingRef.current = false;
        setStarting(false);
        setListening(Boolean(detail.listening));
        logAppInfo(
          detail.listening ? "Voice input listening started (native)." : "Voice input listening stopped (native).",
        );
        return;
      }

      if (detail.type === "transcript") {
        const nextTranscript = typeof detail.transcript === "string" ? detail.transcript : "";
        nativeStartPendingRef.current = false;
        setStarting(false);
        setTranscript(nextTranscript);
        if (nextTranscript && !loggedTranscriptThisSessionRef.current) {
          loggedTranscriptThisSessionRef.current = true;
          logAppInfo(`Voice input received transcript (native, ${nextTranscript.length} chars).`);
        }
        if (typeof detail.listening === "boolean") {
          setListening(detail.listening);
        }
        return;
      }

      const rawMessage =
        typeof detail.message === "string" && detail.message.trim().length > 0
          ? detail.message.trim()
          : "Voice input failed.";
      const userFacingMessage = getNativeVoiceInputErrorMessage(rawMessage);
      const cooldownMs = getNativeVoiceRestartCooldownMs(rawMessage);
      const shouldRetry = shouldAutoRetryNativeVoiceError(
        rawMessage,
        nativeDesiredActiveRef.current,
        nativeAutoRetryCountRef.current,
      );
      nativeStartPendingRef.current = false;
      setStarting(false);
      setListening(false);
      setTranscript("");
      loggedTranscriptThisSessionRef.current = false;
      if (cooldownMs > 0) {
        nativeRestartBlockedUntilRef.current = Date.now() + cooldownMs;
      }
      if (shouldRetry) {
        nativeAutoRetryCountRef.current += 1;
        setError(null);
        logAppWarn(`Voice input transient failure (native): ${rawMessage}. Retrying once.`);
        clearNativeAutoRetry();
        nativeAutoRetryTimerRef.current = window.setTimeout(() => {
          nativeAutoRetryTimerRef.current = null;
          if (!nativeDesiredActiveRef.current) {
            return;
          }
          beginNativeVoiceInputStart(false);
        }, cooldownMs + 150);
        return;
      }
      nativeDesiredActiveRef.current = false;
      clearNativeAutoRetry();
      setError(userFacingMessage);
      logAppWarn(`Voice input error (native): ${rawMessage}`);
      onError?.(userFacingMessage);
    },
    [beginNativeVoiceInputStart, clearNativeAutoRetry, onError],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const voiceTestWindow = window as NativeVoiceInputTestWindow;
    if (Capacitor.getPlatform() !== "android" || !nativeAndroidVoiceInputPlugin) {
      delete voiceTestWindow.__INSTAFY_NATIVE_VOICE_INPUT_TEST__;
      return;
    }

    const controller: NativeVoiceInputTestController = {
      configure: async (options) => {
        await nativeAndroidVoiceInputPlugin.configureTestSession(options);
        return true;
      },
      clear: async () => {
        await nativeAndroidVoiceInputPlugin.clearTestSession();
        return true;
      },
    };

    voiceTestWindow.__INSTAFY_NATIVE_VOICE_INPUT_TEST__ = controller;
    return () => {
      if (voiceTestWindow.__INSTAFY_NATIVE_VOICE_INPUT_TEST__ === controller) {
        delete voiceTestWindow.__INSTAFY_NATIVE_VOICE_INPUT_TEST__;
      }
    };
  }, [nativeAndroidVoiceInputPlugin]);

  useEffect(() => {
    if (!supportsNativeBridge || typeof window === "undefined") {
      return;
    }

    if (Capacitor.getPlatform() === "android" && nativeAndroidVoiceInputPlugin) {
      let cancelled = false;
      let listenerHandle: PluginListenerHandle | null = null;

      void nativeAndroidVoiceInputPlugin
        .addListener("voiceInput", (event) => {
          if (cancelled) {
            return;
          }
          handleNativeVoiceInputDetail(event);
        })
        .then((handle) => {
          listenerHandle = handle;
        })
        .catch((nextError) => {
          if (cancelled) {
            return;
          }
          const message = nextError instanceof Error ? nextError.message : String(nextError);
          setError(message);
          onError?.(message);
        });

      return () => {
        cancelled = true;
        clearNativeAutoRetry();
        void listenerHandle?.remove();
      };
    }

    const handleNativeVoiceInput = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }
      handleNativeVoiceInputDetail(event.detail as NativeVoiceInputEventDetail | undefined);
    };

    window.addEventListener(NATIVE_VOICE_INPUT_EVENT, handleNativeVoiceInput);
    return () => {
      clearNativeAutoRetry();
      window.removeEventListener(NATIVE_VOICE_INPUT_EVENT, handleNativeVoiceInput);
    };
  }, [
    clearNativeAutoRetry,
    handleNativeVoiceInputDetail,
    nativeAndroidVoiceInputPlugin,
    onError,
    supportsNativeBridge,
  ]);

  const stopWebSpeechRecognition = useCallback((mode: "stop" | "abort") => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      return;
    }
    try {
      if (mode === "abort") {
        recognition.abort();
      } else {
        recognition.stop();
      }
    } catch {
      // Ignore repeated stop/abort attempts from platform speech APIs.
    }
  }, []);

  useEffect(() => {
    return () => {
      nativeDesiredActiveRef.current = false;
      nativeAutoRetryCountRef.current = 0;
      clearNativeAutoRetry();
      if (supportsNativeBridge) {
        if (Capacitor.getPlatform() === "android") {
          void nativeAndroidVoiceInputPlugin?.cancelListening().catch(() => {});
        } else {
          nativeBridge?.postMessage({ type: "cancel" });
        }
      } else {
        stopWebSpeechRecognition("abort");
      }
    };
  }, [
    clearNativeAutoRetry,
    nativeAndroidVoiceInputPlugin,
    nativeBridge,
    stopWebSpeechRecognition,
    supportsNativeBridge,
  ]);

  const start = useCallback(async () => {
    if (supportsNativeBridge) {
      return beginNativeVoiceInputStart(true);
    }

    setError(null);
    setTranscript("");
    loggedTranscriptThisSessionRef.current = false;

    const Recognition = getWebSpeechRecognitionConstructor();
    if (!Recognition) {
      const nextMessage = "Voice input is not supported on this device.";
      setStarting(false);
      setError(nextMessage);
      logAppWarn(nextMessage);
      onError?.(nextMessage);
      return false;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang =
      typeof navigator !== "undefined" && typeof navigator.language === "string"
        ? navigator.language
        : "en-US";
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setStarting(false);
      setListening(true);
      logAppInfo("Voice input listening started (web).");
    };
    recognition.onresult = (event) => {
      let finalTranscript = "";
      let interimTranscript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcriptChunk =
          typeof result?.[0]?.transcript === "string" ? result[0].transcript : "";
        if (!transcriptChunk) {
          continue;
        }
        if (result.isFinal) {
          finalTranscript += transcriptChunk;
        } else {
          interimTranscript += transcriptChunk;
        }
      }
      const nextTranscript = `${finalTranscript}${interimTranscript}`.trim();
      setStarting(false);
      setTranscript(nextTranscript);
      if (nextTranscript && !loggedTranscriptThisSessionRef.current) {
        loggedTranscriptThisSessionRef.current = true;
        logAppInfo(`Voice input received transcript (web, ${nextTranscript.length} chars).`);
      }
    };
    recognition.onerror = (event) => {
      const nextMessage = getWebVoiceInputErrorMessage(event.error, event.message);
      const errorLabel = typeof event.error === "string" && event.error.trim().length > 0 ? event.error.trim() : "unknown";
      const detailLabel =
        typeof event.message === "string" && event.message.trim().length > 0 ? ` (${event.message.trim()})` : "";
      setStarting(false);
      setListening(false);
      setError(nextMessage);
      logAppWarn(`Voice input error (web): ${errorLabel}${detailLabel} -> ${nextMessage}`);
      onError?.(nextMessage);
    };
    recognition.onend = () => {
      setStarting(false);
      setListening(false);
      recognitionRef.current = null;
      logAppInfo("Voice input listening stopped (web).");
    };

    recognitionRef.current = recognition;
    try {
      setStarting(true);
      logAppInfo("Voice input start requested (web).");
      recognition.start();
      return true;
    } catch (startError) {
      recognitionRef.current = null;
      const nextMessage =
        startError instanceof Error && startError.message.trim().length > 0
          ? startError.message
          : "Unable to start voice input.";
      setStarting(false);
      setListening(false);
      setError(nextMessage);
      logAppError("Voice input could not start (web).", startError);
      onError?.(nextMessage);
      return false;
    }
  }, [beginNativeVoiceInputStart, onError, supportsNativeBridge]);

  const stop = useCallback(() => {
    nativeStartPendingRef.current = false;
    nativeDesiredActiveRef.current = false;
    nativeAutoRetryCountRef.current = 0;
    clearNativeAutoRetry();
    setStarting(false);
    if (supportsNativeBridge) {
      logAppInfo("Voice input stop requested (native).");
      if (Capacitor.getPlatform() === "android") {
        void nativeAndroidVoiceInputPlugin?.stopListening().catch(() => {});
      } else {
        nativeBridge?.postMessage({ type: "stop" });
      }
      return;
    }
    logAppInfo("Voice input stop requested (web).");
    stopWebSpeechRecognition("stop");
  }, [
    clearNativeAutoRetry,
    nativeAndroidVoiceInputPlugin,
    nativeBridge,
    stopWebSpeechRecognition,
    supportsNativeBridge,
  ]);

  const cancel = useCallback(() => {
    nativeStartPendingRef.current = false;
    nativeDesiredActiveRef.current = false;
    nativeAutoRetryCountRef.current = 0;
    clearNativeAutoRetry();
    setStarting(false);
    if (supportsNativeBridge) {
      logAppInfo("Voice input canceled (native).");
      if (Capacitor.getPlatform() === "android") {
        void nativeAndroidVoiceInputPlugin?.cancelListening().catch(() => {});
      } else {
        nativeBridge?.postMessage({ type: "cancel" });
      }
    } else {
      logAppInfo("Voice input canceled (web).");
      stopWebSpeechRecognition("abort");
    }
    setListening(false);
    setTranscript("");
    loggedTranscriptThisSessionRef.current = false;
  }, [
    clearNativeAutoRetry,
    nativeAndroidVoiceInputPlugin,
    nativeBridge,
    stopWebSpeechRecognition,
    supportsNativeBridge,
  ]);

  return {
    supported,
    starting,
    listening,
    transcript,
    error,
    start,
    stop,
    cancel,
    clearTranscript,
  };
}
