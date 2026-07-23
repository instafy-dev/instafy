import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AudioHostSettingsCard } from "../AudioHostSettingsCard";

describe("AudioHostSettingsCard", () => {
  it("renders the trimmed host-audio summary without redundant activation copy", () => {
    const html = renderToStaticMarkup(
      <AudioHostSettingsCard
        diagnostics={{
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
            outputCount: 2,
            bluetoothLikeOutputLabels: ["AirPods Pro"],
            preferredOutputLabel: "AirPods Pro",
            inputs: [],
            outputs: [],
          },
        }}
        sessionState={{
          phase: "recording",
          foreground: true,
          focused: true,
          audioSessionActive: true,
          voiceCaptureActive: true,
          interrupted: false,
          interruptionReason: null,
          routeChangeReason: null,
          routeKind: "bluetooth",
          preferredOutputLabel: "AirPods Pro",
          microphonePermission: "granted",
          captureReady: true,
          playbackReady: true,
          recommendedPlaybackRoute: "bluetooth",
          routeHint: "Likely headset route: AirPods Pro",
          warnings: ["Microphone permission is denied.", "This should not render."],
        }}
      />,
    );

    expect(html).toContain("Host audio");
    expect(html).toContain("Shared microphone, playback, and route readiness for this device.");
    expect(html).toContain("Microphone");
    expect(html).toContain("Output");
    expect(html).toContain("Audio session");
    expect(html).toContain("Route");
    expect(html).toContain("Capture");
    expect(html).toContain("Playback");
    expect(html).toContain("Recording");
    expect(html).toContain("Bluetooth headset");
    expect(html).toContain("Mic + recorder ready");
    expect(html).toContain("Speech playback ready");
    expect(html).toContain("Foreground only");
    expect(html).toContain("Voice works while Instafy stays open and awake.");
    expect(html).toContain("Microphone permission is denied.");
    expect(html).not.toContain("Session activation");
    expect(html).not.toContain("Native mobile audio session bridge is active");
    expect(html).not.toContain("This should not render.");
  });

  it("hides transport diagnostics when microphone access is still pending", () => {
    const html = renderToStaticMarkup(
      <AudioHostSettingsCard
        diagnostics={{
          platform: "web",
          nativePlatform: false,
          nativeSession: null,
          capture: {
            getUserMedia: false,
            mediaRecorder: false,
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
            inputCount: 1,
            outputCount: 1,
            bluetoothLikeOutputLabels: [],
            preferredOutputLabel: null,
            inputs: [],
            outputs: [],
          },
        }}
        sessionState={null}
      />,
    );

    expect(html).toContain("Microphone");
    expect(html).toContain("Voice status");
    expect(html).not.toContain("Route");
    expect(html).not.toContain("Capture");
    expect(html).not.toContain("Playback");
    expect(html).not.toContain("Audio device labels may stay hidden until media permission is granted.");
  });

  it("can render in embedded mode without repeating the outer host-audio header", () => {
    const html = renderToStaticMarkup(
      <AudioHostSettingsCard
        diagnostics={null}
        sessionState={null}
        presentation="embedded"
      />,
    );

    expect(html).toContain("Microphone");
    expect(html).toContain("Voice status");
    expect(html).not.toContain("Route");
    expect(html).not.toContain("Capture");
    expect(html).not.toContain("Playback");
    expect(html).not.toContain("Shared microphone, playback, and route readiness for this device.");
  });
});
