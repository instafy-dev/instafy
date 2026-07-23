import { useEffect, useMemo } from "react";
import type { VoiceTurnEffectiveMode, VoiceTurnMode, VoiceTurnState } from "./useVoiceTurnController";

export type VoiceDebugCapture = "hosted" | "device";
export type VoiceDebugScope = "featureRuntime" | "chatComposer";

export type VoiceDebugState = {
  route: VoiceTurnEffectiveMode;
  capture: VoiceDebugCapture;
  state: VoiceTurnState;
  supported: boolean;
  transcriptionBackendLabel: string | null;
  mode: VoiceTurnMode | null;
  interactionMode: string | null;
  providerReachable: boolean | null;
  lastError: string | null;
};

export type VoiceDebugSnapshot = VoiceDebugState & {
  at: number;
};

export type VoiceDebugEvent = {
  type: string;
  at: number;
  detail?: string | null;
};

type VoiceDebugWindow = Window & {
  __INSTAFY_FEATURE_VOICE_DEBUG__?: VoiceDebugState;
  __INSTAFY_FEATURE_VOICE_DEBUG_HISTORY__?: VoiceDebugSnapshot[];
  __INSTAFY_FEATURE_VOICE_DEBUG_EVENTS__?: VoiceDebugEvent[];
  __CHAT_VOICE_DEBUG__?: VoiceDebugState;
  __CHAT_VOICE_DEBUG_HISTORY__?: VoiceDebugSnapshot[];
  __CHAT_VOICE_DEBUG_EVENTS__?: VoiceDebugEvent[];
};

function getVoiceDebugKeys(scope: VoiceDebugScope) {
  if (scope === "featureRuntime") {
    return {
      latest: "__INSTAFY_FEATURE_VOICE_DEBUG__" as const,
      history: "__INSTAFY_FEATURE_VOICE_DEBUG_HISTORY__" as const,
      events: "__INSTAFY_FEATURE_VOICE_DEBUG_EVENTS__" as const,
    };
  }
  return {
    latest: "__CHAT_VOICE_DEBUG__" as const,
    history: "__CHAT_VOICE_DEBUG_HISTORY__" as const,
    events: "__CHAT_VOICE_DEBUG_EVENTS__" as const,
  };
}

export function buildVoiceDebugState(input: {
  route: VoiceTurnEffectiveMode;
  capture: VoiceDebugCapture;
  state: VoiceTurnState;
  supported: boolean;
  transcriptionBackendLabel?: string | null;
  mode?: VoiceTurnMode | null;
  interactionMode?: string | null;
  providerReachable?: boolean | null;
  lastError?: string | null;
}): VoiceDebugState {
  return {
    route: input.route,
    capture: input.capture,
    state: input.state,
    supported: input.supported,
    transcriptionBackendLabel: input.transcriptionBackendLabel ?? null,
    mode: input.mode ?? null,
    interactionMode: input.interactionMode ?? null,
    providerReachable: input.providerReachable ?? null,
    lastError: input.lastError ?? null,
  };
}

export function useVoiceDebugState(input: {
  route: VoiceTurnEffectiveMode;
  capture: VoiceDebugCapture;
  state: VoiceTurnState;
  supported: boolean;
  transcriptionBackendLabel?: string | null;
  mode?: VoiceTurnMode | null;
  interactionMode?: string | null;
  providerReachable?: boolean | null;
  lastError?: string | null;
}) {
  return useMemo(
    () => buildVoiceDebugState(input),
    [input],
  );
}

export function usePublishVoiceDebugState(scope: VoiceDebugScope, state: VoiceDebugState) {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const runtimeWindow = window as VoiceDebugWindow;
    const keys = getVoiceDebugKeys(scope);
    runtimeWindow[keys.latest] = state;
    runtimeWindow[keys.history] = [
      ...(runtimeWindow[keys.history] ?? []).slice(-23),
      {
        ...state,
        at: Date.now(),
      },
    ];
  }, [scope, state]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const runtimeWindow = window as VoiceDebugWindow;
    const keys = getVoiceDebugKeys(scope);
    return () => {
      delete runtimeWindow[keys.latest];
      delete runtimeWindow[keys.history];
      delete runtimeWindow[keys.events];
    };
  }, [scope]);
}

export function appendVoiceDebugEvent(scope: VoiceDebugScope, type: string, detail?: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  const runtimeWindow = window as VoiceDebugWindow;
  const keys = getVoiceDebugKeys(scope);
  runtimeWindow[keys.events] = [
    ...(runtimeWindow[keys.events] ?? []).slice(-31),
    {
      type,
      at: Date.now(),
      detail: detail ?? null,
    },
  ];
}
