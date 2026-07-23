export type HostedVoiceAutoStopConfig = {
  sampleIntervalMs: number;
  speechStartThreshold: number;
  speechContinueThreshold: number;
  silenceDurationMs: number;
  minSpeechDurationMs: number;
  maxDurationMs: number;
  noSpeechTimeoutMs: number;
};

export type HostedVoiceAutoStopConfigInput =
  | boolean
  | Partial<Omit<HostedVoiceAutoStopConfig, "sampleIntervalMs">> & {
      sampleIntervalMs?: number;
    };

export type HostedVoiceAutoStopState = {
  startedAtMs: number;
  speechDetectedAtMs: number | null;
  lastSpeechAtMs: number | null;
};

export type HostedVoiceAutoStopDecision = {
  action: "continue" | "stop" | "cancel";
  reason: "silence" | "max-duration" | "no-speech" | null;
  state: HostedVoiceAutoStopState;
};

export const DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG: HostedVoiceAutoStopConfig = {
  sampleIntervalMs: 160,
  speechStartThreshold: 0.028,
  speechContinueThreshold: 0.02,
  silenceDurationMs: 1300,
  minSpeechDurationMs: 350,
  maxDurationMs: 30_000,
  noSpeechTimeoutMs: 10_000,
};

function normalizePositiveNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveHostedVoiceAutoStopConfig(
  input?: HostedVoiceAutoStopConfigInput | null,
): HostedVoiceAutoStopConfig | null {
  if (!input) {
    return null;
  }
  if (input === true) {
    return { ...DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG };
  }
  return {
    sampleIntervalMs: normalizePositiveNumber(
      input.sampleIntervalMs,
      DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG.sampleIntervalMs,
    ),
    speechStartThreshold: normalizePositiveNumber(
      input.speechStartThreshold,
      DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG.speechStartThreshold,
    ),
    speechContinueThreshold: normalizePositiveNumber(
      input.speechContinueThreshold,
      DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG.speechContinueThreshold,
    ),
    silenceDurationMs: normalizePositiveNumber(
      input.silenceDurationMs,
      DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG.silenceDurationMs,
    ),
    minSpeechDurationMs: normalizePositiveNumber(
      input.minSpeechDurationMs,
      DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG.minSpeechDurationMs,
    ),
    maxDurationMs: normalizePositiveNumber(
      input.maxDurationMs,
      DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG.maxDurationMs,
    ),
    noSpeechTimeoutMs: normalizePositiveNumber(
      input.noSpeechTimeoutMs,
      DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG.noSpeechTimeoutMs,
    ),
  };
}

export function createHostedVoiceAutoStopState(startedAtMs: number): HostedVoiceAutoStopState {
  return {
    startedAtMs,
    speechDetectedAtMs: null,
    lastSpeechAtMs: null,
  };
}

export function measureHostedVoiceAutoStopLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centered = (samples[index] - 128) / 128;
    total += centered * centered;
  }
  return Math.sqrt(total / samples.length);
}

export function advanceHostedVoiceAutoStopState(
  state: HostedVoiceAutoStopState,
  options: {
    nowMs: number;
    level: number;
    config: HostedVoiceAutoStopConfig;
  },
): HostedVoiceAutoStopDecision {
  const threshold =
    state.speechDetectedAtMs === null
      ? options.config.speechStartThreshold
      : options.config.speechContinueThreshold;
  const speechDetected = options.level >= threshold;
  const nextState: HostedVoiceAutoStopState = {
    ...state,
    speechDetectedAtMs:
      speechDetected && state.speechDetectedAtMs === null
        ? options.nowMs
        : state.speechDetectedAtMs,
    lastSpeechAtMs: speechDetected ? options.nowMs : state.lastSpeechAtMs,
  };

  if (nextState.speechDetectedAtMs === null) {
    if (options.nowMs - state.startedAtMs >= options.config.noSpeechTimeoutMs) {
      return {
        action: "cancel",
        reason: "no-speech",
        state: nextState,
      };
    }
    return {
      action: "continue",
      reason: null,
      state: nextState,
    };
  }

  if (options.nowMs - state.startedAtMs >= options.config.maxDurationMs) {
    return {
      action: "stop",
      reason: "max-duration",
      state: nextState,
    };
  }

  if (
    nextState.lastSpeechAtMs !== null &&
    options.nowMs - nextState.lastSpeechAtMs >= options.config.silenceDurationMs &&
    options.nowMs - nextState.speechDetectedAtMs >= options.config.minSpeechDurationMs
  ) {
    return {
      action: "stop",
      reason: "silence",
      state: nextState,
    };
  }

  return {
    action: "continue",
    reason: null,
    state: nextState,
  };
}
