import { describe, expect, it } from "vitest";
import {
  buildNativeCameraRuntimeProvider,
  createCameraProviderInstanceId,
  resolveNativeCameraProviderId,
} from "../cameraProviderIdentity";

describe("cameraProviderIdentity", () => {
  it("derives instance ids and provider summaries from native camera status", () => {
    const providerId = createCameraProviderInstanceId("pixel-test-device");
    expect(providerId).toBe("camera:pixel-test-device");

    const status = {
      supported: true,
      platform: "android",
      backend: "phone_camera" as const,
      deviceId: "pixel-test-device",
      deviceLabel: "Pixel Test",
      permission: "granted" as const,
      permissionGranted: true,
      canCapture: true,
      availableLenses: [],
      selectedLens: "rear" as const,
      lastCapture: null,
    };

    expect(resolveNativeCameraProviderId(status)).toBe("camera:pixel-test-device");
    expect(buildNativeCameraRuntimeProvider(status)).toMatchObject({
      id: "camera:pixel-test-device",
      providerType: "phone_camera",
      capabilityIds: ["camera_observation"],
    });
  });
});
