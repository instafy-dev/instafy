import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { useEffect, useState } from "react";

export const NATIVE_AUDIO_SESSION_EVENT = "instafy:native-audio-session";
const NATIVE_AUDIO_SESSION_BRIDGE = "instafyAudioSession";

export type NativeHostAudioPermissionState =
  | "granted"
  | "prompt"
  | "denied"
  | "unsupported"
  | "unknown";

export type NativeHostAudioRouteKind =
  | "bluetooth"
  | "speaker"
  | "receiver"
  | "wired_or_builtin"
  | "unknown";

export type NativeHostAudioAppState = "active" | "inactive" | "background" | "unknown";

export type NativeHostAudioSessionSnapshot = {
  platform: "ios" | "android";
  appState: NativeHostAudioAppState;
  microphonePermission: NativeHostAudioPermissionState;
  audioSessionActive: boolean;
  voiceCaptureActive: boolean;
  interrupted: boolean;
  interruptionReason: string | null;
  routeChangeReason: string | null;
  inputLabels: string[];
  outputLabels: string[];
  preferredOutputLabel: string | null;
  bluetoothLikeOutputLabels: string[];
  routeKind: NativeHostAudioRouteKind;
  reason: string | null;
  updatedAt: string | null;
};

type NativeAudioSessionEventDetail =
  | {
      type: "status";
      snapshot: NativeHostAudioSessionSnapshot;
      requestId?: string;
    }
  | {
      type: "error";
      message: string;
      requestId?: string;
    };

type NativeAudioSessionBridge = {
  postMessage: (message: { type: "refresh" } | { type: "requestMicrophonePermission"; requestId: string }) => void;
};

type NativeAndroidAudioSessionEvent = {
  snapshot?: NativeHostAudioSessionSnapshot | null;
};

type NativeAndroidAudioSessionPlugin = {
  addListener(
    eventName: "audioSession",
    listenerFunc: (event: NativeAndroidAudioSessionEvent) => void,
  ): Promise<PluginListenerHandle>;
  getStatus(): Promise<NativeAndroidAudioSessionEvent>;
  requestMicrophonePermissions(): Promise<NativeAndroidAudioSessionEvent>;
  setVoiceCaptureActive(options: { active: boolean }): Promise<NativeAndroidAudioSessionEvent>;
};

type WebkitBridgeWindow = Window & {
  webkit?: {
    messageHandlers?: Record<string, NativeAudioSessionBridge | undefined>;
  };
};

let nativeAndroidAudioSessionPlugin: NativeAndroidAudioSessionPlugin | null = null;
let nativeAndroidAudioSessionPluginInitialized = false;
let lastNativeVoiceCaptureActive: boolean | null = null;

function getNativeAudioSessionBridge(): NativeAudioSessionBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const webkitWindow = window as WebkitBridgeWindow;
  return webkitWindow.webkit?.messageHandlers?.[NATIVE_AUDIO_SESSION_BRIDGE] ?? null;
}

function getNativeAndroidAudioSessionPlugin(): NativeAndroidAudioSessionPlugin | null {
  if (Capacitor.getPlatform() !== "android") {
    return null;
  }
  if (!nativeAndroidAudioSessionPluginInitialized) {
    nativeAndroidAudioSessionPlugin =
      registerPlugin<NativeAndroidAudioSessionPlugin>("InstafyAudioSessionBridge");
    nativeAndroidAudioSessionPluginInitialized = true;
  }
  return nativeAndroidAudioSessionPlugin;
}

