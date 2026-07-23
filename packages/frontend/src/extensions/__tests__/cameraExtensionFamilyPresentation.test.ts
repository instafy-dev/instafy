import { describe, expect, it } from "vitest";
import { listCameraExtensionAttachedDeviceItems, resolveCameraExtensionRemotePresentation } from "../cameraExtensionFamilyPresentation";

describe("cameraExtensionFamilyPresentation", () => {
  it("builds attached camera device items with default and current-device priority", () => {
    const items = listCameraExtensionAttachedDeviceItems({
      entries: [
        {
          attached: true,
          mutationProviderId: "camera:pixel-test",
          source: "project_integration",
          selectedDevice: {
            transport: "native_camera",
            identifier: "pixel-test",
            address: "pixel-test",
            name: "Pixel Test",
            nativePlatform: "android",
          },
          integration: {
            id: "integration-1",
            projectId: "project-1",
            provider: "camera:pixel-test",
            status: "attached",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
              providerFamilySelection: {
                familyId: "camera",
                preferredProviderId: "camera:pixel-test",
              },
            },
            requiredScopes: [],
            capabilities: [],
            createdBy: null,
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z",
          },
        },
        {
          attached: true,
          mutationProviderId: "camera:iphone-test",
          source: "project_integration",
          selectedDevice: {
            transport: "native_camera",
            identifier: "iphone-test",
            address: "iphone-test",
            name: "iPhone Test",
            nativePlatform: "ios",
          },
          integration: {
            id: "integration-2",
            projectId: "project-1",
            provider: "camera:iphone-test",
            status: "attached",
            connectionType: "native_runtime",
            credentialId: null,
            metadata: {
              attached: true,
            },
            requiredScopes: [],
            capabilities: [],
            createdBy: null,
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z",
          },
        },
      ],
      currentNativeCameraProviderId: "camera:pixel-test",
      currentNativeCameraStatus: null,
      remoteCameraDevicesByProvider: {
        "camera:pixel-test": {
          projectId: "project-1",
          providerId: "camera:pixel-test",
          providerFamilyId: "camera",
          deviceId: "pixel-test",
          deviceLabel: "Pixel Test",
          platform: "android",
          status: "ready",
          connectionType: "native_runtime",
          metadata: {},
          presenceStatus: "online",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
          lastSeenAt: "2026-04-16T00:00:00.000Z",
        },
        "camera:iphone-test": {
          projectId: "project-1",
          providerId: "camera:iphone-test",
          providerFamilyId: "camera",
          deviceId: "iphone-test",
          deviceLabel: "iPhone Test",
          platform: "ios",
          status: "ready",
          connectionType: "native_runtime",
          metadata: {},
          presenceStatus: "offline",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
          lastSeenAt: "2026-04-16T00:00:00.000Z",
        },
      },
      remoteCameraRequestsByProvider: {},
    });

    expect(items.map((item) => item.providerId)).toEqual([
      "camera:pixel-test",
      "camera:iphone-test",
    ]);
    expect(items[0]).toMatchObject({
      isDefault: true,
      isCurrentDevice: true,
      presenceStatus: "online",
    });
    expect(items[1]).toMatchObject({
      isDefault: false,
      isCurrentDevice: false,
      presenceStatus: "offline",
    });
  });

  it("resolves camera remote presentation status and summary text", () => {
    const presentation = resolveCameraExtensionRemotePresentation({
      attachedRemoteOnly: true,
      providerId: "camera:iphone-test",
      selectedDevice: {
        transport: "native_camera",
        identifier: "iphone-test",
        address: "iphone-test",
        name: "iPhone Test",
        nativePlatform: "ios",
      },
      remoteCameraDevicesByProvider: {
        "camera:iphone-test": {
          projectId: "project-1",
          providerId: "camera:iphone-test",
          providerFamilyId: "camera",
          deviceId: "iphone-test",
          deviceLabel: "iPhone Test",
          platform: "ios",
          status: "permission_required",
          connectionType: "native_runtime",
          metadata: {
            permissionGranted: false,
          },
          presenceStatus: "online",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
          lastSeenAt: "2026-04-16T00:00:00.000Z",
        },
      },
      remoteCameraRequestsByProvider: {
        "camera:iphone-test": [],
      },
    });

    expect(presentation?.remoteStatus).toBe("permission");
    expect(presentation?.deviceDetails?.label).toBe("iPhone Test");
    expect(presentation?.attachedRemoteOnlySummary).toContain("camera access");
  });
});
