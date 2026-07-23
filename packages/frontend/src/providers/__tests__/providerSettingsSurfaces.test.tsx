import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createProviderSummary } from "@instafy/provider-contract";
import { ProviderShellSurface } from "../../screens/studio/components/ProviderShellSurface";
import type { ProviderSettingsSurfacesContext } from "../providerSettingsSurfaces";
import { listProviderSettingsSurfaceEntries } from "../providerSettingsSurfaces";

function createContext(
  overrides: Partial<ProviderSettingsSurfacesContext> = {},
): ProviderSettingsSurfacesContext {
  return {
    settingsProviders: [],
    speechDependencyStatus: null,
    desktopVoiceHostStatus: null,
    desktopVoiceHostLifecycle: null,
    desktopVoiceHostToggleBusy: false,
    onToggleDesktopVoiceHost: null,
    desktopVoiceHostRestarting: false,
    onRestartDesktopVoiceHost: null,
    desktopVoiceHostBootstrapBusy: false,
    desktopVoiceHostRemoveBusy: false,
    desktopVoiceHostBootstrapResult: null,
    onBootstrapDesktopVoiceHost: null,
    onRemoveDesktopVoiceRuntime: null,
    desktopSpeechTunnelStatus: null,
    desktopSpeechTunnelLifecycle: null,
    desktopSpeechTunnelBusy: false,
    onEnsureDesktopSpeechTunnel: null,
    projectSpeechMode: "auto",
    speechPreferenceSource: "default",
    onProjectSpeechModeChange: () => undefined,
    providerSpeechVoices: [],
    providerDefaultVoiceId: null,
    selectedProviderVoice: null,
    onProviderVoiceChange: () => undefined,
    projectProviderVoiceId: null,
    browserSpeechVoices: [],
    selectedDeviceVoice: null,
    onDeviceVoiceChange: () => undefined,
    projectDeviceVoiceId: null,
    ...overrides,
  };
}

function renderEntry(
  entry: ReturnType<typeof listProviderSettingsSurfaceEntries>[number] | undefined,
) {
  return renderToStaticMarkup(
    <>
      {entry ? (
        <ProviderShellSurface
          entry={entry.entry}
          hostActionBindings={entry.hostActionBindings}
          hostControlBindings={entry.hostControlBindings}
          hostSectionBindings={entry.hostSectionBindings}
        />
      ) : null}
    </>,
  );
}