async function requestNativeIosMicrophonePermission(
  bridge: NativeAudioSessionBridge,
): Promise<NativeHostAudioPermissionState | null> {
  if (typeof window === "undefined") {
    return null;
  }

  const requestId = `ios-mic-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return await new Promise<NativeHostAudioPermissionState | null>((resolve) => {
    let settled = false;
    let timeoutId = 0;

    const finish = (value: NativeHostAudioPermissionState | null) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener(NATIVE_AUDIO_SESSION_EVENT, handleEvent as EventListener);
      window.clearTimeout(timeoutId);
      resolve(value);
    };

    const handleEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }
      const detail = event.detail as NativeAudioSessionEventDetail | undefined;
      if (!detail || typeof detail !== "object" || detail.requestId !== requestId) {
        return;
      }
      if (detail.type === "status") {
        finish(normalizeSnapshot(detail.snapshot)?.microphonePermission ?? null);
        return;
      }
      if (detail.type === "error") {
        finish(null);
      }
    };

    window.addEventListener(NATIVE_AUDIO_SESSION_EVENT, handleEvent as EventListener);
    timeoutId = window.setTimeout(() => finish(null), 10_000);

    try {
      bridge.postMessage({ type: "requestMicrophonePermission", requestId });
    } catch {
      finish(null);
    }
  });
}

function normalizeSnapshot(
  value: NativeHostAudioSessionSnapshot | null | undefined,
): NativeHostAudioSessionSnapshot | null {
  return value ?? null;
}

export async function setNativeHostVoiceCaptureActive(active: boolean): Promise<void> {
  const nativeAndroidAudioSessionPlugin = getNativeAndroidAudioSessionPlugin();
  if (!nativeAndroidAudioSessionPlugin) {
    return;
  }
  if (lastNativeVoiceCaptureActive === active) {
    return;
  }
  try {
    await nativeAndroidAudioSessionPlugin.setVoiceCaptureActive({ active });
    lastNativeVoiceCaptureActive = active;
  } catch {
    // Ignore bridge failures; browser capture can still proceed.
  }
}

export async function ensureNativeHostMicrophonePermission(): Promise<NativeHostAudioPermissionState | null> {
  const nativeAndroidAudioSessionPlugin = getNativeAndroidAudioSessionPlugin();
  if (!nativeAndroidAudioSessionPlugin) {
    const bridge = getNativeAudioSessionBridge();
    if (Capacitor.getPlatform() === "ios" && bridge) {
      return await requestNativeIosMicrophonePermission(bridge);
    }
    return null;
  }
  try {
    const event = await nativeAndroidAudioSessionPlugin.requestMicrophonePermissions();
    return normalizeSnapshot(event?.snapshot)?.microphonePermission ?? null;
  } catch {
    return null;
  }
}

export function useNativeHostAudioSession(options?: {
  enabled?: boolean;
}) {
  const enabled = options?.enabled ?? true;
  const bridge = getNativeAudioSessionBridge();
  const nativeAndroidAudioSessionPlugin = getNativeAndroidAudioSessionPlugin();
  const supported =
    enabled &&
    Capacitor.isNativePlatform() &&
    ((Capacitor.getPlatform() === "ios" && Boolean(bridge)) ||
      (Capacitor.getPlatform() === "android" && Boolean(nativeAndroidAudioSessionPlugin)));
  const [value, setValue] = useState<NativeHostAudioSessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported || typeof window === "undefined") {
      setValue(null);
      setError(null);
      return;
    }

    if (Capacitor.getPlatform() === "android" && nativeAndroidAudioSessionPlugin) {
      let cancelled = false;
      let listenerHandle: PluginListenerHandle | null = null;

      void nativeAndroidAudioSessionPlugin
        .addListener("audioSession", (event) => {
          if (cancelled) {
            return;
          }
          const snapshot = normalizeSnapshot(event?.snapshot);
          if (snapshot) {
            setValue(snapshot);
            setError(null);
          }
        })
        .then((handle) => {
          listenerHandle = handle;
        })
        .catch((nextError) => {
          if (!cancelled) {
            const message = nextError instanceof Error ? nextError.message : String(nextError);
            setError(message);
          }
        });

      void nativeAndroidAudioSessionPlugin
        .getStatus()
        .then((event) => {
          if (cancelled) {
            return;
          }
          const snapshot = normalizeSnapshot(event?.snapshot);
          if (snapshot) {
            setValue(snapshot);
            setError(null);
          }
        })
        .catch((nextError) => {
          if (!cancelled) {
            const message = nextError instanceof Error ? nextError.message : String(nextError);
            setError(message);
          }
        });

      return () => {
        cancelled = true;
        void listenerHandle?.remove();
      };
    }

    const handleNativeAudioSessionEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }
      const detail = event.detail as NativeAudioSessionEventDetail | undefined;
      if (!detail || typeof detail !== "object") {
        return;
      }
      if (detail.type === "status") {
        setValue(normalizeSnapshot(detail.snapshot));
        setError(null);
        return;
      }
      if (detail.type === "error") {
        setError(detail.message);
      }
    };

    window.addEventListener(NATIVE_AUDIO_SESSION_EVENT, handleNativeAudioSessionEvent as EventListener);
    bridge?.postMessage({ type: "refresh" });
    return () => {
      window.removeEventListener(NATIVE_AUDIO_SESSION_EVENT, handleNativeAudioSessionEvent as EventListener);
    };
  }, [bridge, nativeAndroidAudioSessionPlugin, supported]);

  return {
    supported,
    value,
    error,
  };
}
