// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectSpeechPreferencesState } from "../useProjectSpeechPreferencesState";

const {
  readStoredProjectSpeechPreferencesMock,
  readProjectSpeechPreferencesMock,
  writeProjectSpeechPreferencesMock,
} = vi.hoisted(() => ({
  readStoredProjectSpeechPreferencesMock: vi.fn(),
  readProjectSpeechPreferencesMock: vi.fn(),
  writeProjectSpeechPreferencesMock: vi.fn(),
}));

vi.mock("../projectSpeechPreferences", async () => {
  const actual = await vi.importActual<typeof import("../projectSpeechPreferences")>(
    "../projectSpeechPreferences",
  );
  return {
    ...actual,
    readStoredProjectSpeechPreferences: readStoredProjectSpeechPreferencesMock,
    readProjectSpeechPreferences: readProjectSpeechPreferencesMock,
    writeProjectSpeechPreferences: writeProjectSpeechPreferencesMock,
  };
});

type HarnessValue = ReturnType<typeof useProjectSpeechPreferencesState>;

function Harness(props: {
  projectId?: string | null;
  onValue: (value: HarnessValue) => void;
}) {
  const value = useProjectSpeechPreferencesState(props.projectId ?? null);
  props.onValue(value);
  return null;
}

describe("useProjectSpeechPreferencesState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HarnessValue | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
    readStoredProjectSpeechPreferencesMock.mockReset();
    readProjectSpeechPreferencesMock.mockReset();
    writeProjectSpeechPreferencesMock.mockReset();
    readStoredProjectSpeechPreferencesMock.mockReturnValue({
      mode: "auto",
      providerVoiceId: null,
      deviceVoiceId: null,
      updatedAt: null,
      source: "default",
    });
    readProjectSpeechPreferencesMock.mockResolvedValue({
      mode: "auto",
      providerVoiceId: null,
      deviceVoiceId: null,
      updatedAt: null,
      source: "default",
    });
    writeProjectSpeechPreferencesMock.mockResolvedValue({
      success: true,
      scope: "project",
      source: "project",
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("loads stored speech preferences first, then applies project preferences", async () => {
    let resolveProjectPreferences: ((value: {
      mode: "provider";
      providerVoiceId: string;
      deviceVoiceId: null;
      updatedAt: string;
      source: "project";
    }) => void) | null = null;
    readStoredProjectSpeechPreferencesMock.mockReturnValue({
      mode: "device",
      providerVoiceId: null,
      deviceVoiceId: "Samantha",
      updatedAt: null,
      source: "local",
    });
    readProjectSpeechPreferencesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveProjectPreferences = resolve;
      }),
    );

    await act(async () => {
      root.render(
        <Harness
          projectId="project-123"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
    });

    expect(latestValue?.mode).toBe("device");
    expect(latestValue?.deviceVoiceId).toBe("Samantha");
    expect(latestValue?.source).toBe("local");

    await act(async () => {
      resolveProjectPreferences?.({
        mode: "provider",
        providerVoiceId: "alloy",
        deviceVoiceId: null,
        updatedAt: "2026-04-19T10:00:00.000Z",
        source: "project",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestValue?.mode).toBe("provider");
    expect(latestValue?.providerVoiceId).toBe("alloy");
    expect(latestValue?.deviceVoiceId).toBeNull();
    expect(latestValue?.source).toBe("project");
  });

  it("persists speech mode and voice selections through the shared mutation helpers", async () => {
    await act(async () => {
      root.render(
        <Harness
          projectId="project-123"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await latestValue?.setMode("provider");
      await latestValue?.setProviderVoiceId("alloy");
      await latestValue?.setDeviceVoiceId("Samantha");
    });

    expect(writeProjectSpeechPreferencesMock).toHaveBeenNthCalledWith(
      1,
      "project-123",
      {
        mode: "provider",
        providerVoiceId: null,
        deviceVoiceId: null,
      },
      window.localStorage,
    );
    expect(writeProjectSpeechPreferencesMock).toHaveBeenNthCalledWith(
      2,
      "project-123",
      {
        mode: "provider",
        providerVoiceId: "alloy",
        deviceVoiceId: null,
      },
      window.localStorage,
    );
    expect(writeProjectSpeechPreferencesMock).toHaveBeenNthCalledWith(
      3,
      "project-123",
      {
        mode: "provider",
        providerVoiceId: "alloy",
        deviceVoiceId: "Samantha",
      },
      window.localStorage,
    );
    expect(latestValue?.mode).toBe("provider");
    expect(latestValue?.providerVoiceId).toBe("alloy");
    expect(latestValue?.deviceVoiceId).toBe("Samantha");
    expect(latestValue?.source).toBe("project");
  });
});
