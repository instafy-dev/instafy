import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Text } from "../components/Text";
import {
  captureNativeCameraPhoto,
  captureNativeCameraPhotoSeries,
  getNativeCameraStatus,
  openNativeCameraSettings,
  requestNativeCameraPermissions,
} from "./nativeCameraBridge";
import { createNativeCameraExecutionContext } from "./cameraBridgeClient";
import type { NativeExtensionSurfaceCoverage } from "../extensions/nativeExtensionTypes";
import {
  NativeExtensionActionRow,
  NativeExtensionDeveloperPanel,
  NativeExtensionMetaLine,
  NativeExtensionSetupStatus,
} from "../extensions/nativeExtensionSetupUi";
import type {
  CameraCaptureMetadata,
  CameraCaptureResult,
  CameraCaptureSeriesResult,
  CameraLensId,
  CameraStatusSnapshot,
} from "./types";
import { createCameraObservationProviderEvent } from "../extensions/providerEvents";
import { dispatchObservedProviderEvents } from "../extensions/providerEventChannel";

type CameraNativeDiagnosticsPanelProps = {
  providerId?: string;
  attached?: boolean;
  className?: string;
  testIdPrefix?: string;
  compact?: boolean;
  embedded?: boolean;
  developerDetailsDefault?: boolean;
  allowDeveloperToggle?: boolean;
  surfaceCoverage?: NativeExtensionSurfaceCoverage;
  savedLens?: CameraLensId | null;
  savedCapture?: CameraCaptureMetadata | null;
  persistPending?: boolean;
  onPersistState?: (state: {
    selectedLens?: CameraLensId | null;
    lastCapture?: CameraCaptureMetadata | null;
  }) => Promise<void> | void;
  onStatusChange?: (providerId: string, status: CameraStatusSnapshot | null) => void;
};

type PendingAction = "refresh" | "permissions" | "settings" | "capture" | "series" | "save_lens" | null;

type DiagnosticsOutput = CameraStatusSnapshot | CameraCaptureResult | CameraCaptureSeriesResult | null;

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatPermissionTone(status: CameraStatusSnapshot | null) {
  if (!status) {
    return "warning" as const;
  }
  if (status?.permissionGranted) {
    return "success" as const;
  }
  if (status?.permission === "prompt" || status?.permission === "prompt-with-rationale") {
    return "warning" as const;
  }
  return "danger" as const;
}

function formatPermissionTextTone(status: CameraStatusSnapshot | null) {
  if (!status) {
    return "muted" as const;
  }
  const tone = formatPermissionTone(status);
  return tone === "danger" ? "danger" : tone === "warning" ? "warning" : "success";
}

function formatPermissionLabel(status: CameraStatusSnapshot | null) {
  if (!status) {
    return "Checking camera";
  }
  switch (status?.permission) {
    case "granted":
      return "Ready";
    case "prompt":
      return "Needs camera access";
    case "prompt-with-rationale":
      return "Explain access";
    case "restricted":
      return "Access restricted";
    case "denied":
    default:
      return "Access blocked";
  }
}

function formatLensLabel(lens: CameraLensId | null | undefined) {
  if (lens === "front") {
    return "Front lens";
  }
  if (lens === "external") {
    return "External lens";
  }
  return "Rear lens";
}

function resolvePreferredLens(
  status: CameraStatusSnapshot | null,
  savedLens: CameraLensId | null | undefined,
): CameraLensId {
  if (savedLens) {
    return savedLens;
  }
  if (status?.selectedLens) {
    return status.selectedLens;
  }
  if (status?.availableLenses.some((lens) => lens.id === "rear")) {
    return "rear";
  }
  if (status?.availableLenses.some((lens) => lens.id === "external")) {
    return "external";
  }
  return "front";
}

function formatCaptureSummary(capture: CameraCaptureMetadata | null | undefined) {
  if (!capture) {
    return "No test photo yet.";
  }
  const dimensions =
    typeof capture.width === "number" && typeof capture.height === "number"
      ? `${capture.width}×${capture.height}`
      : "unknown size";
  return `${formatLensLabel(capture.lens)} · ${dimensions}`;
}

