import { describe, expect, it } from "vitest";
import {
  selectVoiceTurnCaptureRoute,
  selectVoiceTurnState,
  shouldBypassVoiceTurnMicrophonePermission,
} from "../useVoiceTurnController";

describe("useVoiceTurnController helpers", () => {
  it("prefers provider capture in auto mode when hosted capture is preferred and available", () => {
    expect(
      selectVoiceTurnCaptureRoute({
        mode: "auto",
        hostedVoiceSupported: true,
        localVoiceSupported: true,
        preferHostedCapture: true,
      }),
    ).toEqual({
      useHostedVoiceCapture: true,
      voiceSupported: true,
      effectiveMode: "provider",
    });
  });

  it("falls back to device capture in auto mode when hosted capture is unavailable", () => {
    expect(
      selectVoiceTurnCaptureRoute({
        mode: "auto",
        hostedVoiceSupported: false,
        localVoiceSupported: true,
        preferHostedCapture: true,
      }),
    ).toEqual({
      useHostedVoiceCapture: false,
      voiceSupported: true,
      effectiveMode: "device",
    });
  });

  it("keeps provider capture selected while a hosted turn is locked", () => {
    expect(
      selectVoiceTurnCaptureRoute({
        mode: "auto",
        hostedVoiceSupported: false,
        localVoiceSupported: true,
        preferHostedCapture: false,
        hostedTurnLocked: true,
      }),
    ).toEqual({
      useHostedVoiceCapture: true,
      voiceSupported: true,
      effectiveMode: "provider",
    });
  });

  it("derives transcribing above other voice states", () => {
    expect(
      selectVoiceTurnState({
        starting: true,
        listening: true,
        transcribing: true,
      }),
    ).toBe("transcribing");
  });

  it("bypasses microphone permission for hosted ui-test capture", () => {
    expect(
      shouldBypassVoiceTurnMicrophonePermission({
        useHostedVoiceCapture: true,
        hostedTestCaptureConfigured: true,
      }),
    ).toBe(true);
    expect(
      shouldBypassVoiceTurnMicrophonePermission({
        useHostedVoiceCapture: true,
        hostedTestCaptureConfigured: false,
      }),
    ).toBe(false);
    expect(
      shouldBypassVoiceTurnMicrophonePermission({
        useHostedVoiceCapture: false,
        hostedTestCaptureConfigured: true,
      }),
    ).toBe(false);
  });
});
