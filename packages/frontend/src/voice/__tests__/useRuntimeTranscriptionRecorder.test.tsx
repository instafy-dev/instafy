// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeTranscriptionRecorder } from "../useRuntimeTranscriptionRecorder";

const {
  resolveSpeechTranscriptionBackendMock,
  transcribeAudioWithSpeechServiceMock,
  getRuntimeTranscriptionBackendConfigMock,
  subscribeDesktopLanDiscoverySnapshotsMock,
} = vi.hoisted(() => ({
  resolveSpeechTranscriptionBackendMock: vi.fn(),
  transcribeAudioWithSpeechServiceMock: vi.fn(),
  getRuntimeTranscriptionBackendConfigMock: vi.fn(),
  subscribeDesktopLanDiscoverySnapshotsMock: vi.fn(),
}));

vi.mock("../speechService", () => ({
  resolveSpeechTranscriptionBackend: resolveSpeechTranscriptionBackendMock,
  transcribeAudioWithSpeechService: transcribeAudioWithSpeechServiceMock,
}));

vi.mock("../desktopLanDiscovery", () => ({
  subscribeDesktopLanDiscoverySnapshots: subscribeDesktopLanDiscoverySnapshotsMock,
}));

vi.mock("../runtimeTranscriptionClient", async () => {
  const actual = await vi.importActual<typeof import("../runtimeTranscriptionClient")>(
    "../runtimeTranscriptionClient",
  );
  return {
    ...actual,
    getRuntimeTranscriptionBackendConfig: getRuntimeTranscriptionBackendConfigMock,
  };
});

type HarnessValue = ReturnType<typeof useRuntimeTranscriptionRecorder>;

function Harness(props: {
  onValue: (value: HarnessValue) => void;
  resolveBackend?: boolean;
}) {
  const value = useRuntimeTranscriptionRecorder({
    resolveBackend: props.resolveBackend,
  });
  props.onValue(value);
  return null;
}

