import { useEffect, useRef, type ReactNode } from "react";
import {
  CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
  CAMERA_CAPTURE_PHOTO_TOOL_ID,
  CAMERA_PROVIDER_ID,
  CAMERA_LATEST_CAPTURE_RESOURCE_URI,
  CAMERA_LENSES_RESOURCE_URI,
  CAMERA_STATUS_RESOURCE_URI,
} from "../camera/cameraCapabilityMetadata";
import {
  createNativeCameraExecutionContext,
} from "../camera/cameraBridgeClient";
import { withProjectProviderCameraState } from "../camera/cameraProjectState";
import {
  captureNativeCameraPhoto,
  captureNativeCameraPhotoSeries,
  getNativeCameraStatus,
  supportsCurrentClientNativeCameraBridge,
} from "../camera/nativeCameraBridge";
import {
  isCameraProviderId,
  resolveNativeCameraProviderId,
} from "../camera/cameraProviderIdentity";
import type {
  CameraCaptureResult,
  CameraCaptureSeriesResult,
  CameraLensId,
  CameraStatusSnapshot,
} from "../camera/types";
import {
  getProjectIntegrationByProvider,
  getProjectProviderSelectedDevice,
} from "../capabilities/projectProviderAccess";
import {
  dispatchNativeExtensionStateUpdated,
  NATIVE_EXTENSION_STATE_UPDATED_EVENT,
} from "./nativeExtensionStateChannel";
import {
  integrationIsAttached,
  providerRequestTargetsCurrentDevice,
} from "./providerRequestClaimSupport";
import { APPLICATION_FRONTEND_FEATURES } from "../features/applicationFrontendFeatureComposition";
import type { FrontendStudioRuntimeBridgeContribution } from "../features/frontendFeatureModule";
import { useProject } from "../projects/useProject";
import { isPollingActive, subscribePollingGate } from "../runtime/pollingGate";
import { controllerClient } from "../sdk/instafy";
import type {
  ControllerProjectIntegration,
  ControllerProviderRequestRecord,
} from "../services/runtimeController";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLens(value: unknown): CameraLensId | null {
  return value === "rear" || value === "front" || value === "external" ? value : null;
}

function normalizeCameraCaptureMetadata(
  value: unknown,
): CameraCaptureResult["capture"] | CameraCaptureSeriesResult["captures"][number] | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.captureId !== "string" ||
    typeof value.capturedAt !== "string" ||
    !normalizeLens(value.lens)
  ) {
    return null;
  }
  return value as unknown as CameraCaptureResult["capture"];
}

function buildCameraHeartbeatMetadata(status: CameraStatusSnapshot) {
  return {
    backend: status.backend,
    supported: status.supported,
    permissionGranted: status.permissionGranted,
    canCapture: status.canCapture,
    selectedLens: status.selectedLens ?? null,
    availableLenses: status.availableLenses,
    lastCapture: status.lastCapture ?? null,
  };
}

