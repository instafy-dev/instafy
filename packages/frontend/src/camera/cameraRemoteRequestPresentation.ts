import {
  formatProjectProviderSelectedDeviceLabel,
  type ProjectProviderSelectedDevice,
} from "../capabilities/projectProviderAccess";
import { CAMERA_PROVIDER_ID } from "./cameraCapabilityMetadata";
import type { CameraCaptureMetadata, CameraLensId, CameraStatusSnapshot } from "./types";
import type { ControllerProviderDeviceRecord } from "../services/runtimeController/providerDevices";
import type { ControllerProviderRequestRecord } from "../services/runtimeController/providerRequests";

export type CameraRemoteRequestSummary = {
  tone: "secondary" | "warning";
  text: string;
  compactText: string;
  deviceLabel: string | null;
  hasActiveRequest: boolean;
  requestState: "pending" | "in_progress" | null;
  presenceStatus: "online" | "offline" | null;
  requiresPermission: boolean;
  hasRecentFailure: boolean;
};

export type CameraRemoteDeviceDetails = {
  label: string;
  presenceStatus: "online" | "offline";
  platformLabel: string | null;
  stateText: string;
  freshnessText: string | null;
};

type CameraRequestTimelineLabelInput = {
  deviceLabel?: string | null;
  requestState?: string | null;
  presenceStatus?: string | null;
  requiresPermission?: boolean;
  hasRecentFailure?: boolean;
};

export type CameraRequestTimelinePresentation = {
  label: string | null;
  tone: "secondary" | "warning";
  showSpinner: boolean;
};

const REMOTE_CAMERA_FAILURE_LOOKBACK_MS = 10 * 60_000;
const PROVIDER_TIMEOUT_ERROR =
  "Timed out waiting for the provider device to respond.";

function normalizeTimelineState(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeLens(value: unknown) {
  return value === "front" || value === "rear" || value === "external" ? value : null;
}

function normalizeDeviceLabel(
  selectedDevice: ProjectProviderSelectedDevice | null,
  device?: ControllerProviderDeviceRecord | null,
  fallbackLabel?: string | null,
) {
  const liveLabel =
    typeof device?.deviceLabel === "string" && device.deviceLabel.trim().length > 0
      ? device.deviceLabel.trim()
      : null;
  if (liveLabel) {
    return liveLabel;
  }
  const explicitLabel =
    typeof fallbackLabel === "string" && fallbackLabel.trim().length > 0
      ? fallbackLabel.trim()
      : null;
  if (explicitLabel) {
    return explicitLabel;
  }
  if (selectedDevice) {
    const preferredName = selectedDevice.name?.trim();
    if (preferredName) {
      return preferredName;
    }
    const formatted = formatProjectProviderSelectedDeviceLabel(selectedDevice);
    if (formatted.trim().length > 0 && formatted !== "another device") {
      return formatted;
    }
  }
  return "the attached camera device";
}

function normalizeRequestTimestamp(request: ControllerProviderRequestRecord) {
  const timestamps = [
    request.updatedAt,
    request.completedAt,
    request.claimedAt,
    request.createdAt,
  ];
  for (const timestamp of timestamps) {
    const value = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isNaN(value)) {
      return value;
    }
  }
  return 0;
}

function formatCameraCaptureSubject(request: ControllerProviderRequestRecord) {
  if (request.requestKind === "resource_read") {
    return "camera status";
  }

  const lens = normalizeLens(request.arguments.lens);
  const rawCount = request.arguments.count;
  const count =
    typeof rawCount === "number" && Number.isFinite(rawCount)
      ? Math.max(1, Math.min(5, Math.round(rawCount)))
      : 1;

  if (lens === "front") {
    return count > 1 ? `${count} front selfies` : "front selfie";
  }

  const lensPrefix = lens === "external" ? "external" : lens === "rear" ? "rear" : "camera";
  return count > 1 ? `${count} ${lensPrefix} photos` : `${lensPrefix} photo`;
}

