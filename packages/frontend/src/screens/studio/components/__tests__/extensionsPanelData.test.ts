import { describe, expect, it } from "vitest";
import { buildProjectExtensionEntries, countAttachedExtensionFamilies, listAttachedCameraProviderIds } from "../extensionsPanelData";

describe("extensionsPanelData", () => {
  it("builds merged project extension entries from local and saved integration providers", () => {
    const result = buildProjectExtensionEntries({
      builtInAssistants: [
        {
          mentionToken: "@camera",
          capabilityBindings: [{ capabilityId: "camera_observation", enabled: true }],
        },
      ] as never,
      localProviders: [
        {
          id: "camera:pixel-test",
          title: "Kitchen camera",
          capabilityIds: ["camera_observation"],
          discoverable: true,
        },
      ],
      nativeRuntimeProviders: [],
      projectIntegrations: [
        {
          id: "integration-camera-1",
          projectId: "project-1",
          provider: "camera:pixel-test",
          status: "connected",
          connectionType: "native_runtime",
          credentialId: null,
          metadata: {
            selectedDevice: {
              transport: "lan",
              identifier: "pixel-device",
              address: "192.168.1.20",
              name: "Pixel 9",
            },
          },
          requiredScopes: [],
          capabilities: ["camera_observation"],
          createdBy: null,
          createdAt: "2026-04-17T08:00:00.000Z",
          updatedAt: "2026-04-17T08:00:00.000Z",
        },
        {
          id: "integration-speech-1",
          projectId: "project-1",
          provider: "speech:remote-host",
          status: "attached",
          connectionType: "local_provider",
          credentialId: null,
          metadata: {},
          requiredScopes: [],
          capabilities: ["speech_transcription"],
          createdBy: null,
          createdAt: "2026-04-17T08:00:00.000Z",
          updatedAt: "2026-04-17T08:00:00.000Z",
        },
      ] as never,
      currentNativeCameraProviderId: null,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      mutationProviderId: "camera:pixel-test",
      attached: true,
      discoverable: true,
      selectedDevice: expect.objectContaining({
        identifier: "pixel-device",
        name: "Pixel 9",
      }),
      attachedCapabilityIds: ["camera_observation"],
    });
    expect(result[1]).toMatchObject({
      mutationProviderId: "speech:remote-host",
      source: "project_integration",
      attached: true,
      discoverable: false,
      attachedCapabilityIds: ["speech_transcription"],
    });
  });

  it("derives attached camera providers and family counts from built entries", () => {
    const entries = [
      {
        mutationProviderId: "camera:pixel-test",
        attached: true,
      },
      {
        mutationProviderId: "camera:iphone-test",
        attached: true,
      },
      {
        mutationProviderId: "demo",
        attached: true,
      },
      {
        mutationProviderId: "speech:remote-host",
        attached: false,
      },
    ] as never;

    expect(listAttachedCameraProviderIds(entries)).toEqual([
      "camera:pixel-test",
      "camera:iphone-test",
    ]);
    expect(Array.from(countAttachedExtensionFamilies(entries).entries())).toEqual([
      ["camera", 2],
      ["demo", 1],
    ]);
  });

  it("puts attached camera devices before the local available camera row", () => {
    const result = buildProjectExtensionEntries({
      builtInAssistants: [
        {
          mentionToken: "@camera",
          capabilityBindings: [{ capabilityId: "camera_observation", enabled: true }],
        },
      ] as never,
      localProviders: [],
      nativeRuntimeProviders: [
        {
          id: "camera:ios-local",
          title: "Camera",
          capabilityIds: ["camera_observation"],
          discoverable: true,
        },
      ],
      projectIntegrations: [
        {
          id: "integration-camera-desktop",
          projectId: "project-1",
          provider: "camera:desktop-webcam-1",
          status: "attached",
          connectionType: "native_runtime",
          credentialId: null,
          metadata: {
            selectedDevice: {
              transport: "desktop_webcam",
              identifier: "desktop-camera",
              address: "desktop-camera",
              name: "Desktop webcam",
            },
            providerFamilySelection: {
              familyId: "camera",
              preferredProviderId: "camera:desktop-webcam-1",
              preferredDevice: {
                transport: "desktop_webcam",
                identifier: "desktop-camera",
                address: "desktop-camera",
                name: "Desktop webcam",
              },
              updatedAt: "2026-04-17T08:00:00.000Z",
            },
          },
          requiredScopes: [],
          capabilities: ["camera_observation"],
          createdBy: null,
          createdAt: "2026-04-17T08:00:00.000Z",
          updatedAt: "2026-04-17T08:00:00.000Z",
        },
      ] as never,
      currentNativeCameraProviderId: "camera:ios-local",
    });

    expect(result.map((entry) => entry.mutationProviderId)).toEqual([
      "camera:desktop-webcam-1",
      "camera:ios-local",
    ]);
    expect(result[0]).toMatchObject({
      attached: true,
      selectedDevice: expect.objectContaining({ name: "Desktop webcam" }),
    });
    expect(result[1]).toMatchObject({
      source: "native_runtime",
      attached: false,
      discoverable: true,
    });
  });
});
