import { describe, expect, it } from "vitest";
import {
  deriveHostAudioSessionState,
  describeHostAudioSessionState,
  deriveHostHandsFreeVoiceAvailability,
} from "../hostAudioSessionState";
import type { HostAudioDiagnostics } from "../audioSessionDiagnostics";

function createDiagnostics(): HostAudioDiagnostics {
  return {
    platform: "ios",
    nativePlatform: true,
    nativeSession: null,
    capture: {
      getUserMedia: true,
      mediaRecorder: true,
      speechRecognition: false,
      microphonePermission: "granted",
    },
    playback: {
      htmlAudio: true,
      speechSynthesis: true,
      outputDeviceSelection: false,
    },
    devices: {
      enumerateSupported: true,
      labelsVisible: true,
      inputCount: 1,
      outputCount: 2,
      bluetoothLikeOutputLabels: ["Taylor’s AirPods Pro"],
      preferredOutputLabel: "Taylor’s AirPods Pro",
      inputs: [],
      outputs: [],
    },
  };
}

describe("hostAudioSessionState", () => {
  it("prefers a bluetooth route when a headset-like output is visible", () => {
    const session = deriveHostAudioSessionState({
      diagnostics: createDiagnostics(),
      voiceState: "listening",
      foreground: true,
      focused: true,
    });

    expect(session.routeKind).toBe("bluetooth");
    expect(session.phase).toBe("recording");
    expect(session.recommendedPlaybackRoute).toBe("bluetooth");
  });

  it("warns when native mobile audio is active without a bluetooth route", () => {
    const diagnostics = createDiagnostics();
    diagnostics.devices.bluetoothLikeOutputLabels = [];
    diagnostics.devices.preferredOutputLabel = "iPhone";

    const session = deriveHostAudioSessionState({
      diagnostics,
      voiceState: "starting",
      foreground: true,
      focused: true,
    });

    expect(session.phase).toBe("activating");
    expect(session.warnings).toContain("No Bluetooth-style headset route is visible right now.");
  });

  it("builds a readable host audio session description", () => {
    const description = describeHostAudioSessionState(
      deriveHostAudioSessionState({
        diagnostics: createDiagnostics(),
        voiceState: "transcribing",
        foreground: true,
        focused: true,
      }),
    );

    expect(description).toContain("Voice session transcribing");
    expect(description).toContain("Taylor’s AirPods Pro");
  });

  it("surfaces native interruptions and earpiece route warnings", () => {
    const diagnostics = createDiagnostics();
    diagnostics.nativeSession = {
      platform: "ios",
      appState: "active",
      microphonePermission: "granted",
      audioSessionActive: true,
      voiceCaptureActive: false,
      interrupted: true,
      interruptionReason: "system interruption began",
      routeChangeReason: "route override",
      inputLabels: ["iPhone Microphone"],
      outputLabels: ["iPhone Receiver"],
      preferredOutputLabel: "iPhone Receiver",
      bluetoothLikeOutputLabels: [],
      routeKind: "receiver",
      reason: "interruption",
      updatedAt: "2026-04-07T13:00:00.000Z",
    };
    diagnostics.devices.preferredOutputLabel = "iPhone Receiver";

    const session = deriveHostAudioSessionState({
      diagnostics,
      voiceState: "listening",
      foreground: true,
      focused: true,
    });

    expect(session.phase).toBe("interrupted");
    expect(session.recommendedPlaybackRoute).toBe("speaker");
    expect(session.warnings).toContain("Phone earpiece route is active. Switch to speaker or Bluetooth for spoken replies.");
    expect(session.warnings).toContain("Native audio session was interrupted: system interruption began.");
  });

  it("describes the current voice loop as foreground only when capture is ready", () => {
    const session = deriveHostAudioSessionState({
      diagnostics: createDiagnostics(),
      voiceState: "idle",
      foreground: true,
      focused: true,
    });

    expect(
      deriveHostHandsFreeVoiceAvailability({
        diagnostics: createDiagnostics(),
        sessionState: session,
      }),
    ).toEqual({
      state: "foreground_only",
      label: "Foreground only",
      detail:
        "Hold, tap, and continuous voice work while Instafy stays open and awake. Background or wake-word capture is not implemented yet.",
    });
  });

  it("reports background pause when the app is no longer foregrounded", () => {
    const session = deriveHostAudioSessionState({
      diagnostics: createDiagnostics(),
      voiceState: "listening",
      foreground: false,
      focused: false,
    });

    expect(
      deriveHostHandsFreeVoiceAvailability({
        diagnostics: createDiagnostics(),
        sessionState: session,
      }),
    ).toEqual({
      state: "background_paused",
      label: "Paused in background",
      detail:
        "Current voice loops pause when Instafy leaves the foreground. Bring the app back and keep it awake to resume.",
    });
  });

  it("reports microphone access when capture is unavailable", () => {
    const diagnostics = createDiagnostics();
    diagnostics.capture.microphonePermission = "denied";
    const session = deriveHostAudioSessionState({
      diagnostics,
      voiceState: "idle",
      foreground: true,
      focused: true,
    });

    expect(
      deriveHostHandsFreeVoiceAvailability({
        diagnostics,
        sessionState: session,
      }),
    ).toEqual({
      state: "unavailable",
      label: "Needs microphone access",
      detail:
        "Grant microphone access before trying tap, continuous, or future hands-free voice modes.",
    });
  });
});