function parseCameraDeviceMetadata(
  device: ControllerProviderDeviceRecord | null | undefined,
): {
  permissionGranted: boolean | null;
  selectedLens: CameraLensId | null;
  lastCapture: CameraCaptureMetadata | null;
} {
  const metadata = device?.metadata;
  if (!metadata) {
    return {
      permissionGranted: null,
      selectedLens: null,
      lastCapture: null,
    };
  }

  const permissionGranted =
    typeof metadata.permissionGranted === "boolean" ? metadata.permissionGranted : null;
  const selectedLens = normalizeLens(metadata.selectedLens);
  const lastCaptureCandidate = metadata.lastCapture;
  const lastCapture =
    lastCaptureCandidate &&
    typeof lastCaptureCandidate === "object" &&
    !Array.isArray(lastCaptureCandidate) &&
    typeof (lastCaptureCandidate as { captureId?: unknown }).captureId === "string" &&
    typeof (lastCaptureCandidate as { capturedAt?: unknown }).capturedAt === "string" &&
    normalizeLens((lastCaptureCandidate as { lens?: unknown }).lens)
      ? (lastCaptureCandidate as CameraCaptureMetadata)
      : null;

  return {
    permissionGranted,
    selectedLens,
    lastCapture,
  };
}

function formatCaptureLabel(capture: CameraCaptureMetadata) {
  const size =
    typeof capture.width === "number" && typeof capture.height === "number"
      ? ` · ${capture.width}×${capture.height}`
      : "";
  return `${capture.lens} lens${size}`;
}

function formatPlatformLabel(
  device: ControllerProviderDeviceRecord | null | undefined,
  selectedDevice: ProjectProviderSelectedDevice | null,
) {
  const platform = device?.platform ?? selectedDevice?.nativePlatform ?? null;
  if (platform === "android") {
    return "Android";
  }
  if (platform === "ios") {
    return "iPhone";
  }
  const metadataBackend =
    typeof device?.metadata?.backend === "string" ? device.metadata.backend.trim().toLowerCase() : "";
  const selectedTransport = selectedDevice?.transport.trim().toLowerCase() ?? "";
  if (selectedTransport === "desktop_webcam" || metadataBackend === "usb_webcam") {
    return "Desktop";
  }
  return null;
}

function resolveDeviceStatusFromSnapshot(status: CameraStatusSnapshot) {
  if (!status.supported) {
    return "unsupported";
  }
  if (!status.permissionGranted) {
    return "permission_required";
  }
  if (!status.canCapture) {
    return "unavailable";
  }
  return "ready";
}

export function formatCameraRequestTimelineLabel({
  deviceLabel,
  requestState,
  presenceStatus,
  requiresPermission,
  hasRecentFailure,
}: CameraRequestTimelineLabelInput) {
  const resolvedDeviceLabel =
    typeof deviceLabel === "string" && deviceLabel.trim().length > 0
      ? deviceLabel.trim()
      : "Camera";
  const normalizedRequestState = normalizeTimelineState(requestState);
  const normalizedPresenceStatus = normalizeTimelineState(presenceStatus);

  if (normalizedRequestState === "pending") {
    return normalizedPresenceStatus === "offline"
      ? `${resolvedDeviceLabel} is offline`
      : `Waiting on ${resolvedDeviceLabel}`;
  }
  if (normalizedRequestState === "in_progress") {
    return `${resolvedDeviceLabel} is capturing`;
  }
  if (requiresPermission) {
    return `${resolvedDeviceLabel} needs camera access`;
  }
  if (normalizedPresenceStatus === "offline") {
    return `${resolvedDeviceLabel} is offline`;
  }
  if (hasRecentFailure) {
    return `Last capture on ${resolvedDeviceLabel} failed`;
  }
  return null;
}

