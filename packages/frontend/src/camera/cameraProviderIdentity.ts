import type { LocalProviderSummary } from "../capabilities/localProviderHostClient";
import {
  getRegisteredNativeRuntimeProvider,
} from "../extensions/extensionCatalog";
import {
  createExtensionProviderInstanceId,
  matchesExtensionProviderFamily,
} from "../providers/extensionProviderId";
import { CAMERA_PROVIDER_ID } from "./cameraCapabilityMetadata";
import type { CameraStatusSnapshot } from "./types";

function normalizeString(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isCameraProviderId(value: string | null | undefined) {
  return matchesExtensionProviderFamily(value, CAMERA_PROVIDER_ID);
}

export function createCameraProviderInstanceId(deviceId: string | null | undefined) {
  return createExtensionProviderInstanceId(CAMERA_PROVIDER_ID, deviceId);
}

export function resolveNativeCameraProviderId(
  status: Pick<CameraStatusSnapshot, "providerId" | "deviceId"> | null | undefined,
) {
  const providerId = normalizeString(status?.providerId);
  if (providerId && isCameraProviderId(providerId)) {
    return providerId;
  }

  const deviceId = normalizeString(status?.deviceId);
  if (!deviceId) {
    return null;
  }
  return createCameraProviderInstanceId(deviceId);
}

export function buildNativeCameraRuntimeProvider(
  status: CameraStatusSnapshot | null | undefined,
  providerIdOverride?: string | null,
): LocalProviderSummary | null {
  const baseProvider = getRegisteredNativeRuntimeProvider(CAMERA_PROVIDER_ID);
  if (!baseProvider) {
    return null;
  }

  const providerId =
    normalizeString(providerIdOverride) || resolveNativeCameraProviderId(status) || CAMERA_PROVIDER_ID;

  return {
    ...baseProvider,
    id: providerId,
    discoverable: status ? status.supported !== false : baseProvider.discoverable,
    error:
      typeof status?.error === "string" && status.error.trim().length > 0
        ? status.error.trim()
        : undefined,
  };
}
