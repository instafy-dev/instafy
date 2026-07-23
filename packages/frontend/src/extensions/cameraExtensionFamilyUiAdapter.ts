import { CAMERA_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import { isCameraProviderId } from "../camera/cameraProviderIdentity";
import type { ExtensionFamilyUiAdapter } from "./extensionFamilyUiAdapters";

function normalizeString(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export const CAMERA_EXTENSION_FAMILY_UI_ADAPTER: ExtensionFamilyUiAdapter = {
  familyId: CAMERA_PROVIDER_FAMILY.id,
  matchesProviderId(providerId) {
    return isCameraProviderId(providerId);
  },
  resolveCurrentNativeProviderId({ nativeRuntimeProviders, currentNativeCameraStatus }) {
    return (
      nativeRuntimeProviders.find((provider) => isCameraProviderId(provider.id))?.id ??
      currentNativeCameraStatus?.providerId?.trim().toLowerCase() ??
      null
    );
  },
  resolveProjectIntegrationProviderEntryKey({
    integrationProviderId,
    availableProviderIds,
    currentNativeProviderId,
  }) {
    const normalizedIntegrationProviderId = normalizeString(integrationProviderId);
    if (
      normalizedIntegrationProviderId === CAMERA_PROVIDER_FAMILY.id &&
      currentNativeProviderId &&
      availableProviderIds.has(currentNativeProviderId)
    ) {
      return currentNativeProviderId;
    }
    return null;
  },
  buildNativeAttachMetadata({ providerId, currentNativeCameraStatus, currentPlatform }) {
    if (!isCameraProviderId(providerId)) {
      return null;
    }
    const resolvedProviderId = currentNativeCameraStatus?.providerId?.trim() || "";
    const deviceId = currentNativeCameraStatus?.deviceId?.trim() || "";
    if (!resolvedProviderId || !deviceId) {
      return null;
    }
    return {
      transport:
        currentNativeCameraStatus?.backend === "usb_webcam" || currentNativeCameraStatus?.platform === "desktop"
          ? "desktop_webcam"
          : "native_camera",
      identifier: deviceId,
      address: deviceId,
      name: currentNativeCameraStatus?.deviceLabel?.trim() || "This device",
      nativePlatform:
        currentPlatform === "android" || currentPlatform === "ios"
          ? currentPlatform
          : null,
      connectedAt: new Date().toISOString(),
    };
  },
  shouldUseCurrentNativeStatus({ providerId, source, currentNativeProviderId }) {
    const normalizedProviderId = normalizeString(providerId);
    if (!normalizedProviderId) {
      return false;
    }
    return (
      normalizeString(currentNativeProviderId) === normalizedProviderId ||
      (normalizedProviderId === CAMERA_PROVIDER_FAMILY.id && source === "native_runtime")
    );
  },
};
