import {
  createProviderExecutionContext,
  type ProviderExecutionContext,
} from "@instafy/provider-contract";
import {
  callLocalProviderTool,
  getLocalProviderForCapability,
  getLocalProviderSummary,
  type LocalProviderSummary,
} from "../capabilities/localProviderHostClient";
import { controllerClient } from "../sdk/instafy";
import {
  dispatchControllerProviderToolCall,
  listControllerProviderRequests,
} from "../services/runtimeController/providerRequests";
import { listControllerProviderDevices } from "../services/runtimeController/providerDevices";
import {
  getProjectIntegrationByProvider,
  getProjectProviderSelectedDevice,
  isProjectIntegrationAttached,
} from "../capabilities/projectProviderAccess";
import {
  CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
  CAMERA_CAPTURE_PHOTO_TOOL_ID,
  CAMERA_OBSERVATION_CAPABILITY_ID,
  CAMERA_PROVIDER_ID,
} from "./cameraCapabilityMetadata";
import { getProjectProviderCameraState } from "./cameraProjectState";
import {
  captureNativeCameraPhoto,
  captureNativeCameraPhotoSeries,
  getNativeCameraStatus,
  isVirtualCameraCaptureTestArmed,
} from "./nativeCameraBridge";
import {
  isCameraProviderId,
  resolveNativeCameraProviderId,
} from "./cameraProviderIdentity";
import {
  resolveCameraRemoteRequestSummary,
  type CameraRemoteRequestSummary,
} from "./cameraRemoteRequestPresentation";
import type {
  CameraCaptureResult,
  CameraCaptureSeriesResult,
  CameraLensId,
  CameraStatusSnapshot,
} from "./types";

type CameraProviderClientOptions = {
  providerId?: string | null;
  provider?: LocalProviderSummary | null;
  projectId?: string | null;
  onRemoteRequestSummary?: ((summary: CameraRemoteRequestSummary) => void) | null;
};

type CameraProviderContext = {
  providerId: string;
  provider: LocalProviderSummary | null;
  toolAliases: {
    capturePhoto: string;
    capturePhotoSeries: string;
  };
};

export type CameraProviderCaptureResponse<TCaptureResult> = {
  result: TCaptureResult;
  executionContext?: ProviderExecutionContext;
};

const DEFAULT_CAMERA_TOOL_ALIASES = {
  capturePhoto: CAMERA_CAPTURE_PHOTO_TOOL_ID,
  capturePhotoSeries: CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
};

const REMOTE_CAMERA_REQUEST_POLL_INTERVAL_MS = 1_250;

function createMissingCameraProviderError() {
  return new Error("No discoverable camera provider is available for camera observation.");
}

function resolveCameraProviderId(options?: CameraProviderClientOptions) {
  return options?.providerId?.trim() || options?.provider?.id?.trim() || "";
}

function providerUsesNativeCamera(options?: CameraProviderClientOptions) {
  const providerId = resolveCameraProviderId(options);
  return (
    providerId === CAMERA_PROVIDER_ID ||
    options?.provider?.providerType === "phone_camera" ||
    options?.provider?.providerType === "camera"
  );
}

function statusSupportsNativeCameraRuntime(status: CameraStatusSnapshot | null | undefined) {
  return status?.supported === true && status.platform !== "web";
}

export function createNativeCameraExecutionContext(
  providerId: string,
  status: CameraStatusSnapshot,
): ProviderExecutionContext {
  return createProviderExecutionContext({
    providerId,
    providerType: "phone_camera",
    runtime: {
      backendId: status.backend,
      transportKind:
        status.backend === "usb_webcam" ? "desktop_webcam" : "native_camera",
      transportTarget: status.deviceId?.trim() || undefined,
      executionSurface:
        status.platform === "android" || status.platform === "ios"
          ? status.platform
          : status.platform === "desktop"
            ? "desktop_app"
            : "native_extension",
    },
  });
}

async function resolveNativeCameraPreferredLens(
  options?: CameraProviderClientOptions,
): Promise<CameraLensId | null> {
  const projectId = options?.projectId?.trim();
  if (!projectId || !providerUsesNativeCamera(options)) {
    return null;
  }

  const integrationsResult = await controllerClient.integrations.listForProject(projectId).catch(
    () => null,
  );
  if (!integrationsResult?.success) {
    return null;
  }

  const providerId = resolveCameraProviderId(options) || CAMERA_PROVIDER_ID;
  const integration = getProjectIntegrationByProvider(integrationsResult.integrations, providerId);
  if (!integration) {
    return null;
  }

  return getProjectProviderCameraState(integration).selectedLens;
}