function formatCameraStatusDetail(input: {
  status: CameraStatusSnapshot | null;
  selectedLens: CameraLensId;
  effectiveCapture: CameraCaptureMetadata | null;
  isDesktopCameraRuntime: boolean;
  permissionRequiresSettings: boolean;
  permissionIsRestricted: boolean;
}) {
  if (!input.status) {
    return "Checking camera access.";
  }

  if (input.status?.permissionGranted) {
    if (input.effectiveCapture) {
      return `Latest test photo · ${formatCaptureSummary(input.effectiveCapture)}.`;
    }
    return `${formatLensLabel(input.selectedLens)} selected.`;
  }

  if (input.status?.supported === false) {
    return "Use Android, iPhone, or Instafy Desktop.";
  }

  if (input.permissionIsRestricted) {
    return "Camera access is restricted.";
  }

  if (input.permissionRequiresSettings) {
    return "Permission was denied. Open settings to allow camera access.";
  }

  return "Camera access is required before capture.";
}

function formatEmbeddedCameraSummary(input: {
  status: CameraStatusSnapshot | null;
  effectiveCapture: CameraCaptureMetadata | null;
  attached: boolean;
  permissionRequiresSettings: boolean;
  permissionIsRestricted: boolean;
}) {
  if (!input.status) {
    return input.attached ? "Checking camera access." : "Checking this camera.";
  }

  if (input.status?.permissionGranted) {
    if (input.effectiveCapture) {
      return "Latest test photo ready.";
    }
    return input.attached ? "Camera ready." : "Ready to use as camera.";
  }

  if (input.status?.supported === false) {
    return "Use Android, iPhone, or Instafy Desktop.";
  }

  if (input.permissionIsRestricted) {
    return "Camera access is restricted. Check device settings.";
  }

  if (input.permissionRequiresSettings) {
    return "Enable camera access in Settings.";
  }

  return "Enable camera access.";
}

