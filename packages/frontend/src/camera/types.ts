export type CameraBackendKind = "phone_camera" | "usb_webcam" | "virtual_camera";

export type CameraLensId = "rear" | "front" | "external";

export type CameraPermissionState =
  | "granted"
  | "denied"
  | "restricted"
  | "prompt"
  | "prompt-with-rationale";

export type CameraCaptureFormat = "jpeg" | "png";

export interface CameraLensSummary {
  id: CameraLensId;
  title: string;
  available: boolean;
  nativeId?: string | null;
  selected?: boolean;
}

export interface CameraCaptureMetadata {
  captureId: string;
  backend: CameraBackendKind;
  lens: CameraLensId;
  capturedAt: string;
  fileName?: string | null;
  filePath?: string | null;
  webPath?: string | null;
  mimeType?: string | null;
  format?: CameraCaptureFormat | null;
  width?: number | null;
  height?: number | null;
  sizeBytes?: number | null;
  seriesIndex?: number | null;
}

export interface CameraStatusSnapshot {
  supported: boolean;
  platform: string;
  backend: CameraBackendKind;
  deviceId?: string | null;
  deviceLabel?: string | null;
  providerId?: string | null;
  permission: CameraPermissionState;
  permissionGranted: boolean;
  canCapture: boolean;
  availableLenses: CameraLensSummary[];
  selectedLens: CameraLensId | null;
  lastCapture: CameraCaptureMetadata | null;
  error?: string;
}

export interface CameraCaptureResult extends CameraStatusSnapshot {
  cancelled?: boolean;
  capture: CameraCaptureMetadata | null;
}

export interface CameraCaptureSeriesResult extends CameraStatusSnapshot {
  cancelled?: boolean;
  requestedCount: number;
  completedCount: number;
  captures: CameraCaptureMetadata[];
}
