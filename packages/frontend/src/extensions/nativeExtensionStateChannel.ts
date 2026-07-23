import type { CameraStatusSnapshot } from "../camera/types";

export const NATIVE_EXTENSION_STATE_UPDATED_EVENT = "instafy:native-extension-state:updated";

export type NativeExtensionStateUpdateDetail = {
  projectId: string;
  providerId: string;
  cameraStatus?: CameraStatusSnapshot | null;
  integrationUpdated?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCameraStatus(value: unknown): CameraStatusSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.supported !== "boolean" || typeof value.platform !== "string") {
    return null;
  }
  if (typeof value.permissionGranted !== "boolean" || typeof value.canCapture !== "boolean") {
    return null;
  }
  if (!Array.isArray(value.availableLenses) || value.selectedLens === undefined) {
    return null;
  }

  return value as unknown as CameraStatusSnapshot;
}

export function dispatchNativeExtensionStateUpdated(
  detail: NativeExtensionStateUpdateDetail,
) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<NativeExtensionStateUpdateDetail>(NATIVE_EXTENSION_STATE_UPDATED_EVENT, {
      detail,
    }),
  );
}

export function readNativeExtensionStateUpdateDetail(
  event: Event,
): NativeExtensionStateUpdateDetail | null {
  if (!(event instanceof CustomEvent) || !isRecord(event.detail)) {
    return null;
  }

  const projectId =
    typeof event.detail.projectId === "string" ? event.detail.projectId.trim() : "";
  const providerId =
    typeof event.detail.providerId === "string" ? event.detail.providerId.trim() : "";
  if (!projectId || !providerId) {
    return null;
  }

  return {
    projectId,
    providerId,
    cameraStatus: normalizeCameraStatus(event.detail.cameraStatus),
    integrationUpdated: event.detail.integrationUpdated === true,
  };
}
