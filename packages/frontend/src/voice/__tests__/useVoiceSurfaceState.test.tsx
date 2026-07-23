// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostAudioDiagnostics } from "../../audio/audioSessionDiagnostics";
import { useVoiceSurfaceState } from "../useVoiceSurfaceState";

type HarnessValue = ReturnType<typeof useVoiceSurfaceState>;

const BASE_DIAGNOSTICS: HostAudioDiagnostics = {
  platform: "web",
  nativePlatform: false,
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
    outputCount: 1,
    bluetoothLikeOutputLabels: [],
    preferredOutputLabel: "MacBook Pro Speakers",
    inputs: [],
    outputs: [],
  },
};

function Harness(props: {
  diagnostics?: HostAudioDiagnostics | null;
  onValue: (value: HarnessValue) => void;
  replyEnabled?: boolean;
  replyContent?: string | null;
  replyBackend?: "provider" | "http" | "browser" | "none" | null;
  replyBackendLabel?: string | null;
  backendKind?: "provider" | "http" | "none";
}) {
  const value = useVoiceSurfaceState({
    route: props.backendKind === "none" ? "device" : "provider",
    capture: props.backendKind === "none" ? "device" : "hosted",
    state: "idle",
    supported: true,
    transcriptionBackend: {
      kind: props.backendKind ?? "provider",
      label: props.backendKind === "http" ? "Hosted HTTP backend" : "Speech tunnel",
      providerId: null,
    },
    speechMode: "provider",
    interactionMode: "voice_conversation",
    speechDependencyStatus: {
      localService: {
        health: {
          configured: true,
          reachable: true,
          url: "https://speech.example.com/health",
          detail: "Speech provider is ready.",
        },
      },
      transcription: {
        configured: true,
        ready: true,
      },
      synthesis: {
        configured: true,
        ready: true,
      },
    },
    hostAudioDiagnostics: props.diagnostics ?? BASE_DIAGNOSTICS,
    currentError: null,
    voiceRepliesEnabled: props.replyEnabled ?? true,
    latestReplyContent: props.replyContent ?? null,
    replyPlaybackLastBackend: props.replyBackend ?? null,
    replyPlaybackLastBackendLabel: props.replyBackendLabel ?? null,
  });
  props.onValue(value);
  return null;
}

describe("useVoiceSurfaceState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HarnessValue | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("derives shared route, host-audio, hands-free, and reply summaries for provider-backed voice surfaces", async () => {
    await act(async () => {
      root.render(
        <Harness
          replyBackend="browser"
          replyContent="The voice surface is ready."
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latestValue?.speechRouteSummary.badgeLabel).toBe("Provider via tunnel");
    expect(latestValue?.speechProviderSummary.route).toBe("tunnel");
    expect(latestValue?.replyPlaybackSummaryLabel).toBe("This device");
    expect(latestValue?.handsFreeAvailability.label).toBe("Foreground only");
    expect(latestValue?.hostAudioSummary).toContain("Mic permission granted");
    expect(latestValue?.voiceDebugState.providerReachable).toBe(true);
  });

  it("falls back to device summary labels when hosted speech is unavailable or replies are off", async () => {
    await act(async () => {
      root.render(
        <Harness
          backendKind="none"
          replyEnabled={false}
          diagnostics={{
            ...BASE_DIAGNOSTICS,
            capture: {
              ...BASE_DIAGNOSTICS.capture,
              microphonePermission: "denied",
            },
          }}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latestValue?.speechRouteSummary.badgeLabel).toBe("Fallback to device");
    expect(latestValue?.replyPlaybackSummaryLabel).toBe("Off");
    expect(latestValue?.handsFreeAvailability.label).toBe("Needs microphone access");
  });
});
