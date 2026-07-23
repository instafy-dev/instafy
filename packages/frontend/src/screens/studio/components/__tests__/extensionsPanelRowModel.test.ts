import { describe, expect, it } from "vitest";
import { CAMERA_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import { buildExtensionsPanelRowModel } from "../extensionsPanelRowModel";

describe("extensionsPanelRowModel", () => {
  it("derives row presentation state for a remote camera entry", () => {
    const result = buildExtensionsPanelRowModel({
      entry: {
        provider: {
          id: "camera:pixel-test",
          title: "Kitchen camera",
          capabilityIds: ["camera_observation"],
          discoverable: false,
        },
        source: "project_integration",
        integration: {
          id: "integration-1",
          provider: "camera:pixel-test",
          connectionType: "native_runtime",
          status: "connected",
          metadata: {},
          capabilities: ["camera_observation"],
          credentialId: null,
          requiredScopes: [],
        } as never,
        mutationProviderId: "camera:pixel-test",
        discoverable: false,
        attached: true,
        selectedDevice: {
          identifier: "pixel-device",
          name: "Pixel 9",
          address: "192.168.1.10",
          transport: "lan",
        },
        cameraState: {
          selectedLens: "rear",
          lastCapture: null,
          updatedAt: null,
        },
        assistantDefinitions: [{ mentionToken: "@camera" }] as never,
        capabilityIds: ["camera_observation"],
        providerCapabilityIds: ["camera_observation"],
        attachedCapabilityIds: ["camera_observation"],
      },
      activeProjectName: "Kitchen",
      isPending: false,
      showDeveloperDetails: true,
      expanded: true,
      currentNativeCameraStatus: null,
      nativeRuntimeStatusByProvider: {},
      nativeAuxiliaryStatusByProvider: {},
      nativeCameraHealthStateByProvider: {},
      remoteCameraRequestsByProvider: {},
      remoteCameraDevicesByProvider: {},
      attachedExtensionFamilyCounts: new Map([[CAMERA_PROVIDER_FAMILY.id, 1]]),
      cameraAttachedDeviceItems: [],
      hasProviderHostSurface: true,
    });

    expect(result.providerLabel).toBe("Camera");
    expect(result.connectionType).toBe("native_runtime");
    expect(result.eligibleAssistantLabel).toBe("@camera");
    expect(result.projectCapabilityLabel).toContain("camera_observation");
    expect(result.rowPresentation.providerTitle).toContain("Camera");
  });
});
