// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectSpeechCapabilityState } from "../useProjectSpeechCapabilityState";

const { readSpeechDependencyStatusMock, readSpeechVoiceOptionsMock } = vi.hoisted(() => ({
  readSpeechDependencyStatusMock: vi.fn(),
  readSpeechVoiceOptionsMock: vi.fn(),
}));

vi.mock("../speechService", async () => {
  const actual = await vi.importActual<typeof import("../speechService")>("../speechService");
  return {
    ...actual,
    readSpeechDependencyStatus: readSpeechDependencyStatusMock,
    readSpeechVoiceOptions: readSpeechVoiceOptionsMock,
  };
});

type HarnessValue = ReturnType<typeof useProjectSpeechCapabilityState>;

function Harness(props: {
  enabled: boolean;
  providerVoiceId?: string | null;
  deviceVoiceId?: string | null;
  onValue: (value: HarnessValue) => void;
}) {
  const value = useProjectSpeechCapabilityState({
    projectId: "project-123",
    enabled: props.enabled,
    providerVoiceId: props.providerVoiceId ?? null,
    deviceVoiceId: props.deviceVoiceId ?? null,
  });
  props.onValue(value);
  return null;
}

describe("useProjectSpeechCapabilityState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HarnessValue | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
    readSpeechDependencyStatusMock.mockReset();
    readSpeechVoiceOptionsMock.mockReset();
    readSpeechDependencyStatusMock.mockResolvedValue({
      provider: { id: "speech", title: "Speech" },
      value: null,
    });
    readSpeechVoiceOptionsMock.mockResolvedValue({
      provider: { id: "speech", title: "Speech" },
      providerVoices: [],
      browserVoices: [],
      providerDefaultVoiceId: null,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("derives shared speech readiness and selected voice summaries from shared capability state", async () => {
    readSpeechDependencyStatusMock.mockResolvedValue({
      provider: { id: "speech", title: "Speech" },
      value: {
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
          engine: "Provider STT",
          model: "base",
        },
        synthesis: {
          configured: true,
          ready: true,
          engine: "Provider TTS",
          defaultVoice: "alloy",
        },
      },
    });
    readSpeechVoiceOptionsMock.mockResolvedValue({
      provider: { id: "speech", title: "Speech" },
      providerVoices: [
        {
          id: "alloy",
          label: "Alloy",
          language: "en-US",
          source: "provider",
          isDefault: true,
        },
      ],
      browserVoices: [
        {
          id: "Samantha",
          label: "Samantha",
          language: "en-US",
          source: "browser",
          isDefault: true,
        },
      ],
      providerDefaultVoiceId: "alloy",
    });

    await act(async () => {
      root.render(
        <Harness
          enabled
          providerVoiceId="alloy"
          deviceVoiceId="Samantha"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestValue?.connectionSummary.badgeLabel).toBe("Provider via tunnel");
    expect(latestValue?.routeLabel).toBe("Provider through tunnel");
    expect(latestValue?.providerDefaultVoiceId).toBe("alloy");
    expect(latestValue?.selectedProviderVoice?.label).toBe("Alloy");
    expect(latestValue?.selectedDeviceVoice?.label).toBe("Samantha");
  });

  it("stays empty and skips loading when shared speech capabilities are disabled", async () => {
    await act(async () => {
      root.render(
        <Harness
          enabled={false}
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(readSpeechDependencyStatusMock).not.toHaveBeenCalled();
    expect(readSpeechVoiceOptionsMock).not.toHaveBeenCalled();
    expect(latestValue?.speechDependencyStatus).toBeNull();
    expect(latestValue?.providerSpeechVoices).toEqual([]);
    expect(latestValue?.browserSpeechVoices).toEqual([]);
    expect(latestValue?.connectionSummary.badgeLabel).toBe("Provider unavailable");
  });
});
