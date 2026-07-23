import { CAMERA_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import { describe, expect, it } from "vitest";
import {
  buildExtensionNativeAttachMetadata,
  resolveExtensionAttachedDeviceFamilyId,
  resolveExtensionFamilyCurrentNativeProviderId,
  resolveExtensionFamilyInstanceTitle,
  resolveExtensionProjectIntegrationProviderEntryKey,
  shouldUseExtensionCurrentNativeStatus,
  supportsExtensionAttachedDeviceList,
  supportsExtensionRemoteDeviceUi,
} from "../extensionFamilyUiRegistry";

describe("extensionFamilyUiRegistry", () => {
  it("maps the base camera integration to the current native camera provider instance", () => {
    expect(
      resolveExtensionProjectIntegrationProviderEntryKey({
        integrationProviderId: CAMERA_PROVIDER_FAMILY.id,
        availableProviderIds: ["camera:pixel-test"],
        currentNativeProviderId: "camera:pixel-test",
      }),
    ).toBe("camera:pixel-test");
  });

  it("derives the current native camera provider id from runtime providers and native status", () => {
    expect(
      resolveExtensionFamilyCurrentNativeProviderId({
        familyId: CAMERA_PROVIDER_FAMILY.id,
        nativeRuntimeProviders: [
          {
            id: "camera:pixel-test",
            title: "Camera",
          },
        ],
        currentNativeCameraStatus: null,
      }),
    ).toBe("camera:pixel-test");
  });

  it("builds attach metadata for the current camera device", () => {
    expect(
      buildExtensionNativeAttachMetadata({
        providerId: CAMERA_PROVIDER_FAMILY.id,
        currentPlatform: "android",
        currentNativeCameraStatus: {
          supported: true,
          platform: "android",
          backend: "phone_camera",
          deviceId: "pixel-test",
          deviceLabel: "Pixel Test",
          providerId: "camera:pixel-test",
          permission: "granted",
          permissionGranted: true,
          canCapture: true,
          availableLenses: [],
          selectedLens: "rear",
          lastCapture: null,
        },
      }),
    ).toMatchObject({
      transport: "native_camera",
      identifier: "pixel-test",
      address: "pixel-test",
      name: "Pixel Test",
      nativePlatform: "android",
    });
  });

  it("adds a device label to camera instance titles when multiple family entries are attached", () => {
    expect(
      resolveExtensionFamilyInstanceTitle({
        providerId: "camera:pixel-test",
        title: "Camera",
        attachedFamilyCount: 2,
        selectedDeviceLabel: "Pixel Test",
      }),
    ).toBe("Camera · Pixel Test");
  });

  it("reports remote-device ui support only for camera today", () => {
    expect(supportsExtensionRemoteDeviceUi(CAMERA_PROVIDER_FAMILY.id)).toBe(true);
    expect(supportsExtensionAttachedDeviceList("camera:pixel-test")).toBe(true);
    expect(resolveExtensionAttachedDeviceFamilyId("camera:pixel-test")).toBe(
      CAMERA_PROVIDER_FAMILY.id,
    );
    expect(supportsExtensionRemoteDeviceUi("other-provider")).toBe(false);
  });

  it("uses family-specific rules when deciding whether native status should backfill a provider", () => {
    expect(
      shouldUseExtensionCurrentNativeStatus({
        providerId: "camera:pixel-test",
        source: "project_integration",
        currentNativeProviderId: "camera:pixel-test",
      }),
    ).toBe(true);
    expect(
      shouldUseExtensionCurrentNativeStatus({
        providerId: CAMERA_PROVIDER_FAMILY.id,
        source: "native_runtime",
        currentNativeProviderId: null,
      }),
    ).toBe(true);
    expect(
      shouldUseExtensionCurrentNativeStatus({
        providerId: "other-provider",
        source: "native_runtime",
        currentNativeProviderId: null,
      }),
    ).toBe(false);
  });
});