async function resolveRemoteCameraSelectedDevice(
  options?: CameraProviderClientOptions,
) {
  const integrationContext = await resolveAttachedRemoteCameraIntegration(options);
  return integrationContext?.selectedDevice ?? null;
}

async function resolveAttachedRemoteCameraIntegration(
  options?: CameraProviderClientOptions,
) {
  const projectId = options?.projectId?.trim();
  const providerId = resolveCameraProviderId(options);
  if (!projectId || !providerId || !isCameraProviderId(providerId)) {
    return null;
  }

  const integrationsResult = await controllerClient.integrations.listForProject(projectId).catch(
    () => null,
  );
  if (!integrationsResult?.success) {
    return null;
  }

  const integration = getProjectIntegrationByProvider(integrationsResult.integrations, providerId);
  if (!integration || !isProjectIntegrationAttached(integration)) {
    return null;
  }

  return {
    integration,
    selectedDevice: getProjectProviderSelectedDevice(integration),
  };
}

async function shouldPreferRemoteCameraCapture(
  options?: CameraProviderClientOptions,
) {
  if (!providerUsesNativeCamera(options) || !canUseRemoteCameraProvider(options)) {
    return false;
  }

  const integrationContext = await resolveAttachedRemoteCameraIntegration(options);
  if (!integrationContext) {
    return false;
  }

  if (integrationContext.selectedDevice?.transport === "native_camera") {
    return true;
  }

  return integrationContext.integration.connectionType.trim().toLowerCase() === "native_runtime";
}

function createCameraProviderContext(
  providerId: string,
  provider: LocalProviderSummary | null,
): CameraProviderContext {
  return {
    providerId,
    provider,
    toolAliases: {
      ...DEFAULT_CAMERA_TOOL_ALIASES,
      ...(provider?.toolAliases ?? {}),
    },
  };
}

async function resolveCameraProviderContext(
  options?: CameraProviderClientOptions,
): Promise<CameraProviderContext> {
  const providerId = resolveCameraProviderId(options);
  const provider =
    options?.provider ??
    (providerId ? await getLocalProviderSummary(providerId).catch(() => null) : null) ??
    (!providerId ? await getLocalProviderForCapability(CAMERA_OBSERVATION_CAPABILITY_ID) : null);

  if (!provider) {
    throw createMissingCameraProviderError();
  }

  return createCameraProviderContext(provider.id, provider);
}

async function maybeUseNativeCameraCapture(
  options?: CameraProviderClientOptions,
): Promise<boolean> {
  if (!providerUsesNativeCamera(options)) {
    return false;
  }
  const status = await getNativeCameraStatus().catch(() => null);
  if (!statusSupportsNativeCameraRuntime(status)) {
    return false;
  }

  const resolvedProviderId = resolveCameraProviderId(options).toLowerCase();
  if (!resolvedProviderId) {
    return true;
  }

  const currentProviderId = resolveNativeCameraProviderId(status)?.toLowerCase() ?? "";
  return resolvedProviderId === CAMERA_PROVIDER_ID || resolvedProviderId === currentProviderId;
}

function canUseRemoteCameraProvider(options?: CameraProviderClientOptions) {
  const projectId = options?.projectId?.trim() ?? "";
  const providerId = resolveCameraProviderId(options);
  return projectId.length > 0 && providerId.length > 0 && isCameraProviderId(providerId);
}

function shouldEmitRemoteRequestSummary(
  summary: CameraRemoteRequestSummary | null,
): summary is CameraRemoteRequestSummary {
  if (!summary) {
    return false;
  }
  return (
    summary.hasActiveRequest ||
    summary.hasRecentFailure ||
    summary.requiresPermission ||
    summary.presenceStatus === "offline"
  );
}

function createRemoteRequestSummaryKey(summary: CameraRemoteRequestSummary) {
  return [
    summary.text,
    summary.tone,
    summary.requestState ?? "",
    summary.presenceStatus ?? "",
    summary.requiresPermission ? "permission" : "",
    summary.hasRecentFailure ? "failure" : "",
  ].join("|");
}

