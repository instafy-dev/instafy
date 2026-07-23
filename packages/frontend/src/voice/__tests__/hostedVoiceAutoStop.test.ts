import { describe, expect, it } from "vitest";
import {
  advanceHostedVoiceAutoStopState,
  createHostedVoiceAutoStopState,
  measureHostedVoiceAutoStopLevel,
  resolveHostedVoiceAutoStopConfig,
  DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG,
} from "../hostedVoiceAutoStop";

describe("hostedVoiceAutoStop", () => {
  it("merges boolean enablement into the default config", () => {
    expect(resolveHostedVoiceAutoStopConfig(true)).toEqual(
      DEFAULT_HOSTED_VOICE_AUTO_STOP_CONFIG,
    );
    expect(resolveHostedVoiceAutoStopConfig(false)).toBeNull();
  });

  it("measures a louder waveform above silence", () => {
    const quiet = new Uint8Array([128, 129, 127, 128]);
    const loud = new Uint8Array([128, 188, 72, 196, 60]);
    expect(measureHostedVoiceAutoStopLevel(quiet)).toBeLessThan(
      measureHostedVoiceAutoStopLevel(loud),
    );
  });

  it("waits for speech before considering silence stop", () => {
    const config = resolveHostedVoiceAutoStopConfig({
      noSpeechTimeoutMs: 10_000,
      silenceDurationMs: 800,
      minSpeechDurationMs: 200,
    });
    expect(config).not.toBeNull();
    const initial = createHostedVoiceAutoStopState(0);
    expect(
      advanceHostedVoiceAutoStopState(initial, {
        nowMs: 1_000,
        level: 0.01,
        config: config!,
      }),
    ).toMatchObject({
      action: "continue",
      reason: null,
    });
  });

  it("stops after silence following detected speech", () => {
    const config = resolveHostedVoiceAutoStopConfig({
      silenceDurationMs: 900,
      minSpeechDurationMs: 200,
      noSpeechTimeoutMs: 10_000,
    });
    expect(config).not.toBeNull();
    const afterSpeech = advanceHostedVoiceAutoStopState(createHostedVoiceAutoStopState(0), {
      nowMs: 100,
      level: 0.05,
      config: config!,
    }).state;

    expect(
      advanceHostedVoiceAutoStopState(afterSpeech, {
        nowMs: 1_200,
        level: 0.005,
        config: config!,
      }),
    ).toMatchObject({
      action: "stop",
      reason: "silence",
    });
  });

  it("cancels after a long no-speech timeout", () => {
    const config = resolveHostedVoiceAutoStopConfig({
      noSpeechTimeoutMs: 2_000,
    });
    expect(config).not.toBeNull();
    expect(
      advanceHostedVoiceAutoStopState(createHostedVoiceAutoStopState(0), {
        nowMs: 2_100,
        level: 0.0,
        config: config!,
      }),
    ).toMatchObject({
      action: "cancel",
      reason: "no-speech",
    });
  });
});
