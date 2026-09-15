import { describe, expect, it } from "vitest";
import {
  applyNativeHostAudioSessionSnapshot,
  describeHostAudioDiagnostics,
  isBluetoothLikeAudioLabel,
  selectPreferredAudioOutputLabel,
  type HostAudioDeviceSummary,
  type HostAudioDiagnostics,
} from "../audioSessionDiagnostics";
import type { NativeHostAudioSessionSnapshot } from "../nativeAudioSessionBridge";

describe("audioSessionDiagnostics", () => {
  it("detects bluetooth-like output labels", () => {
    expect(isBluetoothLikeAudioLabel("Taylor’s AirPods Pro")).toBe(true);
    expect(isBluetoothLikeAudioLabel("Bluetooth Headset")).toBe(true);
    expect(isBluetoothLikeAudioLabel("MacBook Pro Speakers")).toBe(false);
  });

  it("prefers bluetooth-like outputs when available", () => {
    const outputs: HostAudioDeviceSummary[] = [
      { id: "built-in", label: "MacBook Pro Speakers", kind: "output", bluetoothLike: false },
      { id: "airpods", label: "Taylor’s AirPods Pro", kind: "output", bluetoothLike: true },
    ];

    expect(selectPreferredAudioOutputLabel(outputs)).toBe("Taylor’s AirPods Pro");
  });

  it("builds a readable host audio summary", () => {
    const diagnostics: HostAudioDiagnostics = {
      platform: "ios",
      nativePlatform: true,
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

    expect(describeHostAudioDiagnostics(diagnostics)).toContain("Mic permission granted");
    expect(describeHostAudioDiagnostics(diagnostics)).toContain("Taylor’s AirPods Pro");
  });

  it("prefers native iOS route snapshots over browser device heuristics", () => {
    const diagnostics: HostAudioDiagnostics = {
      platform: "ios",
      nativePlatform: true,
      nativeSession: null,
      capture: {
        getUserMedia: true,
        mediaRecorder: true,
        speechRecognition: false,
        microphonePermission: "prompt",
      },
      playback: {
        htmlAudio: true,
        speechSynthesis: true,
        outputDeviceSelection: false,
      },
      devices: {
        enumerateSupported: true,
        labelsVisible: false,
        inputCount: 0,
        outputCount: 0,
        bluetoothLikeOutputLabels: [],
        preferredOutputLabel: null,
        inputs: [],
        outputs: [],
      },
    };
    const nativeSnapshot: NativeHostAudioSessionSnapshot = {
      platform: "ios",
      appState: "active",
      microphonePermission: "granted",
      audioSessionActive: true,
      voiceCaptureActive: true,
      interrupted: false,
      interruptionReason: null,
      routeChangeReason: "new device available",
      inputLabels: ["iPhone Microphone"],
      outputLabels: ["Taylor’s AirPods Pro"],
      preferredOutputLabel: "Taylor’s AirPods Pro",
      bluetoothLikeOutputLabels: ["Taylor’s AirPods Pro"],
      routeKind: "bluetooth",
      reason: "refresh",
      updatedAt: "2026-04-07T12:34:56.000Z",
    };

    const merged = applyNativeHostAudioSessionSnapshot(diagnostics, nativeSnapshot);

    expect(merged.capture.microphonePermission).toBe("granted");
    expect(merged.devices.preferredOutputLabel).toBe("Taylor’s AirPods Pro");
    expect(merged.devices.outputCount).toBe(1);
    expect(merged.nativeSession?.routeKind).toBe("bluetooth");
  });
});