export function resolveCameraRequestTimelinePresentation(
  input: CameraRequestTimelineLabelInput,
): CameraRequestTimelinePresentation {
  const label = formatCameraRequestTimelineLabel(input);
  const normalizedRequestState = normalizeTimelineState(input.requestState);
  const normalizedPresenceStatus = normalizeTimelineState(input.presenceStatus);

  return {
    label,
    tone:
      input.requiresPermission ||
      input.hasRecentFailure ||
      normalizedPresenceStatus === "offline"
        ? "warning"
        : "secondary",
    showSpinner:
      normalizedRequestState === "pending" || normalizedRequestState === "in_progress",
  };
}

export function buildCameraProviderDeviceRecordFromStatus(params: {
  status: CameraStatusSnapshot | null | undefined;
  providerIdOverride?: string | null;
  lastSeenAt?: string | null;
}): ControllerProviderDeviceRecord | null {
  const status = params.status;
  if (!status) {
    return null;
  }

  const providerId =
    typeof params.providerIdOverride === "string" && params.providerIdOverride.trim().length > 0
      ? params.providerIdOverride.trim().toLowerCase()
      : typeof status.providerId === "string" && status.providerId.trim().length > 0
        ? status.providerId.trim().toLowerCase()
        : null;
  const deviceId =
    typeof status.deviceId === "string" && status.deviceId.trim().length > 0
      ? status.deviceId.trim()
      : null;
  if (!providerId || !deviceId) {
    return null;
  }

  const nowIso =
    typeof params.lastSeenAt === "string" && params.lastSeenAt.trim().length > 0
      ? params.lastSeenAt.trim()
      : new Date().toISOString();

  return {
    projectId: "",
    providerId,
    providerFamilyId: CAMERA_PROVIDER_ID,
    deviceId,
    deviceLabel: status.deviceLabel?.trim() || null,
    platform: status.platform === "android" || status.platform === "ios" ? status.platform : null,
    status: resolveDeviceStatusFromSnapshot(status),
    connectionType: "native_runtime",
    metadata: {
      permissionGranted: status.permissionGranted,
      selectedLens: status.selectedLens ?? null,
      lastCapture: status.lastCapture ?? null,
      supported: status.supported,
      canCapture: status.canCapture,
      availableLenses: status.availableLenses,
    },
    presenceStatus: "online",
    createdAt: nowIso,
    updatedAt: nowIso,
    lastSeenAt: nowIso,
  };
}

function formatFreshnessText(lastSeenAt: string | null | undefined, nowMs: number) {
  const parsed = typeof lastSeenAt === "string" ? Date.parse(lastSeenAt) : Number.NaN;
  if (Number.isNaN(parsed)) {
    return null;
  }
  const diffMs = Math.max(0, nowMs - parsed);
  if (diffMs < 15_000) {
    return "Seen just now.";
  }
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return "Seen under a minute ago.";
  }
  if (diffMinutes === 1) {
    return "Seen 1 minute ago.";
  }
  if (diffMinutes < 60) {
    return `Seen ${diffMinutes} minutes ago.`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) {
    return "Seen 1 hour ago.";
  }
  return `Seen ${diffHours} hours ago.`;
}

