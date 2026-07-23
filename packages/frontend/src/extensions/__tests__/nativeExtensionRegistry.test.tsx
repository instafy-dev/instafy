import { describe, expect, it } from "vitest";
import { CAMERA_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import { resolveNativeExtensionRegistration } from "../nativeExtensionRegistry";

describe("nativeExtensionRegistry", () => {
  it("resolves Camera contributions and device-language attach copy", () => {
    const registration = resolveNativeExtensionRegistration({
      provider: {
        id: "camera",
        title: "Camera",
        providerType: "phone_camera",
        capabilityIds: ["camera_observation"],
      },
    });

    expect(registration?.definition.familyId).toBe(CAMERA_PROVIDER_FAMILY.id);
    expect(registration?.formatAttachButtonLabel(false, "native_runtime")).toBe("Use this device");
    expect(registration?.formatAttachButtonVariant("native_runtime")).toBe("primary");
    expect(
      registration?.formatDetailsButtonLabel({
        attached: false,
        expanded: false,
        hasManageSurface: true,
      }),
    ).toBe("Open setup");
    expect(
      registration?.formatDetailsButtonLabel({
        attached: true,
        expanded: false,
        hasManageSurface: true,
      }),
    ).toBe("Manage");
    expect(
      registration?.formatDetailsButtonLabel({
        attached: true,
        expanded: true,
        hasManageSurface: true,
      }),
    ).toBe("Close");
    expect(
      registration?.formatStateLabel({
        source: "native_runtime",
        attached: true,
        projectName: "Home",
      }),
    ).toBe("This device is the camera for Home.");
    expect(registration?.formatDefaultCaption?.()).toBe("Preferred for new photos.");
    expect(
      registration?.formatSavedStateLabel({
        selectedDevice: {
          transport: "native_camera",
          identifier: "pixel-test-device",
          address: "camera:pixel-test-device",
          name: "Pixel Test",
          nativePlatform: "android",
        },
        cameraState: {
          selectedLens: "rear",
          lastCapture: {
            captureId: "cap-1",
            backend: "phone_camera",
            lens: "rear",
            capturedAt: "2026-03-31T00:00:00.000Z",
            fileName: null,
            filePath: null,
            webPath: null,
            mimeType: null,
            format: "jpeg",
            width: 1920,
            height: 1080,
            sizeBytes: 10_000,
            seriesIndex: null,
          },
          updatedAt: "2026-03-31T00:00:00.000Z",
        },
      }),
    ).toBe("Preferred device: Pixel Test (camera:pixel-test-device) · Last capture: rear lens · 1920×1080");
  });
});