function resolveCameraHeartbeatStatus(status: CameraStatusSnapshot) {
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

function resolveCameraHeartbeatPlatform(status: CameraStatusSnapshot): "android" | "ios" | null {
  return status.platform === "android" || status.platform === "ios" ? status.platform : null;
}

async function loadAttachedCameraIntegration(
  projectId: string,
  providerId: string,
): Promise<ControllerProjectIntegration | null> {
  const result = await controllerClient.integrations.listForProject(projectId).catch(() => null);
  if (!result?.success) {
    return null;
  }
  const integration = getProjectIntegrationByProvider(result.integrations, providerId);
  return integration && integrationIsAttached(integration) ? integration : null;
}

function selectedDeviceMatchesCurrentCameraProvider(
  selectedDevice: ReturnType<typeof getProjectProviderSelectedDevice>,
  status: CameraStatusSnapshot,
  currentProviderId: string,
) {
  if (!selectedDevice) {
    return true;
  }

  const normalizedDeviceId = status.deviceId?.trim().toLowerCase() ?? "";
  const normalizedProviderId = currentProviderId.trim().toLowerCase();
  const candidates = [
    selectedDevice.identifier,
    selectedDevice.address ?? null,
  ]
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .filter((value) => value.length > 0);

  return candidates.includes(normalizedDeviceId) || candidates.includes(normalizedProviderId);
}

async function persistCameraIntegrationState(params: {
  projectId: string;
  integration: ControllerProjectIntegration;
  selectedLens?: CameraLensId | null;
  lastCapture?: CameraCaptureResult["capture"] | CameraCaptureSeriesResult["captures"][number] | null;
}) {
  const nextMetadata = withProjectProviderCameraState(params.integration.metadata, {
    selectedLens: params.selectedLens ?? undefined,
    lastCapture: params.lastCapture ?? undefined,
  });
  await controllerClient.integrations.upsert(params.projectId, params.integration.provider, {
    status: params.integration.status,
    connectionType: params.integration.connectionType,
    credentialId: params.integration.credentialId,
    metadata: nextMetadata,
    capabilities: params.integration.capabilities,
    requiredScopes: params.integration.requiredScopes,
  });
}

function deriveCameraStatusFromResponse(
  response: Record<string, unknown>,
  fallbackStatus: CameraStatusSnapshot,
): CameraStatusSnapshot {
  const nextStatus: CameraStatusSnapshot = {
    ...fallbackStatus,
  };
  const value = isRecord(response.value) ? response.value : null;

  if (value && response.ok === true) {
    if (typeof value.permissionGranted === "boolean") {
      nextStatus.permissionGranted = value.permissionGranted;
    }
    if (typeof value.canCapture === "boolean") {
      nextStatus.canCapture = value.canCapture;
    }
    if (Array.isArray(value.availableLenses)) {
      nextStatus.availableLenses = value.availableLenses as CameraStatusSnapshot["availableLenses"];
    }
    nextStatus.selectedLens =
      normalizeLens(value.selectedLens ?? value.lens) ?? nextStatus.selectedLens;

    const capture =
      normalizeCameraCaptureMetadata(value.capture) ??
      (Array.isArray(value.captures)
        ? normalizeCameraCaptureMetadata(value.captures[value.captures.length - 1])
        : null);
    if (capture) {
      nextStatus.lastCapture = capture;
      nextStatus.selectedLens = normalizeLens(capture.lens) ?? nextStatus.selectedLens;
      nextStatus.permissionGranted = true;
      nextStatus.canCapture = true;
    }
  }

  return nextStatus;
}

async function executeCameraToolRequest(
  request: ControllerProviderRequestRecord,
  providerId: string,
): Promise<Record<string, unknown>> {
  const lens = normalizeLens(request.arguments.lens);

  if (request.toolName === CAMERA_CAPTURE_PHOTO_TOOL_ID) {
    const result = await captureNativeCameraPhoto({
      lens: lens ?? undefined,
    });
    return {
      ok: true,
      providerId,
      name: CAMERA_CAPTURE_PHOTO_TOOL_ID,
      value: result,
      executionContext: createNativeCameraExecutionContext(providerId, result),
    };
  }

  if (request.toolName === CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID) {
    const rawCount = request.arguments.count;
    const requestedCount =
      typeof rawCount === "number" && Number.isFinite(rawCount)
        ? Math.max(1, Math.min(5, Math.round(rawCount)))
        : undefined;
    const result = await captureNativeCameraPhotoSeries({
      lens: lens ?? undefined,
      count: requestedCount,
    });
    const executionStatus = await getNativeCameraStatus();
    return {
      ok: true,
      providerId,
      name: CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
      value: result,
      executionContext: createNativeCameraExecutionContext(providerId, executionStatus),
    };
  }

  return {
    ok: false,
    providerId,
    name: request.toolName ?? "",
    error: `Unsupported remote camera tool: ${request.toolName ?? "unknown"}.`,
  };
}

async function executeCameraResourceRequest(
  request: ControllerProviderRequestRecord,
  providerId: string,
): Promise<Record<string, unknown>> {
  const status = await getNativeCameraStatus();

  if (request.resourceUri === CAMERA_STATUS_RESOURCE_URI) {
    return {
      ok: true,
      providerId,
      uri: CAMERA_STATUS_RESOURCE_URI,
      exists: true,
      value: status,
    };
  }

  if (request.resourceUri === CAMERA_LENSES_RESOURCE_URI) {
    return {
      ok: true,
      providerId,
      uri: CAMERA_LENSES_RESOURCE_URI,
      exists: true,
      value: {
        availableLenses: status.availableLenses,
      },
    };
  }

  if (request.resourceUri === CAMERA_LATEST_CAPTURE_RESOURCE_URI) {
    return {
      ok: true,
      providerId,
      uri: CAMERA_LATEST_CAPTURE_RESOURCE_URI,
      exists: true,
      value: {
        lastCapture: status.lastCapture ?? null,
      },
    };
  }

  return {
    ok: false,
    providerId,
    uri: request.resourceUri ?? "",
    exists: false,
    error: `Unsupported remote camera resource: ${request.resourceUri ?? "unknown"}.`,
  };
}

async function handleCameraProviderRequest(params: {
  projectId: string;
  request: ControllerProviderRequestRecord;
  integration: ControllerProjectIntegration;
  status: CameraStatusSnapshot;
}) {
  const providerId = params.request.providerId;
  const deviceId = params.status.deviceId?.trim() ?? "";
  if (!deviceId) {
    return;
  }

  const claimed = await controllerClient.providerRequests
    .claim({
      projectId: params.projectId,
      requestId: params.request.id,
      providerId,
      deviceId,
      deviceLabel: params.status.deviceLabel ?? undefined,
    })
    .catch(() => null);

  if (!claimed || claimed.status !== "claimed") {
    return;
  }

  let response: Record<string, unknown>;
  try {
    response =
      params.request.requestKind === "tool_call"
        ? await executeCameraToolRequest(params.request, providerId)
        : await executeCameraResourceRequest(params.request, providerId);
  } catch (error) {
    response = {
      ok: false,
      providerId,
      ...(params.request.requestKind === "tool_call"
        ? { name: params.request.toolName ?? "" }
        : { uri: params.request.resourceUri ?? "", exists: false }),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  await controllerClient.providerRequests.complete({
    projectId: params.projectId,
    requestId: params.request.id,
    providerId,
    deviceId,
    response,
  });

  if (response.ok !== true) {
    return;
  }

  const effectiveStatus = deriveCameraStatusFromResponse(response, {
    ...params.status,
  });

  await controllerClient.providerDevices
    .heartbeat({
      projectId: params.projectId,
      providerId,
      providerFamilyId: CAMERA_PROVIDER_ID,
      deviceId,
      deviceLabel: effectiveStatus.deviceLabel ?? undefined,
      platform: resolveCameraHeartbeatPlatform(effectiveStatus),
      status: resolveCameraHeartbeatStatus(effectiveStatus),
      connectionType: "native_runtime",
      metadata: buildCameraHeartbeatMetadata(effectiveStatus),
    })
    .catch(() => null);

  if (params.request.requestKind === "tool_call") {
    const toolValue =
      isRecord(response.value) ? (response.value as Record<string, unknown>) : null;
    const selectedLens = normalizeLens(toolValue?.selectedLens ?? toolValue?.lens);
    const lastCapture =
      normalizeCameraCaptureMetadata(toolValue?.capture) ??
      (Array.isArray(toolValue?.captures)
        ? normalizeCameraCaptureMetadata(toolValue?.captures[toolValue.captures.length - 1])
        : null);
    await persistCameraIntegrationState({
      projectId: params.projectId,
      integration: params.integration,
      selectedLens: selectedLens ?? effectiveStatus.selectedLens ?? null,
      lastCapture: lastCapture ?? effectiveStatus.lastCapture ?? null,
    }).catch(() => undefined);
    dispatchNativeExtensionStateUpdated({
      projectId: params.projectId,
      providerId,
      cameraStatus: effectiveStatus,
      integrationUpdated: true,
    });
    return;
  }

  if (params.request.resourceUri === CAMERA_STATUS_RESOURCE_URI) {
    const value = isRecord(response.value) ? response.value : null;
    const lastCapture = normalizeCameraCaptureMetadata(value?.lastCapture);
    const selectedLens = normalizeLens(value?.selectedLens);
    await persistCameraIntegrationState({
      projectId: params.projectId,
      integration: params.integration,
      selectedLens: selectedLens ?? effectiveStatus.selectedLens ?? null,
      lastCapture,
    }).catch(() => undefined);
  }

  dispatchNativeExtensionStateUpdated({
    projectId: params.projectId,
    providerId,
    cameraStatus: effectiveStatus,
    integrationUpdated: true,
  });
}

/**
 * Retry delay while no camera integration is attached (or the attached device
 * is not this one). Nothing changes on its own in that state, so the retry
 * only runs while the user is active; otherwise the bridge waits for the
 * polling gate, window focus or an integration update before looking again.
 */
const NO_INTEGRATION_RETRY_MS = 10_000;

function NativeExtensionRequestBridge() {
  const { activeProjectId } = useProject();
  const busyRef = useRef(false);
  const heartbeatRef = useRef<{ atMs: number; signature: string | null }>({
    atMs: 0,
    signature: null,
  });

  useEffect(() => {
    if (!supportsCurrentClientNativeCameraBridge()) {
      return;
    }

    const projectId = activeProjectId?.trim() ?? "";
    if (!projectId) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    let stopWaiting: (() => void) | null = null;

    const waitForWake = () => {
      const wake = () => {
        stopWaiting?.();
        void tick();
      };
      const onGateChange = () => {
        if (isPollingActive()) {
          wake();
        }
      };
      const unsubscribeGate = subscribePollingGate(onGateChange);
      window.addEventListener("focus", wake);
      window.addEventListener(NATIVE_EXTENSION_STATE_UPDATED_EVENT, wake);
      stopWaiting = () => {
        stopWaiting = null;
        unsubscribeGate();
        window.removeEventListener("focus", wake);
        window.removeEventListener(NATIVE_EXTENSION_STATE_UPDATED_EVENT, wake);
      };
    };

    const schedule = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      if (delayMs === NO_INTEGRATION_RETRY_MS && !isPollingActive()) {
        waitForWake();
        return;
      }
      timerId = window.setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (cancelled || busyRef.current) {
        schedule(2_000);
        return;
      }

      busyRef.current = true;
      let nextDelayMs = 4_000;

      try {
        const status = await getNativeCameraStatus().catch(() => null);
        const nativeProviderId = resolveNativeCameraProviderId(status) ?? "";
        const deviceId = status?.deviceId?.trim() ?? "";

        if (
          !status?.supported ||
          !deviceId ||
          (nativeProviderId.length > 0 && !isCameraProviderId(nativeProviderId))
        ) {
          nextDelayMs = NO_INTEGRATION_RETRY_MS;
          return;
        }

        const integration =
          (await loadAttachedCameraIntegration(projectId, nativeProviderId || CAMERA_PROVIDER_ID)) ??
          (nativeProviderId && nativeProviderId !== CAMERA_PROVIDER_ID
            ? await loadAttachedCameraIntegration(projectId, CAMERA_PROVIDER_ID)
            : null);
        if (!integration) {
          nextDelayMs = NO_INTEGRATION_RETRY_MS;
          return;
        }

        const providerId = integration.provider;

        const heartbeatMetadata = buildCameraHeartbeatMetadata(status);
        const heartbeatSignature = JSON.stringify({
          providerId,
          deviceId,
          deviceLabel: status.deviceLabel ?? null,
          heartbeatStatus: resolveCameraHeartbeatStatus(status),
          metadata: heartbeatMetadata,
        });
        const nowMs = Date.now();
        if (
          nowMs - heartbeatRef.current.atMs >= 15_000 ||
          heartbeatRef.current.signature !== heartbeatSignature
        ) {
          const heartbeatRecord = await controllerClient.providerDevices
            .heartbeat({
              projectId,
              providerId,
              providerFamilyId: CAMERA_PROVIDER_ID,
              deviceId,
              deviceLabel: status.deviceLabel ?? undefined,
              platform: resolveCameraHeartbeatPlatform(status),
              status: resolveCameraHeartbeatStatus(status),
              connectionType: "native_runtime",
              metadata: heartbeatMetadata,
            })
            .catch(() => null);
          if (heartbeatRecord) {
            heartbeatRef.current = {
              atMs: nowMs,
              signature: heartbeatSignature,
            };
          }
        }

        const savedDevice = getProjectProviderSelectedDevice(integration);
        if (!selectedDeviceMatchesCurrentCameraProvider(savedDevice, status, nativeProviderId)) {
          nextDelayMs = NO_INTEGRATION_RETRY_MS;
          return;
        }

        const pendingRequests = await controllerClient.providerRequests
          .list({
            projectId,
            providerId,
            statuses: ["pending", "claimed"],
            limit: 5,
          })
          .catch(() => []);

        const nextRequest =
          pendingRequests.find((request) =>
            providerRequestTargetsCurrentDevice(request, providerId, deviceId),
          ) ?? null;

        if (!nextRequest) {
          nextDelayMs = 2_500;
          return;
        }

        await handleCameraProviderRequest({
          projectId,
          request: nextRequest,
          integration,
          status,
        });
        nextDelayMs = 500;
      } finally {
        busyRef.current = false;
        schedule(nextDelayMs);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      stopWaiting?.();
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [activeProjectId]);

  return null;
}

export function NativeExtensionRequestProvider({ children }: { children: ReactNode }) {
  return (
    <>
      <NativeExtensionRequestBridge />
      <StudioRuntimeBridges
        bridges={APPLICATION_FRONTEND_FEATURES.studioRuntimeBridges}
      />
      {children}
    </>
  );
}

export function StudioRuntimeBridges({
  bridges,
}: {
  bridges: readonly FrontendStudioRuntimeBridgeContribution[];
}) {
  return (
    <>
      {bridges.map(
        ({ id, component: RuntimeBridge }) => (
          <RuntimeBridge key={id} />
        ),
      )}
    </>
  );
}
