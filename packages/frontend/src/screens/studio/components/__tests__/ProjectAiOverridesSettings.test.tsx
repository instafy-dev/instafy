/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  createProviderSummary,
  createProviderUiSurfaceMetadata,
  createProviderUiSurfacePolicy,
} from "@instafy/provider-contract";
import type { ProviderSettingsSurfaceEntry } from "../../../../providers/providerSettingsSurfaces";
import {
  ProjectAiOverridesSettings,
  listProjectAiOverrideItems,
} from "../ProjectAiOverridesSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createProviderEntry(
  overrides: Partial<ProviderSettingsSurfaceEntry> = {},
): ProviderSettingsSurfaceEntry {
  return {
    key: "speech:settings_card",
    familyId: "speech",
    providerId: "speech",
    entry: {
      familyId: "speech",
      provider: createProviderSummary({
        id: "speech",
        title: "Speech",
        description: "Speech provider",
        providerType: "speech",
        capabilityIds: ["speech_transcription", "speech_synthesis"],
        manifest: {
          familyId: "speech",
        },
      }),
      surface: {
        surface: "settings_card",
        title: "Speech provider settings",
        description: "Configure speech for this space.",
        metadata: createProviderUiSurfaceMetadata({
          policy: createProviderUiSurfacePolicy({
            trustLevel: "first_party",
            renderMode: "host_declarative",
          }),
          elements: [
            {
              element: "controls",
              controls: [
                {
                  kind: "select",
                  label: "Speech route",
                  value: "auto",
                  options: [
                    {
                      value: "auto",
                      label: "Auto",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
    },
    ...overrides,
  };
}

function renderProjectAiOverridesSettings(
  selectedItemId: string | null,
  providerSettingsSurfaceEntries: ProviderSettingsSurfaceEntry[] = [createProviderEntry()],
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(
      <ProjectAiOverridesSettings
        selectedItemId={selectedItemId}
        speechDependencyStatus={null}
        speechPreferenceSource="default"
        providerSettingsSurfaceEntries={providerSettingsSurfaceEntries}
        hostAudioDiagnostics={null}
        hostAudioSessionState={null}
        onRequestMicrophonePermission={null}
      />,
    );
  });

  return {
    container,
    cleanup() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("ProjectAiOverridesSettings", () => {
  it("lists only provider and audio items for the shell child navigation", () => {
    const items = listProjectAiOverrideItems({
      providerSettingsSurfaceEntries: [createProviderEntry()],
      speechDependencyStatus: null,
      speechPreferenceSource: "default",
      hostAudioDiagnostics: null,
      hostAudioSessionState: null,
      hostAudioDiagnosticsLoading: false,
      hostAudioDiagnosticsError: null,
    });

    expect(items.map((item) => item.id)).toEqual(["provider:speech", "audio"]);
    expect(items.find((item) => item.label === "AI manager")).toBeUndefined();
    expect(items.find((item) => item.label === "Voice chat beta")).toBeUndefined();
  });

  it("renders the selected provider detail", () => {
    const view = renderProjectAiOverridesSettings("provider:speech");

    expect(
      view.container.querySelector('[data-testid="project-ai-overrides-provider-detail-speech"]'),
    ).toBeTruthy();
    expect(view.container.textContent).toContain("Speech route");
    view.cleanup();
  });

  it("prefers the provider settings surface over the provider status surface in detail view", () => {
    const view = renderProjectAiOverridesSettings("provider:speech", [
      createProviderEntry(),
      createProviderEntry({
        key: "speech:status_card",
        entry: {
          familyId: "speech",
          provider: createProviderSummary({
            id: "speech",
            title: "Speech",
            description: "Speech provider",
            providerType: "speech",
            capabilityIds: ["speech_transcription", "speech_synthesis"],
            manifest: {
              familyId: "speech",
            },
          }),
          surface: {
            surface: "status_card",
            title: "Speech provider status",
            description: "Current speech readiness.",
          },
        },
      }),
    ]);

    expect(view.container.textContent).toContain("Speech route");
    expect(view.container.textContent).not.toContain("Speech provider status");
    view.cleanup();
  });

  it("renders the selected host audio detail", () => {
    const view = renderProjectAiOverridesSettings("audio");

    expect(view.container.querySelector('[data-testid="project-ai-overrides-audio-detail"]')).toBeTruthy();
    view.cleanup();
  });
});