function waitForRemoteCameraPoll(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function monitorRemoteCameraRequestSummaries(params: {
  projectId: string;
  providerId: string;
  onSummary: (summary: CameraRemoteRequestSummary) => void;
  signal: AbortSignal;
  selectedDevice: ReturnType<typeof getProjectProviderSelectedDevice>;
}) {
  let previousSummaryKey = "";

  while (!params.signal.aborted) {
    try {
      const [requests, devices] = await Promise.all([
        listControllerProviderRequests({
          projectId: params.projectId,
          providerId: params.providerId,
          statuses: ["pending", "claimed", "failed", "expired"],
          limit: 6,
        }),
        listControllerProviderDevices({
          projectId: params.projectId,
          providerId: params.providerId,
          limit: 4,
        }),
      ]);
      const device =
        devices.find(
          (entry) =>
            entry.providerId.trim().toLowerCase() === params.providerId.trim().toLowerCase(),
        ) ?? null;
      const summary = resolveCameraRemoteRequestSummary({
        requests,
        selectedDevice: params.selectedDevice,
        device,
      });
      if (shouldEmitRemoteRequestSummary(summary)) {
        const nextSummaryKey = createRemoteRequestSummaryKey(summary);
        if (nextSummaryKey !== previousSummaryKey) {
          previousSummaryKey = nextSummaryKey;
          params.onSummary(summary);
        }
      }
    } catch {
      // Ignore monitoring errors and fall back to the final tool-call result.
    }

    await waitForRemoteCameraPoll(REMOTE_CAMERA_REQUEST_POLL_INTERVAL_MS, params.signal);
  }
}

async function captureRemoteProviderPhoto(
  options?: CameraProviderClientOptions & {
    lens?: CameraLensId | null;
  },
): Promise<CameraProviderCaptureResponse<CameraCaptureResult>> {
  const projectId = options?.projectId?.trim() ?? "";
  const providerId = resolveCameraProviderId(options);
  const preferredLens =
    options?.lens ?? (await resolveNativeCameraPreferredLens(options)) ?? "rear";
  const selectedDevice =
    typeof options?.onRemoteRequestSummary === "function"
      ? await resolveRemoteCameraSelectedDevice(options)
      : null;
  const summaryAbortController =
    typeof options?.onRemoteRequestSummary === "function"
      ? new AbortController()
      : null;
  const summaryMonitor =
    summaryAbortController && typeof options?.onRemoteRequestSummary === "function"
      ? monitorRemoteCameraRequestSummaries({
          projectId,
          providerId,
          selectedDevice,
          onSummary: options.onRemoteRequestSummary,
          signal: summaryAbortController.signal,
        })
      : null;

  const response = await dispatchControllerProviderToolCall<CameraCaptureResult>({
    projectId,
    providerId,
    name: CAMERA_CAPTURE_PHOTO_TOOL_ID,
    argumentsValue: {
      lens: preferredLens,
    },
    timeoutMs: 75_000,
  }).finally(async () => {
    summaryAbortController?.abort();
    await summaryMonitor?.catch(() => {});
  });
  if (!response.ok || !response.value) {
    throw new Error(
      response.error?.trim() || `Camera provider ${providerId} did not return a remote capture payload.`,
    );
  }
  return {
    result: response.value,
    executionContext: response.executionContext,
  };
}

async function captureRemoteProviderPhotoSeries(
  options?: CameraProviderClientOptions & {
    lens?: CameraLensId | null;
    count?: number | null;
  },
): Promise<CameraProviderCaptureResponse<CameraCaptureSeriesResult>> {
  const projectId = options?.projectId?.trim() ?? "";
  const providerId = resolveCameraProviderId(options);
  const preferredLens =
    options?.lens ?? (await resolveNativeCameraPreferredLens(options)) ?? "rear";
  const count =
    typeof options?.count === "number" && Number.isFinite(options.count)
      ? Math.max(1, Math.min(5, Math.round(options.count)))
      : 3;
  const selectedDevice =
    typeof options?.onRemoteRequestSummary === "function"
      ? await resolveRemoteCameraSelectedDevice(options)
      : null;
  const summaryAbortController =
    typeof options?.onRemoteRequestSummary === "function"
      ? new AbortController()
      : null;
  const summaryMonitor =
    summaryAbortController && typeof options?.onRemoteRequestSummary === "function"
      ? monitorRemoteCameraRequestSummaries({
          projectId,
          providerId,
          selectedDevice,
          onSummary: options.onRemoteRequestSummary,
          signal: summaryAbortController.signal,
        })
      : null;

  const response = await dispatchControllerProviderToolCall<CameraCaptureSeriesResult>({
    projectId,
    providerId,
    name: CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
    argumentsValue: {
      lens: preferredLens,
      count,
    },
    timeoutMs: 90_000,
  }).finally(async () => {
    summaryAbortController?.abort();
    await summaryMonitor?.catch(() => {});
  });
  if (!response.ok || !response.value) {
    throw new Error(
      response.error?.trim() ||
        `Camera provider ${providerId} did not return a remote photo-series payload.`,
    );
  }
  return {
    result: response.value,
    executionContext: response.executionContext,
  };
}

export async function captureProviderPhoto(
  options?: CameraProviderClientOptions & {
    lens?: CameraLensId | null;
  },
): Promise<CameraProviderCaptureResponse<CameraCaptureResult>> {
  // Virtual-camera test seam short-circuit, at the LOWEST capture level like
  // the voice seam: when the page-global seam is armed, capture directly and
  // skip provider resolution entirely. The seam's synthetic identity
  // (camera:virtual-camera-test) never matches an attached project provider
  // id, so without this short-circuit project-scoped runs would fall through
  // to remote capture or an outright denial instead of the armed virtual
  // capture.
  if (isVirtualCameraCaptureTestArmed()) {
    const result = await captureNativeCameraPhoto({
      lens: options?.lens ?? undefined,
    });
    return {
      result,
      executionContext: createNativeCameraExecutionContext(
        result.providerId?.trim() || resolveCameraProviderId(options) || CAMERA_PROVIDER_ID,
        result,
      ),
    };
  }

  const preferredLens =
    options?.lens ?? (await resolveNativeCameraPreferredLens(options)) ?? "rear";

  if (await maybeUseNativeCameraCapture(options)) {
    const result = await captureNativeCameraPhoto({
      lens: preferredLens,
    });
    return {
      result,
      executionContext: createNativeCameraExecutionContext(
        resolveCameraProviderId(options) || result.providerId?.trim() || CAMERA_PROVIDER_ID,
        result,
      ),
    };
  }

  if (await shouldPreferRemoteCameraCapture(options)) {
    return captureRemoteProviderPhoto({
      ...options,
      lens: preferredLens,
    });
  }

  const context = await resolveCameraProviderContext(options).catch(() => null);
  if (context) {
    const response = await callLocalProviderTool<CameraCaptureResult>(
      context.providerId,
      context.toolAliases.capturePhoto,
      {
        lens: preferredLens,
      },
    );
    if (!response.value) {
      throw new Error(`Camera provider ${context.providerId} did not return a capture payload.`);
    }
    return {
      result: response.value,
      executionContext: response.executionContext,
    };
  }

  if (canUseRemoteCameraProvider(options)) {
    return captureRemoteProviderPhoto({
      ...options,
      lens: preferredLens,
    });
  }

  throw createMissingCameraProviderError();
}

export async function captureProviderPhotoSeries(
  options?: CameraProviderClientOptions & {
    lens?: CameraLensId | null;
    count?: number | null;
  },
): Promise<CameraProviderCaptureResponse<CameraCaptureSeriesResult>> {
  const count =
    typeof options?.count === "number" && Number.isFinite(options.count)
      ? Math.max(1, Math.min(5, Math.round(options.count)))
      : 3;

  // Same virtual-camera seam short-circuit as captureProviderPhoto: an armed
  // seam must win before any provider resolution (see the comment there).
  if (isVirtualCameraCaptureTestArmed()) {
    const result = await captureNativeCameraPhotoSeries({
      lens: options?.lens ?? undefined,
      count,
    });
    return {
      result,
      executionContext: createNativeCameraExecutionContext(
        result.providerId?.trim() || resolveCameraProviderId(options) || CAMERA_PROVIDER_ID,
        result,
      ),
    };
  }

  const preferredLens =
    options?.lens ?? (await resolveNativeCameraPreferredLens(options)) ?? "rear";

  if (await maybeUseNativeCameraCapture(options)) {
    const result = await captureNativeCameraPhotoSeries({
      lens: preferredLens,
      count,
    });
    return {
      result,
      executionContext: createNativeCameraExecutionContext(
        resolveCameraProviderId(options) || result.providerId?.trim() || CAMERA_PROVIDER_ID,
        result,
      ),
    };
  }

  if (await shouldPreferRemoteCameraCapture(options)) {
    return captureRemoteProviderPhotoSeries({
      ...options,
      lens: preferredLens,
      count,
    });
  }

  const context = await resolveCameraProviderContext(options).catch(() => null);
  if (context) {
    const response = await callLocalProviderTool<CameraCaptureSeriesResult>(
      context.providerId,
      context.toolAliases.capturePhotoSeries,
      {
        lens: preferredLens,
        count,
      },
    );
    if (!response.value) {
      throw new Error(
        `Camera provider ${context.providerId} did not return a photo-series payload.`,
      );
    }
    return {
      result: response.value,
      executionContext: response.executionContext,
    };
  }

  if (canUseRemoteCameraProvider(options)) {
    return captureRemoteProviderPhotoSeries({
      ...options,
      lens: preferredLens,
      count,
    });
  }

  throw createMissingCameraProviderError();
}
