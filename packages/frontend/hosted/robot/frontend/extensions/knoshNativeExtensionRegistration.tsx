import { lazy, Suspense } from "react";
import { KNOSH_PROVIDER_FAMILY } from "../../provider/family.mjs";
import type { KnoshSavedDevice } from "../screens/studio/components/KnoshNativeDiagnosticsPanel";
import { postProbe, type RobotPowerStatusValue } from "../robot";
import type { KnoshRuntimeStatus } from "../robot/knoshRuntimeAdapter";
import {
  createNativeExtensionRegistration,
  renderStaticExtensionHealthSummary,
} from "@instafy/frontend/feature-api";
import type {
  NativeExtensionRegistration,
  NativeExtensionSummary,
  NativeExtensionSummaryProps,
} from "@instafy/frontend/feature-api";

const KnoshNativeDiagnosticsPanel = lazy(async () => {
  const module = await import(
    "../screens/studio/components/KnoshNativeDiagnosticsPanel"
  );
  return { default: module.KnoshNativeDiagnosticsPanel };
});

function parseJsonRecord(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asKnoshRuntimeStatus(value: unknown): KnoshRuntimeStatus | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as KnoshRuntimeStatus)
    : null;
}

function asRobotPowerStatus(value: unknown): RobotPowerStatusValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RobotPowerStatusValue)
    : null;
}

function formatKnoshSummary(
  status: KnoshRuntimeStatus | null,
  powerStatus: RobotPowerStatusValue | null | undefined,
  selectedDevice: NativeExtensionSummaryProps["selectedDevice"],
  attached: boolean,
): NativeExtensionSummary {
  const batterySuffix =
    typeof powerStatus?.battery_voltage_v === "number" && Number.isFinite(powerStatus.battery_voltage_v)
      ? ` · ${powerStatus.battery_voltage_v.toFixed(2)}V`
      : "";
  const faultCount = Array.isArray(powerStatus?.fault_flags) ? powerStatus.fault_flags.length : 0;
  const faultSuffix = faultCount > 0 ? ` · ${faultCount} fault flag${faultCount === 1 ? "" : "s"}` : "";
  const watchdogSuffix =
    typeof powerStatus?.watchdog_state === "string" && powerStatus.watchdog_state.trim().length > 0
      ? powerStatus.watchdog_state === "ok"
        ? ""
        : ` · Watchdog ${powerStatus.watchdog_state}`
      : "";

  if (!status) {
    return {
      tone: selectedDevice && !attached ? "muted" : "warning",
      text: selectedDevice
        ? attached
          ? "Reconnect saved board before control."
          : "Saved board ready to reconnect."
        : attached
          ? "Open setup to connect."
          : "Open setup to connect to Knosh.",
    };
  }

  if (!status.supported) {
    return {
      tone: "muted",
      text: "Use a Bluetooth-capable phone or desktop.",
    };
  }

  if (!status.bleSupported) {
    return {
      tone: "warning",
      text: "Bluetooth LE is unavailable here.",
    };
  }

  if (!status.bluetoothEnabled) {
    return {
      tone: "warning",
      text: "Turn on Bluetooth.",
    };
  }

  if (status.connection.ready) {
    const parsedStatus = parseJsonRecord(status.connection.lastStatusText ?? null);
    const robotId =
      parsedStatus && typeof parsedStatus.robot_id === "string" ? parsedStatus.robot_id : null;
    const controller =
      parsedStatus && typeof parsedStatus.controller === "string" ? parsedStatus.controller : null;
    return {
      tone: "secondary",
      text: `Connected${robotId ? ` · ${robotId}` : ""}${controller ? ` · ${controller}` : ""}${batterySuffix}${faultSuffix}${watchdogSuffix}.`,
    };
  }

  if (selectedDevice) {
    return {
      tone: attached ? "warning" : "muted",
      text: attached
        ? "Reconnect saved board before control."
        : "Saved board ready to reconnect.",
    };
  }

  return {
    tone: attached ? "warning" : "muted",
    text: attached ? "Open setup to connect." : "Open setup to connect to Knosh.",
  };
}

export const KNOSH_NATIVE_EXTENSION_REGISTRATION: NativeExtensionRegistration =
  createNativeExtensionRegistration({
    family: KNOSH_PROVIDER_FAMILY,
    runRuntimeProbe({ projectId, provider }) {
      return postProbe(
        {
          sessionId: "instafy-extensions-knosh-runtime-probe",
          readStatus: true,
          drainPending: true,
          skipCommand: false,
          commandJson: {
            name: "stop_all_motion",
          },
          source: "instafy_extensions_knosh_runtime_probe",
        },
        {
          projectId,
          providerId: provider.id,
          provider,
        },
      );
    },
    summarize({ attached, selectedDevice, runtimeStatus, auxiliaryStatus }) {
      return formatKnoshSummary(
        asKnoshRuntimeStatus(runtimeStatus),
        asRobotPowerStatus(auxiliaryStatus),
        selectedDevice,
        attached,
      );
    },
    renderSummary({
      providerId,
      attached,
      selectedDevice,
      runtimeStatus,
      runtimeStatusCheckedAt,
      auxiliaryStatus,
      auxiliaryStatusCheckedAt,
    }) {
      return renderStaticExtensionHealthSummary({
        providerId,
        summary: formatKnoshSummary(
          asKnoshRuntimeStatus(runtimeStatus),
          asRobotPowerStatus(auxiliaryStatus),
          selectedDevice,
          attached,
        ),
        checkedAt: auxiliaryStatusCheckedAt ?? runtimeStatusCheckedAt,
      });
    },
    renderSetupPanel({
      providerId,
      developerDetailsDefault,
      allowDeveloperToggle,
      surfaceCoverage,
      selectedDevice,
      savePending,
      onSaveConnectedDevice,
      onForgetSavedDevice,
      onRunRuntimeProbe,
      onRuntimeStatusChange,
      onAuxiliaryStatusChange,
    }) {
      const savedDevice: KnoshSavedDevice | null =
        selectedDevice && selectedDevice.identifier
          ? {
              transport: selectedDevice.transport,
              identifier: selectedDevice.identifier,
              address: selectedDevice.address,
              name: selectedDevice.name,
              nativePlatform: selectedDevice.nativePlatform,
              savedAt: selectedDevice.savedAt,
              lastConnectedAt: selectedDevice.lastConnectedAt,
            }
          : null;

      return (
        <Suspense fallback={null}>
          <KnoshNativeDiagnosticsPanel
            providerId={providerId}
            className="mt-0"
            testIdPrefix={`project-provider-knosh-native-${providerId}`}
            compact
            embedded
            developerDetailsDefault={developerDetailsDefault}
            allowDeveloperToggle={allowDeveloperToggle}
            surfaceCoverage={surfaceCoverage}
            savedDevice={savedDevice}
            savePending={savePending}
            onSaveConnectedDevice={onSaveConnectedDevice}
            onForgetSavedDevice={onForgetSavedDevice}
            onRunRuntimeProbe={onRunRuntimeProbe}
            onStatusChange={onRuntimeStatusChange}
            onPowerStatusChange={onAuxiliaryStatusChange}
          />
        </Suspense>
      );
    },
  });
