import { lazy, Suspense, useEffect, useState } from "react";
import { CAMERA_PROVIDER_FAMILY } from "@instafy/provider-contract/builtins";
import { getNativeCameraStatus } from "../../camera/nativeCameraBridge";
import type { ProjectProviderCameraState } from "../../camera/cameraProjectState";
import type { CameraStatusSnapshot } from "../../camera/types";
import {
  createNativeExtensionRegistration,
  ExtensionHealthSummaryBlock,
  formatSavedNativeDeviceLabel,
  formatSavedNativeDeviceValue,
} from "../nativeExtensionRegistrationFactory";
import type {
  NativeExtensionRegistration,
  NativeExtensionSummary,
  NativeExtensionSummaryProps,
} from "../nativeExtensionTypes";

const CameraNativeDiagnosticsPanel = lazy(async () => {
  const module = await import("../../camera/CameraNativeDiagnosticsPanel");
  return { default: module.CameraNativeDiagnosticsPanel };
});

function formatCameraCaptureLabel(capture: ProjectProviderCameraState["lastCapture"]) {
  if (!capture) {
    return "No test photo yet.";
  }
  const dimensions =
    typeof capture.width === "number" && typeof capture.height === "number"
      ? `${capture.width}×${capture.height}`
      : "unknown size";
  return `${capture.lens} lens · ${dimensions}`;
}

function formatCameraSummary(
  status: CameraStatusSnapshot | null,
  cameraState: ProjectProviderCameraState,
  attached: boolean,
): NativeExtensionSummary {
  const lastCapture = status?.lastCapture ?? cameraState.lastCapture;
  const selectedLens = status?.selectedLens ?? cameraState.selectedLens;

  if (lastCapture) {
    return {
      tone: "secondary",
      text: `Latest test photo · ${formatCameraCaptureLabel(lastCapture)}.`,
    };
  }

  if (!status) {
    return {
      tone: "warning",
      text: attached
        ? "Open setup to enable camera access."
        : "Open setup to use this camera.",
    };
  }

  if (!status.supported) {
    return {
      tone: "warning",
      text: "Use Android, iPhone, or Instafy Desktop.",
    };
  }

  if (!status.permissionGranted) {
    return {
      tone: "warning",
      text: attached
        ? "Enable camera access."
        : "Enable camera access to use this camera.",
    };
  }

  return {
    tone: "secondary",
    text: selectedLens ? `Ready · ${selectedLens} lens.` : "Camera ready.",
  };
}

function CameraExtensionHealthSummary(props: NativeExtensionSummaryProps) {
  const [resolvedStatus, setResolvedStatus] = useState<CameraStatusSnapshot | null>(
    props.cameraLiveStatus ?? null,
  );
  const [resolvedCheckedAt, setResolvedCheckedAt] = useState<string | null>(
    props.cameraLiveCheckedAt ?? null,
  );

  useEffect(() => {
    setResolvedStatus(props.cameraLiveStatus ?? null);
    setResolvedCheckedAt(props.cameraLiveCheckedAt ?? null);
  }, [props.cameraLiveCheckedAt, props.cameraLiveStatus]);

  useEffect(() => {
    if (!props.refreshNativeCameraStatus) {
      return;
    }

    let cancelled = false;

    const refreshStatus = async () => {
      const nextStatus = await getNativeCameraStatus().catch(() => null);
      if (!nextStatus || cancelled) {
        return;
      }
      setResolvedStatus(nextStatus);
      setResolvedCheckedAt(new Date().toISOString());
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshStatus();
      }
    };
    const handleWindowFocus = () => {
      void refreshStatus();
    };

    void refreshStatus();
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [props.refreshNativeCameraStatus]);

  const summary = formatCameraSummary(
    resolvedStatus,
    props.cameraState,
    props.attached,
  );

  return (
    <ExtensionHealthSummaryBlock
      providerId={props.providerId}
      summary={summary}
      checkedAt={resolvedCheckedAt}
    />
  );
}

export const CAMERA_NATIVE_EXTENSION_REGISTRATION: NativeExtensionRegistration =
  createNativeExtensionRegistration({
    family: CAMERA_PROVIDER_FAMILY,
    formatDefaultCaption() {
      return "Preferred for new photos.";
    },
    formatSavedStateLabel({ selectedDevice, cameraState }) {
      const deviceValue = formatSavedNativeDeviceValue(selectedDevice);
      const captureLabel = cameraState.lastCapture
        ? `Last capture: ${formatCameraCaptureLabel(cameraState.lastCapture)}`
        : null;
      if (deviceValue && captureLabel) {
        const labelPrefix =
          CAMERA_PROVIDER_FAMILY.extension?.nativeRuntimeUi?.savedDeviceLabel ?? "Saved device";
        return `${labelPrefix}: ${deviceValue} · ${captureLabel}`;
      }
      if (deviceValue) {
        return formatSavedNativeDeviceLabel(CAMERA_PROVIDER_FAMILY, selectedDevice);
      }
      return captureLabel;
    },
    summarize({ attached, cameraState, cameraLiveStatus }) {
      return formatCameraSummary(cameraLiveStatus ?? null, cameraState, attached);
    },
    renderSummary(props) {
      return <CameraExtensionHealthSummary {...props} />;
    },
    renderSetupPanel({
      providerId,
      attached,
      developerDetailsDefault,
      allowDeveloperToggle,
      surfaceCoverage,
      cameraState,
      savePending,
      onPersistCameraState,
      onCameraStatusChange,
    }) {
      return (
        <Suspense fallback={null}>
          <CameraNativeDiagnosticsPanel
            providerId={providerId}
            attached={attached}
            className="mt-0"
            testIdPrefix={`project-provider-camera-native-${providerId}`}
            compact
            embedded
            developerDetailsDefault={developerDetailsDefault}
            allowDeveloperToggle={allowDeveloperToggle}
            surfaceCoverage={surfaceCoverage}
            savedLens={cameraState.selectedLens}
            savedCapture={cameraState.lastCapture}
            persistPending={savePending}
            onPersistState={onPersistCameraState}
            onStatusChange={onCameraStatusChange}
          />
        </Suspense>
      );
    },
  });