describe("providerSettingsSurfaces", () => {
  it("routes speech and other provider settings cards through shared shell entries", () => {
    const providers = [
      createProviderSummary({
        id: "speech",
        title: "Speech",
        manifest: {
          familyId: "speech",
          hostSurfaces: [
            {
              surface: "settings_card",
              title: "Speech settings",
            },
            {
              surface: "status_card",
              title: "Speech status",
            },
          ],
        },
      }),
      createProviderSummary({
        id: "camera",
        title: "Camera",
        manifest: {
          familyId: "camera",
          hostSurfaces: [
            {
              surface: "status_card",
              title: "Camera status",
            },
          ],
        },
      }),
    ];

    const entries = listProviderSettingsSurfaceEntries(
      createContext({
        settingsProviders: providers,
      }),
    );

    expect(
      entries.map((entry) => ({
        key: entry.key,
        familyId: entry.familyId,
        providerId: entry.providerId ?? null,
      })),
    ).toEqual([
      {
        key: "speech:settings_card",
        familyId: "speech",
        providerId: "speech",
      },
      {
        key: "speech:status_card",
        familyId: "speech",
        providerId: "speech",
      },
      {
        key: "camera:status_card",
        familyId: "camera",
        providerId: "camera",
      },
    ]);
  });

  it("uses the built-in speech shell entries even when no discovered providers remain", () => {
    const entries = listProviderSettingsSurfaceEntries(
      createContext({
        settingsProviders: [],
      }),
    );

    expect(entries.map((entry) => entry.key)).toEqual([
      "speech:settings_card",
      "speech:status_card",
    ]);
  });

  it("hides provider voice selection when no provider voices are available", () => {
    const entries = listProviderSettingsSurfaceEntries(
      createContext({
        settingsProviders: [],
      }),
    );

    const settingsEntry = entries.find((entry) => entry.key === "speech:settings_card");
    const html = renderEntry(settingsEntry);

    expect(html).toContain("Speech route");
    expect(html).not.toContain("Provider voice");
    expect(html).not.toContain("No provider voice list is exposed yet.");
    expect(html).toContain("Device voice");
  });

  it("renders the speech settings through the generic provider shell even without discovered providers", () => {
    const entries = listProviderSettingsSurfaceEntries(
      createContext({
        settingsProviders: [],
        projectSpeechMode: "provider",
        speechPreferenceSource: "project",
        providerDefaultVoiceId: "nova",
        speechDependencyStatus: {
          dependencies: {
            managedRuntime: {
              available: true,
              home: "/home/test/.instafy/speech-host",
            },
          },
        },
        desktopVoiceHostStatus: {
          enabled: false,
          hostMode: "desktop",
          speechService: {
            state: "stopped",
            managed: false,
            reachable: false,
            healthUrl: "http://127.0.0.1:8796/health",
            scriptPath: "/tmp/local-speech-service.mjs",
          },
          providerHost: {
            state: "stopped",
            managed: false,
            reachable: false,
            healthUrl: "http://127.0.0.1:8797/health",
            scriptPath: "/tmp/local-provider-host.mjs",
          },
        },
        onToggleDesktopVoiceHost: () => undefined,
        onRemoveDesktopVoiceRuntime: () => undefined,
      }),
    );

    const settingsEntry = entries.find((entry) => entry.key === "speech:settings_card");
    expect(settingsEntry).toBeTruthy();

    const html = renderEntry(settingsEntry);

    expect(html).toContain("Speech provider");
    expect(html).toContain("Speech route");
    expect(html).toContain("Preference source");
    expect(html).toContain("Shared with this space");
    expect(html).toContain("Provider voice");
    expect(html).toContain("Automatic (nova)");
    expect(html).toContain("No provider voice list is exposed yet.");
    expect(html).toContain("Device voice");
    expect(html).toContain("This client does not expose browser speech voices right now.");
    expect(html).toContain("Enable on this Mac");
    expect(html).toContain("Remove downloaded runtime");
    expect(html).toContain("Current route");
    expect(html).not.toContain("Provider path");
    expect(html).not.toContain("Provider STT");
    expect(html).not.toContain("Device TTS");
    expect(html).not.toContain("Connection");
    expect(html).not.toContain("Readiness");
    expect(html).not.toContain("speech_transcription · speech_synthesis");
    expect(html).not.toContain("Scope");
    expect(html).not.toContain("Shared across speech surfaces");
    expect(html).not.toContain("Host-managed");
  });

  it("renders the speech status through the generic provider shell with bound diagnostics", () => {
    const entries = listProviderSettingsSurfaceEntries(
      createContext({
        settingsProviders: [],
        speechDependencyStatus: {
          transcription: {
            configured: true,
            ready: true,
            engine: "Provider STT",
            model: "base",
          },
          synthesis: {
            configured: true,
            ready: false,
            engine: "Device TTS",
          },
          nextSteps: ["Start the provider host."],
        },
      }),
    );

    const statusEntry = entries.find((entry) => entry.key === "speech:status_card");
    expect(statusEntry).toBeTruthy();

    const html = renderEntry(statusEntry);

    expect(html).toContain("Speech provider status");
    expect(html).toContain("Connection");
    expect(html).toContain("Readiness");
    expect(html).toContain("Current route");
    expect(html).toContain("Transcription");
    expect(html).toContain("Reply playback");
    expect(html).toContain("Warmup-aware readiness");
    expect(html).not.toContain("speech_transcription · speech_synthesis");
    expect(html).not.toContain("Fallback");
  });

  it("renders deferred sandboxed settings surfaces through the shared shell container path", () => {
    const entries = listProviderSettingsSurfaceEntries(
      createContext({
        settingsProviders: [
          createProviderSummary({
            id: "camera",
            title: "Camera",
            manifest: {
              familyId: "camera",
              hostSurfaces: [
                {
                  surface: "settings_card",
                  title: "Camera advanced settings",
                  metadata: {
                    policy: {
                      trustLevel: "untrusted",
                      renderMode: "sandboxed",
                    },
                  },
                },
              ],
            },
          }),
        ],
      }),
    );

    const deferredEntry = entries.find((entry) => entry.key === "camera:settings_card");
    expect(deferredEntry).toBeTruthy();

    const html = renderEntry(deferredEntry);

    expect(html).toContain("Camera advanced settings");
    expect(html).toContain("isolated provider UI container");
    expect(html).toContain("sandboxed");
  });
});