export function resolveCameraRemoteDeviceDetails(params: {
  selectedDevice: ProjectProviderSelectedDevice | null;
  device?: ControllerProviderDeviceRecord | null;
  nowMs?: number;
}): CameraRemoteDeviceDetails | null {
  if (!params.selectedDevice && !params.device) {
    return null;
  }

  const device = params.device ?? null;
  const nowMs = typeof params.nowMs === "number" ? params.nowMs : Date.now();
  const label = normalizeDeviceLabel(params.selectedDevice, device);
  const platformLabel = formatPlatformLabel(device, params.selectedDevice);
  const cameraDeviceState = parseCameraDeviceMetadata(device);

  if (device?.presenceStatus === "online") {
    if (device.status === "unsupported") {
      return {
        label,
        presenceStatus: "online",
        platformLabel,
        stateText: "Camera is unavailable on this device.",
        freshnessText: formatFreshnessText(device.lastSeenAt, nowMs),
      };
    }
    if (cameraDeviceState.permissionGranted === false) {
      return {
        label,
        presenceStatus: "online",
        platformLabel,
        stateText: "Needs camera access.",
        freshnessText: formatFreshnessText(device.lastSeenAt, nowMs),
      };
    }
    if (device.status === "unavailable") {
      return {
        label,
        presenceStatus: "online",
        platformLabel,
        stateText: "Camera is not ready.",
        freshnessText: formatFreshnessText(device.lastSeenAt, nowMs),
      };
    }
    if (cameraDeviceState.lastCapture) {
      return {
        label,
        presenceStatus: "online",
        platformLabel,
        stateText: `Latest capture · ${formatCaptureLabel(cameraDeviceState.lastCapture)}.`,
        freshnessText: formatFreshnessText(device.lastSeenAt, nowMs),
      };
    }
    if (cameraDeviceState.selectedLens) {
      return {
        label,
        presenceStatus: "online",
        platformLabel,
        stateText: `Ready · ${cameraDeviceState.selectedLens} lens.`,
        freshnessText: formatFreshnessText(device.lastSeenAt, nowMs),
      };
    }
    return {
      label,
      presenceStatus: "online",
      platformLabel,
      stateText: "Ready to capture.",
      freshnessText: formatFreshnessText(device.lastSeenAt, nowMs),
    };
  }

  return {
    label,
    presenceStatus: "offline",
    platformLabel,
    stateText: "Offline. Open Instafy on this device.",
    freshnessText:
      formatFreshnessText(device?.lastSeenAt ?? params.selectedDevice?.lastConnectedAt, nowMs),
  };
}

function summarizeRecentFailure(
  request: ControllerProviderRequestRecord,
  selectedDevice: ProjectProviderSelectedDevice | null,
  device: ControllerProviderDeviceRecord | null,
) {
  const deviceLabel = normalizeDeviceLabel(selectedDevice, device, request.claimedByDeviceLabel);
  const subject = formatCameraCaptureSubject(request);
  const error = request.error?.trim() ?? "";
  const normalizedError = error.toLowerCase();

  if (normalizedError.includes(PROVIDER_TIMEOUT_ERROR.toLowerCase())) {
    return `${deviceLabel} did not answer the ${subject} request. Open Instafy there and try again.`;
  }

  if (normalizedError.includes("permission")) {
    return `${deviceLabel} needs camera access before it can capture a ${subject}.`;
  }

  if (normalizedError.includes("not attached")) {
    return "Camera is no longer attached to this space.";
  }

  return `The last ${subject} request on ${deviceLabel} did not finish.`;
}

