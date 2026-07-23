import {
  formatProjectProviderSelectedDeviceLabel,
  isProjectProviderFamilyPreferred,
  type ProjectProviderSelectedDevice,
} from "../capabilities/projectProviderAccess";
import {
  buildCameraProviderDeviceRecordFromStatus,
  resolveCameraRemoteDeviceDetails,
  resolveCameraRemoteRequestSummary,
  type CameraRemoteDeviceDetails,
  type CameraRemoteRequestSummary,
} from "../camera/cameraRemoteRequestPresentation";
import { CAMERA_PROVIDER_ID } from "../camera/cameraCapabilityMetadata";
import type { CameraStatusSnapshot } from "../camera/types";
import type { ControllerProjectIntegration } from "../services/runtimeController/integrations";
import type { ControllerProviderDeviceRecord } from "../services/runtimeController/providerDevices";
import type { ControllerProviderRequestRecord } from "../services/runtimeController/providerRequests";

export type CameraExtensionAttachedDeviceItem = {
  providerId: string;
  label: string;
  platformLabel: string | null;
  summaryText: string;
  freshnessText: string | null;
  tone: "secondary" | "warning";
  presenceStatus: "online" | "offline";
  isDefault: boolean;
  isCurrentDevice: boolean;
};

export type CameraExtensionAttachedEntry = {
  attached: boolean;
  mutationProviderId: string;
  source: "host" | "project_integration" | "native_runtime";
  selectedDevice: ProjectProviderSelectedDevice | null;
  integration: ControllerProjectIntegration | null;
};

export type CameraExtensionRemotePresentation = {
  requestSummary: CameraRemoteRequestSummary | null;
  deviceDetails: CameraRemoteDeviceDetails | null;
  remoteStatus: "ready" | "permission" | "issue" | "offline" | null;
  attachedRemoteOnlySummary: string;
};

function normalizeString(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function shouldUseCurrentNativeCameraStatus(input: {
  providerId: string;
  source: "host" | "project_integration" | "native_runtime";
  currentNativeProviderId: string | null;
}) {
  const normalizedProviderId = normalizeString(input.providerId);
  if (!normalizedProviderId) {
    return false;
  }
  return (
    normalizeString(input.currentNativeProviderId) === normalizedProviderId ||
    (normalizedProviderId === CAMERA_PROVIDER_ID && input.source === "native_runtime")
  );
}

export function listCameraExtensionAttachedDeviceItems(input: {
  entries: CameraExtensionAttachedEntry[];
  currentNativeCameraProviderId: string | null;
  currentNativeCameraStatus: CameraStatusSnapshot | null;
  remoteCameraDevicesByProvider: Record<string, ControllerProviderDeviceRecord | null | undefined>;
  remoteCameraRequestsByProvider: Record<string, ControllerProviderRequestRecord[] | undefined>;
}) {
  const items: CameraExtensionAttachedDeviceItem[] = [];

  for (const entry of input.entries) {
    if (!entry.attached) {
      continue;
    }

    const controllerDeviceRecord =
      input.remoteCameraDevicesByProvider[entry.mutationProviderId] ??
      (shouldUseCurrentNativeCameraStatus({
        providerId: entry.mutationProviderId,
        source: entry.source,
        currentNativeProviderId: input.currentNativeCameraProviderId,
      }) &&
      input.currentNativeCameraStatus
        ? buildCameraProviderDeviceRecordFromStatus({
            status: input.currentNativeCameraStatus,
            providerIdOverride: entry.mutationProviderId,
          })
        : null);

    const requestSummary = resolveCameraRemoteRequestSummary({
      requests: input.remoteCameraRequestsByProvider[entry.mutationProviderId] ?? [],
      selectedDevice: entry.selectedDevice,
      device: controllerDeviceRecord,
    });
    const deviceDetails = resolveCameraRemoteDeviceDetails({
      selectedDevice: entry.selectedDevice,
      device: controllerDeviceRecord,
    });
    const label =
      deviceDetails?.label ??
      entry.selectedDevice?.name?.trim() ??
      formatProjectProviderSelectedDeviceLabel(entry.selectedDevice);

    items.push({
      providerId: entry.mutationProviderId,
      label,
      platformLabel: deviceDetails?.platformLabel ?? null,
      summaryText:
        requestSummary?.compactText ?? deviceDetails?.stateText ?? "Saved.",
      freshnessText: deviceDetails?.freshnessText ?? null,
      tone:
        requestSummary?.tone ??
        (deviceDetails?.presenceStatus === "offline" ? "warning" : "secondary"),
      presenceStatus:
        requestSummary?.presenceStatus ?? deviceDetails?.presenceStatus ?? "offline",
      isDefault: isProjectProviderFamilyPreferred(entry.integration),
      isCurrentDevice: input.currentNativeCameraProviderId === entry.mutationProviderId,
    });
  }

  items.sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    if (left.isCurrentDevice !== right.isCurrentDevice) {
      return left.isCurrentDevice ? -1 : 1;
    }
    if (left.presenceStatus !== right.presenceStatus) {
      return left.presenceStatus === "online" ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });

  return items;
}

export function resolveCameraExtensionRemotePresentation(input: {
  attachedRemoteOnly: boolean;
  providerId: string;
  selectedDevice: ProjectProviderSelectedDevice | null;
  remoteCameraDevicesByProvider: Record<string, ControllerProviderDeviceRecord | null | undefined>;
  remoteCameraRequestsByProvider: Record<string, ControllerProviderRequestRecord[] | undefined>;
}) : CameraExtensionRemotePresentation | null {
  if (!input.attachedRemoteOnly) {
    return null;
  }

  const requestSummary = resolveCameraRemoteRequestSummary({
    requests: input.remoteCameraRequestsByProvider[input.providerId] ?? [],
    selectedDevice: input.selectedDevice,
    device: input.remoteCameraDevicesByProvider[input.providerId] ?? null,
  });
  const deviceDetails = resolveCameraRemoteDeviceDetails({
    selectedDevice: input.selectedDevice,
    device: input.remoteCameraDevicesByProvider[input.providerId] ?? null,
  });
  const remoteStatus = requestSummary?.requiresPermission
    ? "permission"
    : requestSummary?.hasRecentFailure
      ? "issue"
      : requestSummary?.presenceStatus === "online"
        ? "ready"
        : requestSummary?.presenceStatus === "offline"
          ? "offline"
          : null;

  return {
    requestSummary,
    deviceDetails,
    remoteStatus,
    attachedRemoteOnlySummary:
      requestSummary?.text ??
      `Photo requests go to ${
        input.selectedDevice?.name?.trim() ||
        formatProjectProviderSelectedDeviceLabel(input.selectedDevice)
      } while Instafy stays open there.`,
  };
}
