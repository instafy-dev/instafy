import type { ControllerProjectIntegration } from "../services/runtimeController/integrations";
import type { CameraCaptureMetadata, CameraLensId } from "./types";

export interface ProjectProviderCameraState {
  selectedLens: CameraLensId | null;
  lastCapture: CameraCaptureMetadata | null;
  updatedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLensId(value: unknown): CameraLensId | null {
  return value === "rear" || value === "front" || value === "external" ? value : null;
}

function normalizeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeCameraCaptureMetadata(value: unknown): CameraCaptureMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const captureId = normalizeString(value.captureId);
  const capturedAt = normalizeString(value.capturedAt);
  const backend =
    value.backend === "phone_camera" ||
    value.backend === "usb_webcam" ||
    value.backend === "virtual_camera"
      ? value.backend
      : "phone_camera";
  const lens = normalizeLensId(value.lens);

  if (!captureId || !capturedAt || !lens) {
    return null;
  }

  return {
    captureId,
    backend,
    lens,
    capturedAt,
    fileName: normalizeString(value.fileName),
    filePath: normalizeString(value.filePath),
    webPath: normalizeString(value.webPath),
    mimeType: normalizeString(value.mimeType),
    format: value.format === "jpeg" || value.format === "png" ? value.format : null,
    width: normalizeNumber(value.width),
    height: normalizeNumber(value.height),
    sizeBytes: normalizeNumber(value.sizeBytes),
    seriesIndex: normalizeNumber(value.seriesIndex),
  };
}

function normalizeCameraMetadata(
  metadataValue: Record<string, unknown> | null | undefined,
): ProjectProviderCameraState {
  const metadata = isRecord(metadataValue) ? metadataValue : {};
  const camera = isRecord(metadata.camera) ? metadata.camera : metadata;

  return {
    selectedLens: normalizeLensId(camera.selectedLens),
    lastCapture: normalizeCameraCaptureMetadata(camera.lastCapture),
    updatedAt: normalizeString(camera.updatedAt),
  };
}

export function getProjectProviderCameraState(
  integration: ControllerProjectIntegration | null | undefined,
): ProjectProviderCameraState {
  const metadata = isRecord(integration?.metadata) ? integration.metadata : {};
  return normalizeCameraMetadata(metadata);
}

export function withProjectProviderCameraState(
  metadataValue: Record<string, unknown> | null | undefined,
  input: {
    selectedLens?: CameraLensId | null;
    lastCapture?: CameraCaptureMetadata | null;
  },
  nowIso = new Date().toISOString(),
): Record<string, unknown> {
  const metadata = isRecord(metadataValue) ? metadataValue : {};
  const current = normalizeCameraMetadata(metadata);
  const nextCameraState = {
    selectedLens:
      input.selectedLens === undefined ? current.selectedLens : normalizeLensId(input.selectedLens),
    lastCapture:
      input.lastCapture === undefined
        ? current.lastCapture
        : normalizeCameraCaptureMetadata(input.lastCapture),
    updatedAt: nowIso,
  };

  return {
    ...metadata,
    camera: nextCameraState,
  };
}