describe("useRuntimeTranscriptionRecorder", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HarnessValue | null;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
    resolveSpeechTranscriptionBackendMock.mockReset();
    transcribeAudioWithSpeechServiceMock.mockReset();
    getRuntimeTranscriptionBackendConfigMock.mockReset();
    subscribeDesktopLanDiscoverySnapshotsMock.mockReset();
    subscribeDesktopLanDiscoverySnapshotsMock.mockReturnValue(() => {});
    getRuntimeTranscriptionBackendConfigMock.mockReturnValue({
      url: "https://speech.example.com/transcribe",
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
      },
    });
    class MockMediaRecorder {
      static isTypeSupported() {
        return true;
      }
    }
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("retries backend discovery until a provider becomes available", async () => {
    resolveSpeechTranscriptionBackendMock
      .mockResolvedValueOnce({
        kind: "none",
        label: null,
        providerId: null,
      })
      .mockResolvedValueOnce({
        kind: "provider",
        label: "Speech Tunnel",
        providerId: "speech",
      });

    await act(async () => {
      root.render(
        <Harness
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latestValue?.backend.kind).toBe("none");
    expect(latestValue?.supported).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolveSpeechTranscriptionBackendMock).toHaveBeenCalledTimes(2);
    expect(latestValue?.backend.kind).toBe("provider");
    expect(latestValue?.backend.label).toBe("Speech Tunnel");
    expect(latestValue?.supported).toBe(true);
  });

  it("skips backend discovery when hosted resolution is disabled", async () => {
    await act(async () => {
      root.render(
        <Harness
          resolveBackend={false}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(resolveSpeechTranscriptionBackendMock).not.toHaveBeenCalled();
    expect(latestValue?.backend.kind).toBe("none");
    expect(latestValue?.backendResolutionStatus).toBe("ready");
    expect(latestValue?.supported).toBe(false);
  });

  it("re-resolves hosted backend when LAN discovery publishes an update", async () => {
    let discoveryListener: ((snapshot?: Record<string, unknown> | null) => void) | null = null;
    subscribeDesktopLanDiscoverySnapshotsMock.mockImplementation(
      (listener: (snapshot?: Record<string, unknown> | null) => void) => {
        discoveryListener = listener;
        return () => {
          discoveryListener = null;
        };
      },
    );
    resolveSpeechTranscriptionBackendMock
      .mockResolvedValueOnce({
        kind: "none",
        label: null,
        providerId: null,
      })
      .mockResolvedValueOnce({
        kind: "http",
        label: "Desktop LAN",
        providerId: null,
      });

    await act(async () => {
      root.render(
        <Harness
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latestValue?.backend.kind).toBe("none");
    expect(resolveSpeechTranscriptionBackendMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      discoveryListener?.({
        state: "scanning",
        services: [],
        lastError: null,
        updatedAt: "2026-04-14T12:00:00.000Z",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolveSpeechTranscriptionBackendMock).toHaveBeenCalledTimes(2);
    expect(latestValue?.backend.kind).toBe("http");
    expect(latestValue?.backend.label).toBe("Desktop LAN");
    expect(latestValue?.supported).toBe(true);
  });

  it("uses an explicit hosted test transcript override when configured", async () => {
    resolveSpeechTranscriptionBackendMock.mockResolvedValue({
      kind: "provider",
      label: "Desktop Speech",
      providerId: "speech",
    });

    await act(async () => {
      root.render(
        <Harness
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const runtimeWindow = window as Window & {
      __INSTAFY_HOSTED_VOICE_CAPTURE_TEST__?: {
        configure: (options: {
          audioDataUrl: string;
          transcriptText?: string;
        }) => Promise<boolean>;
      };
    };

    expect(runtimeWindow.__INSTAFY_HOSTED_VOICE_CAPTURE_TEST__).toBeDefined();

    await act(async () => {
      await runtimeWindow.__INSTAFY_HOSTED_VOICE_CAPTURE_TEST__?.configure({
        audioDataUrl: "data:audio/wav;base64,UklGRg==",
        transcriptText: "Tunnel voice status amber delta",
      });
    });

    await act(async () => {
      expect(await latestValue?.start()).toBe(true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    let transcript = "";
    await act(async () => {
      transcript = (await latestValue?.stopAndTranscribe()) ?? "";
    });

    expect(transcript).toBe("Tunnel voice status amber delta");
    expect(latestValue?.completedTranscript).toBe("Tunnel voice status amber delta");
    expect(transcribeAudioWithSpeechServiceMock).not.toHaveBeenCalled();
  });

  it("treats an explicit hosted test capture as supported before backend resolution is ready", async () => {
    resolveSpeechTranscriptionBackendMock.mockResolvedValue({
      kind: "none",
      label: null,
      providerId: null,
    });

    await act(async () => {
      root.render(
        <Harness
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestValue?.backend.kind).toBe("none");
    expect(latestValue?.supported).toBe(false);

    const runtimeWindow = window as Window & {
      __INSTAFY_HOSTED_VOICE_CAPTURE_TEST__?: {
        configure: (options: {
          audioDataUrl: string;
          transcriptText?: string;
        }) => Promise<boolean>;
      };
    };

    await act(async () => {
      await runtimeWindow.__INSTAFY_HOSTED_VOICE_CAPTURE_TEST__?.configure({
        audioDataUrl: "data:audio/wav;base64,UklGRg==",
        transcriptText: "Hosted transcript override",
      });
    });

    expect(latestValue?.supported).toBe(true);

    await act(async () => {
      expect(await latestValue?.start()).toBe(true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    let transcript = "";
    await act(async () => {
      transcript = (await latestValue?.stopAndTranscribe()) ?? "";
    });

    expect(transcript).toBe("Hosted transcript override");
    expect(latestValue?.completedTranscript).toBe("Hosted transcript override");
  });
});
