import { describe, expect, it } from "vitest";
import { CAMERA_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import { buildExtensionFamilyRowSupport } from "../extensionFamilyRowSupport";

describe("extensionFamilyRowSupport", () => {
  it("derives remote camera row support for attached remote integrations", () => {
    const result = buildExtensionFamilyRowSupport({
      providerId: "camera:pixel-test",
      mutationProviderId: "camera:pixel-test",
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
      attached: true,
      discoverable: false,
      selectedDevice: {
        identifier: "pixel-device",
        name: "Pixel 9",
        address: "192.168.1.10",
        transport: "lan",
      },
      currentNativeCameraStatus: null,
      remoteCameraRequestsByProvider: {},
      remoteCameraDevicesByProvider: {
        "camera:pixel-test": {
          providerId: "camera:pixel-test",
          providerFamilyId: "camera",
          label: "Pixel 9",
          platform: "android",
          status: "offline",
          updatedAt: "2026-04-19T12:00:00.000Z",
        } as never,
      },
      attachedExtensionFamilyCounts: new Map([[CAMERA_PROVIDER_FAMILY.id, 2]]),
      cameraAttachedDeviceItems: [
        {
          providerId: "camera:pixel-test",
          label: "Pixel 9",
          platformLabel: "Android",
          summaryText: "Offline",
          freshnessText: null,
          tone: "warning",
          presenceStatus: "offline",
          isDefault: true,
          isCurrentDevice: false,
        },
      ],
    });

    expect(result.attachedRemoteOnly).toBe(true);
    expect(result.attachedFamilyCount).toBe(2);
    expect(result.remoteCameraPresentation?.deviceDetails?.label).toBe("Pixel 9");
    expect(result.attachedRemoteOnlySummary).toContain("Pixel 9");
    expect(result.familyCameraDeviceItems).toHaveLength(1);
  });

  it("returns neutral support for non-camera families", () => {
    const result = buildExtensionFamilyRowSupport({
      providerId: "device:unit-1",
      mutationProviderId: "device:unit-1",
      source: "native_runtime",
      integration: null,
      attached: true,
      discoverable: true,
      selectedDevice: null,
      currentNativeCameraStatus: null,
      remoteCameraRequestsByProvider: {},
      remoteCameraDevicesByProvider: {},
      attachedExtensionFamilyCounts: new Map([["device", 1]]),
      cameraAttachedDeviceItems: [
        {
          providerId: "camera:pixel-test",
          label: "Pixel 9",
          platformLabel: "Android",
          summaryText: "Offline",
          freshnessText: null,
          tone: "warning",
          presenceStatus: "offline",
          isDefault: true,
          isCurrentDevice: false,
        },
      ],
    });

    expect(result.attachedRemoteOnly).toBe(false);
    expect(result.remoteCameraPresentation).toBeNull();
    expect(result.attachedRemoteOnlySummary).toBeNull();
    expect(result.familyCameraDeviceItems).toEqual([]);
  });
});