export function CameraNativeDiagnosticsPanel({
  providerId = "camera",
  attached = false,
  className,
  testIdPrefix = "diagnostics-camera",
  compact = false,
  embedded = false,
  developerDetailsDefault = false,
  allowDeveloperToggle = true,
  surfaceCoverage,
  savedLens = null,
  savedCapture = null,
  persistPending = false,
  onPersistState,
  onStatusChange,
}: CameraNativeDiagnosticsPanelProps) {
  const platform = Capacitor.getPlatform();
  const isNativeMobile = platform === "android" || platform === "ios";
  const [status, setStatus] = useState<CameraStatusSnapshot | null>(null);
  const [output, setOutput] = useState<DiagnosticsOutput>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDeveloperDetails, setShowDeveloperDetails] = useState(
    developerDetailsDefault || !compact,
  );
  const [selectedLens, setSelectedLens] = useState<CameraLensId>(savedLens ?? "rear");
  const actionAreaRef = useRef<HTMLDivElement | null>(null);

  const buildTestId = useCallback(
    (suffix: string) => `${testIdPrefix}-${suffix}`,
    [testIdPrefix],
  );

  const isDesktopCameraRuntime =
    status?.platform === "desktop" ||
    (platform === "web" && typeof window !== "undefined" && Boolean(window.instafyDesktop));
  const effectiveCapture = status?.lastCapture ?? savedCapture ?? null;
  const isBusy = pendingAction !== null || persistPending;
  const permissionRequiresSettings = isNativeMobile && status?.permission === "denied";
  const permissionIsRestricted = isNativeMobile && status?.permission === "restricted";

  const commitStatus = useCallback(
    (nextStatus: CameraStatusSnapshot | null) => {
      setStatus(nextStatus);
      onStatusChange?.(providerId, nextStatus);
    },
    [onStatusChange, providerId],
  );

  const refreshStatus = useCallback(async () => {
    setPendingAction("refresh");
    setError(null);
    try {
      const nextStatus = await getNativeCameraStatus();
      commitStatus(nextStatus);
      setSelectedLens(resolvePreferredLens(nextStatus, savedLens));
      setOutput(nextStatus);
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, savedLens]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    setShowDeveloperDetails(developerDetailsDefault || !compact);
  }, [compact, developerDetailsDefault]);

  useEffect(() => {
    if (!compact || !embedded || typeof window === "undefined") {
      return;
    }
    const viewportIsCompact =
      window.matchMedia?.("(max-width: 767px)").matches ||
      window.matchMedia?.("(pointer: coarse)").matches;
    if (!viewportIsCompact) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      actionAreaRef.current?.scrollIntoView({
        block: "end",
        inline: "nearest",
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [compact, embedded]);

  const handleRequestPermissions = useCallback(async () => {
    setPendingAction("permissions");
    setError(null);
    try {
      const nextStatus = await requestNativeCameraPermissions();
      commitStatus(nextStatus);
      setOutput(nextStatus);
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus]);

  const handleOpenSettings = useCallback(async () => {
    setPendingAction("settings");
    setError(null);
    try {
      const nextStatus = await openNativeCameraSettings();
      commitStatus(nextStatus);
      setOutput(nextStatus);
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus]);

  const persistState = useCallback(
    async (state: { selectedLens?: CameraLensId | null; lastCapture?: CameraCaptureMetadata | null }) => {
      if (!onPersistState) {
        return;
      }
      await onPersistState(state);
    },
    [onPersistState],
  );

  const handleSelectLens = useCallback(
    async (lens: CameraLensId) => {
      setSelectedLens(lens);
      if (!onPersistState) {
        return;
      }
      setPendingAction("save_lens");
      setError(null);
      try {
        await persistState({
          selectedLens: lens,
        });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setPendingAction(null);
      }
    },
    [onPersistState, persistState],
  );

  const handleCapture = useCallback(async () => {
    setPendingAction("capture");
    setError(null);
    try {
      const result = await captureNativeCameraPhoto({
        lens: selectedLens,
      });
      commitStatus(result);
      setOutput(result);
      if (result.error) {
        setError(result.error);
      } else if (result.capture) {
        const observedProviderId = result.providerId?.trim() || providerId;
        dispatchObservedProviderEvents([
          createCameraObservationProviderEvent({
            providerId: observedProviderId,
            providerType: "phone_camera",
            executionContext: createNativeCameraExecutionContext(observedProviderId, result),
            mode: "single",
            lens: selectedLens,
            requestedCount: 1,
            completedCount: 1,
            capture: result.capture,
          }),
        ]);
        await persistState({
          selectedLens,
          lastCapture: result.capture,
        });
        const refreshedStatus = await getNativeCameraStatus();
        const reconciledStatus = refreshedStatus.lastCapture
          ? refreshedStatus
          : {
              ...refreshedStatus,
              lastCapture: result.capture,
            };
        commitStatus(reconciledStatus);
        setOutput(reconciledStatus);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, persistState, providerId, selectedLens]);

  const handleCaptureSeries = useCallback(async () => {
    setPendingAction("series");
    setError(null);
    try {
      const result = await captureNativeCameraPhotoSeries({
        lens: selectedLens,
        count: 3,
      });
      commitStatus(result);
      setOutput(result);
      if (result.error) {
        setError(result.error);
      } else if (result.captures.length > 0) {
        const observedProviderId = result.providerId?.trim() || providerId;
        const latestCapture = result.captures[result.captures.length - 1] ?? null;
        dispatchObservedProviderEvents([
          createCameraObservationProviderEvent({
            providerId: observedProviderId,
            providerType: "phone_camera",
            executionContext: createNativeCameraExecutionContext(observedProviderId, result),
            mode: "series",
            lens: selectedLens,
            requestedCount: result.requestedCount,
            completedCount: result.completedCount,
            capture: latestCapture,
            captures: result.captures,
          }),
        ]);
        await persistState({
          selectedLens,
          lastCapture: latestCapture,
        });
        const refreshedStatus = await getNativeCameraStatus();
        const reconciledStatus = refreshedStatus.lastCapture || !latestCapture
          ? refreshedStatus
          : {
              ...refreshedStatus,
              lastCapture: latestCapture,
            };
        commitStatus(reconciledStatus);
        setOutput(reconciledStatus);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, persistState, providerId, selectedLens]);

  const availableLenses = useMemo(() => {
    if (status?.availableLenses.length) {
      return status.availableLenses.map((lens) => lens.id);
    }
    if (isDesktopCameraRuntime) {
      return ["external"] as CameraLensId[];
    }
    return (["rear", "front"] as CameraLensId[]).filter((lens) => lens === "rear" || isNativeMobile);
  }, [isDesktopCameraRuntime, isNativeMobile, status?.availableLenses]);

  const embeddedShellOwnsSummary =
    compact && embedded && Boolean(surfaceCoverage && Object.values(surfaceCoverage).some(Boolean));
  const showSummaryText = !embeddedShellOwnsSummary && status !== null;
  const showLensControls = status?.permissionGranted === true || showDeveloperDetails || !compact;
  const showRefreshAction =
    !compact ||
    showDeveloperDetails ||
    status === null ||
    permissionRequiresSettings ||
    permissionIsRestricted ||
    error !== null ||
    pendingAction === "refresh";
  const cameraUnavailable = status?.supported === false;
  const summaryText = formatEmbeddedCameraSummary({
    status,
    effectiveCapture,
    attached,
    permissionRequiresSettings,
    permissionIsRestricted,
  });
  const statusDetail = formatCameraStatusDetail({
    status,
    selectedLens,
    effectiveCapture,
    isDesktopCameraRuntime,
    permissionRequiresSettings,
    permissionIsRestricted,
  });
  const developerPanel = showDeveloperDetails ? (
    <NativeExtensionDeveloperPanel
      testId={buildTestId("developer-panel")}
      rawOutput={formatJson(output ?? status ?? { supported: false })}
      outputTestId={buildTestId("output")}
    >
      <NativeExtensionMetaLine className="text-xs">
        Native runtime: {platform}
      </NativeExtensionMetaLine>
      {savedCapture ? (
        <NativeExtensionMetaLine className="text-xs">
          Saved capture: {formatCaptureSummary(savedCapture)}
        </NativeExtensionMetaLine>
      ) : null}
    </NativeExtensionDeveloperPanel>
  ) : null;

  const content = (
    <div className="space-y-3">
      <div ref={actionAreaRef} className="space-y-1">
        <NativeExtensionSetupStatus
          title={formatPermissionLabel(status)}
          detail={statusDetail}
          tone={formatPermissionTextTone(status)}
        />
      </div>

      {showSummaryText ? (
        <Text
          variant="caption"
          tone={
            status?.permissionGranted ? "secondary" : error ? "warning" : "muted"
          }
          data-testid={buildTestId("summary")}
        >
          {summaryText}
        </Text>
      ) : null}

      {showLensControls ? (
        <NativeExtensionActionRow>
          {availableLenses.map((lens) => (
            <Button
              key={lens}
              variant={selectedLens === lens ? "secondary" : "ghost"}
              size="xs"
              radius="full"
              isDisabled={isBusy}
              data-testid={buildTestId(`lens-${lens}`)}
              onPress={() => {
                void handleSelectLens(lens);
              }}
            >
              {formatLensLabel(lens)}
            </Button>
          ))}
        </NativeExtensionActionRow>
      ) : null}

      <NativeExtensionActionRow>
        <Button
          variant="outline"
          size="sm"
          radius="xl"
          isDisabled={isBusy || permissionIsRestricted || cameraUnavailable}
          data-testid={buildTestId("primary-action")}
          onPress={() => {
            void (
              !status
                ? refreshStatus()
                : status.permissionGranted
                ? handleCapture()
                : cameraUnavailable
                  ? Promise.resolve()
                : permissionRequiresSettings
                  ? handleOpenSettings()
                  : permissionIsRestricted
                    ? Promise.resolve()
                    : handleRequestPermissions()
            );
          }}
        >
          {pendingAction === "refresh"
            ? "Checking…"
            : pendingAction === "permissions"
            ? "Allowing…"
            : pendingAction === "settings"
              ? "Opening settings…"
            : pendingAction === "capture"
              ? "Capturing…"
              : !status
                ? "Check camera"
              : cameraUnavailable
                ? "Camera unavailable"
              : status.permissionGranted
                ? "Take test photo"
                : permissionIsRestricted
                  ? "Camera restricted"
                : permissionRequiresSettings
                  ? "Open settings"
                  : "Enable camera access"}
        </Button>
        {showRefreshAction ? (
          <Button
            variant="ghost"
            size="sm"
            radius="xl"
            isDisabled={isBusy}
            data-testid={buildTestId("refresh")}
            onPress={() => {
              void refreshStatus();
            }}
          >
            {pendingAction === "refresh" ? "Checking…" : "Check again"}
          </Button>
        ) : null}
        {(showDeveloperDetails || !compact) ? (
          <Button
            variant="ghost"
            size="sm"
            radius="xl"
            isDisabled={isBusy || !status?.permissionGranted}
            data-testid={buildTestId("capture-series")}
            onPress={() => {
              void handleCaptureSeries();
            }}
          >
            {pendingAction === "series" ? "Capturing…" : "Guided series"}
          </Button>
        ) : null}
      </NativeExtensionActionRow>

      {error ? (
        <Text variant="caption" tone="warning" data-testid={buildTestId("error")}>
          {error}
        </Text>
      ) : null}

      {allowDeveloperToggle ? (
        <div className="space-y-2">
          <Button
            variant="ghost"
            size="xs"
            radius="full"
            data-testid={buildTestId("developer-toggle")}
            onPress={() => {
              setShowDeveloperDetails((current) => !current);
            }}
          >
            {showDeveloperDetails ? "Hide developer details" : "Developer details"}
          </Button>

          {developerPanel}
        </div>
      ) : developerPanel}
    </div>
  );

  if (embedded) {
    return <div className={className}>{content}</div>;
  }

  return (
    <Card className={["border border-slate-200/70 bg-white/80", className].filter(Boolean).join(" ")}>
      <div className="space-y-3">
        {content}
      </div>
    </Card>
  );
}