export function resolveCameraRemoteRequestSummary(params: {
  requests: ControllerProviderRequestRecord[];
  selectedDevice: ProjectProviderSelectedDevice | null;
  device?: ControllerProviderDeviceRecord | null;
  nowMs?: number;
}): CameraRemoteRequestSummary | null {
  const requests = [...params.requests].sort(
    (left, right) => normalizeRequestTimestamp(right) - normalizeRequestTimestamp(left),
  );
  const device = params.device ?? null;
  const cameraDeviceState = parseCameraDeviceMetadata(device);

  const activeRequest = requests.find(
    (request) => request.status === "claimed" || request.status === "pending",
  );
  if (activeRequest) {
    const deviceLabel = normalizeDeviceLabel(
      params.selectedDevice,
      device,
      activeRequest.claimedByDeviceLabel,
    );
    const subject = formatCameraCaptureSubject(activeRequest);
    return {
      tone: "secondary",
      compactText:
        activeRequest.status === "claimed"
          ? "Capturing now."
          : device?.presenceStatus === "offline"
            ? "Device offline. Open Instafy there."
            : `Waiting for the ${subject} request.`,
      deviceLabel,
      hasActiveRequest: true,
      requestState: activeRequest.status === "claimed" ? "in_progress" : "pending",
      presenceStatus: device?.presenceStatus ?? null,
      requiresPermission: false,
      hasRecentFailure: false,
      text:
        activeRequest.status === "claimed"
          ? `${deviceLabel} is capturing now.`
          : device?.presenceStatus === "offline"
            ? `${deviceLabel} is offline. Open Instafy there to continue.`
            : `Waiting for ${deviceLabel} to accept the ${subject} request.`,
    };
  }

  const nowMs = typeof params.nowMs === "number" ? params.nowMs : Date.now();
  const recentFailure = requests.find((request) => {
    if (request.status !== "failed" && request.status !== "expired") {
      return false;
    }
    const updatedAtMs = normalizeRequestTimestamp(request);
    return updatedAtMs > 0 && nowMs - updatedAtMs <= REMOTE_CAMERA_FAILURE_LOOKBACK_MS;
  });
  if (!recentFailure) {
    const deviceLabel = normalizeDeviceLabel(params.selectedDevice, device);
    const deviceDetails = resolveCameraRemoteDeviceDetails({
      selectedDevice: params.selectedDevice,
      device,
      nowMs,
    });
    if (device?.presenceStatus === "online") {
      if (cameraDeviceState.permissionGranted === false) {
        return {
          tone: "warning",
          compactText: "Needs camera access.",
          deviceLabel,
          hasActiveRequest: false,
          requestState: null,
          presenceStatus: "online",
          requiresPermission: true,
          hasRecentFailure: false,
          text: `${deviceLabel} needs camera access before it can take new photos.`,
        };
      }
      if (deviceDetails) {
        return {
          tone: "secondary",
          compactText:
            deviceDetails.stateText === "Ready to capture."
              ? "Ready."
              : deviceDetails.stateText,
          deviceLabel,
          hasActiveRequest: false,
          requestState: null,
          presenceStatus: "online",
          requiresPermission: false,
          hasRecentFailure: false,
          text:
            deviceDetails.stateText === "Ready to capture."
              ? `Ready on ${deviceLabel}.`
              : `Ready on ${deviceLabel} · ${deviceDetails.stateText
                  .replace(/^Latest capture · /, "latest capture ")
                  .replace(/^Ready · /, "")
                  .replace(/\.$/, "")}.`,
        };
      }
    }

    if (params.selectedDevice) {
      return {
        tone: "warning",
        compactText: "Offline. Open Instafy on this device.",
        deviceLabel,
        hasActiveRequest: false,
        requestState: null,
        presenceStatus: "offline",
        requiresPermission: false,
        hasRecentFailure: false,
        text: `${deviceLabel} is offline. Open Instafy there to use Camera.`,
      };
    }

    return null;
  }

  return {
    tone: "warning",
    compactText:
      recentFailure.error?.toLowerCase().includes(PROVIDER_TIMEOUT_ERROR.toLowerCase())
        ? "Last request timed out. Open Instafy there and try again."
        : recentFailure.error?.toLowerCase().includes("permission")
          ? "Needs camera access."
          : "Last request did not finish.",
    deviceLabel: normalizeDeviceLabel(params.selectedDevice, device, recentFailure.claimedByDeviceLabel),
    hasActiveRequest: false,
    requestState: null,
    presenceStatus: device?.presenceStatus ?? null,
    requiresPermission: false,
    hasRecentFailure: true,
    text: summarizeRecentFailure(recentFailure, params.selectedDevice, device),
  };
}

export function formatCameraCapabilityFailureMessage(params: {
  assistantDisplayName: string;
  error: string;
  selectedDevice: ProjectProviderSelectedDevice | null;
}) {
  const deviceLabel = normalizeDeviceLabel(params.selectedDevice);
  const message = params.error.trim();
  const normalized = message.toLowerCase();

  if (normalized.includes(PROVIDER_TIMEOUT_ERROR.toLowerCase())) {
    return `${params.assistantDisplayName} did not hear back from Camera on ${deviceLabel}. Open Instafy there and try again.`;
  }

  if (normalized.includes("permission")) {
    return `${params.assistantDisplayName} needs camera access on ${deviceLabel} before Camera can capture that photo.`;
  }

  if (normalized.includes("not attached")) {
    return `${params.assistantDisplayName} cannot use Camera in this space right now because it is not attached.`;
  }

  return `${params.assistantDisplayName} could not capture that photo: ${message}`;
}
