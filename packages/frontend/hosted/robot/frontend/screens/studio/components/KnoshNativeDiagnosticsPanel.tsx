import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Text } from "@instafy/frontend/feature-api/ui";
import {
  getKnoshRuntimeAdapter,
  type KnoshRuntimeDebugInfo,
  type KnoshRuntimeCommandResult,
  type KnoshRuntimeStatus,
  type KnoshRuntimeScanResult,
  type KnoshRuntimeStatusReadResult,
} from "../../../robot/knoshRuntimeAdapter";
import {
  fetchRobotPowerStatus,
  type RobotPowerStatusValue,
} from "../../../robot";
import type { NativeExtensionSurfaceCoverage } from "@instafy/frontend/feature-api";
import {
  NativeExtensionActionRow,
  NativeExtensionDeviceCard,
  NativeExtensionDetailCard,
  NativeExtensionMetaLine,
  NativeExtensionRawOutput,
  NativeExtensionSetupStatus,
} from "@instafy/frontend/feature-api/ui";
import { KnoshDesktopNoticeStack } from "./KnoshDesktopNoticeStack";
import { getKnoshDesktopOperatorHints } from "./knoshDesktopOperatorHints";

export type KnoshSavedDevice = {
  transport?: string | null;
  identifier: string;
  address?: string | null;
  name?: string | null;
  nativePlatform?: "android" | "ios" | null;
  savedAt?: string | null;
  lastConnectedAt?: string | null;
};

type KnoshNativeDiagnosticsPanelProps = {
  providerId?: string;
  className?: string;
  testIdPrefix?: string;
  compact?: boolean;
  embedded?: boolean;
  developerDetailsDefault?: boolean;
  allowDeveloperToggle?: boolean;
  surfaceCoverage?: NativeExtensionSurfaceCoverage;
  savedDevice?: KnoshSavedDevice | null;
  savePending?: boolean;
  onSaveConnectedDevice?: (device: {
    transport: string;
    identifier: string;
    address: string;
    name?: string | null;
    nativePlatform?: "android" | "ios" | null;
    connectedAt: string;
  }) => Promise<void> | void;
  onForgetSavedDevice?: () => Promise<void> | void;
  onRunRuntimeProbe?: () => Promise<unknown> | unknown;
  onStatusChange?: (providerId: string, status: KnoshRuntimeStatus | null) => void;
  onPowerStatusChange?: (providerId: string, status: RobotPowerStatusValue | null) => void;
};

type PendingAction =
  | "refresh"
  | "permissions"
  | "scan"
  | "scan_any"
  | "cancel"
  | "connect"
  | "disconnect"
  | "save_device"
  | "forget_device"
  | "runtime_probe"
  | "read_status"
  | "test_command"
  | null;

type DiagnosticsOutput =
  | KnoshRuntimeStatus
  | KnoshRuntimeScanResult
  | KnoshRuntimeStatusReadResult
  | KnoshRuntimeCommandResult
  | Record<string, unknown>
  | null;

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getRuntimeDebugInfo(value: unknown): KnoshRuntimeDebugInfo | null {
  if (!value || typeof value !== "object" || !("debug" in value)) {
    return null;
  }
  const debug = (value as { debug?: KnoshRuntimeDebugInfo | null }).debug;
  return debug ?? null;
}

function resolveKnoshDeviceName(
  device:
    | Pick<KnoshRuntimeScanResult["devices"][number], "name" | "localName">
    | Pick<KnoshSavedDevice, "name">
    | null
    | undefined,
) {
  if (!device) {
    return "Knosh V1";
  }
  if ("localName" in device) {
    return device.name?.trim() || device.localName?.trim() || "Knosh V1";
  }
  return device.name?.trim() || "Knosh V1";
}

function formatKnoshConnectionLabel(status: KnoshRuntimeStatus | null) {
  if (status?.connection.ready) {
    return "Connected";
  }
  if (status?.connection.connected) {
    return "Connected, syncing";
  }
  return "Disconnected";
}

function formatKnoshStatusHeadline(status: KnoshRuntimeStatus | null) {
  if (!status) {
    return "Checking Bluetooth";
  }
  if (!status.bleSupported) {
    return "Bluetooth LE unavailable";
  }
  if (!status.bluetoothEnabled) {
    return "Bluetooth is off";
  }
  if (status.permissions.bluetooth !== "granted") {
    return "Bluetooth needed";
  }
  return formatKnoshConnectionLabel(status);
}

function formatKnoshStatusTone(status: KnoshRuntimeStatus | null) {
  if (status?.connection.ready) {
    return "success" as const;
  }
  if (!status || status.connection.connected) {
    return "secondary" as const;
  }
  if (!status.bleSupported || !status.bluetoothEnabled || status.permissions.bluetooth !== "granted") {
    return "warning" as const;
  }
  return "muted" as const;
}

function formatKnoshStatusDetail(input: {
  status: KnoshRuntimeStatus | null;
  platformLabel: string;
  desktopRuntimeLabel: string | null;
}) {
  if (!input.status) {
    return "Checking Bluetooth.";
  }
  if (!input.status.bleSupported) {
    return "Bluetooth LE is unavailable here.";
  }
  if (!input.status.bluetoothEnabled) {
    return "Turn on Bluetooth before connecting to Knosh.";
  }
  if (input.status.permissions.bluetooth !== "granted") {
    return "Required before connecting to Knosh.";
  }
  if (input.status.scanning) {
    return "Connecting to Knosh.";
  }
  if (input.status.connection.ready) {
    return "Ready for Knosh commands.";
  }
  if (input.status.connection.connected) {
    return "Connected. Syncing board services.";
  }
  return "Ready to connect to Knosh.";
}

function formatBatteryVoltageLabel(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Battery unknown";
  }
  return `Battery ${value.toFixed(2)}V`;
}

function formatFaultFlagsLabel(value: string[] | null | undefined) {
  const faultCount = Array.isArray(value) ? value.length : 0;
  return faultCount > 0 ? `${faultCount} fault flag${faultCount === 1 ? "" : "s"}` : "No fault flags";
}

function getFaultFlagsTone(value: string[] | null | undefined) {
  return Array.isArray(value) && value.length > 0 ? ("danger" as const) : ("success" as const);
}

export function KnoshNativeDiagnosticsPanel({
  providerId = "knosh",
  className,
  testIdPrefix = "diagnostics-knosh",
  compact = false,
  embedded = false,
  developerDetailsDefault = false,
  allowDeveloperToggle = true,
  surfaceCoverage,
  savedDevice = null,
  savePending = false,
  onSaveConnectedDevice,
  onForgetSavedDevice,
  onRunRuntimeProbe,
  onStatusChange,
  onPowerStatusChange,
}: KnoshNativeDiagnosticsPanelProps) {
  const platform = Capacitor.getPlatform();
  const runtime = useMemo(() => getKnoshRuntimeAdapter(platform), [platform]);
  const hasRuntime = runtime !== null;
  const platformLabel =
    platform === "ios" ? "iPhone" : platform === "android" ? "Android" : "Desktop";
  const [status, setStatus] = useState<KnoshRuntimeStatus | null>(null);
  const [scanResult, setScanResult] = useState<KnoshRuntimeScanResult | null>(null);
  const [output, setOutput] = useState<DiagnosticsOutput>(null);
  const [powerStatus, setPowerStatus] = useState<RobotPowerStatusValue | null>(null);
  const [powerStatusError, setPowerStatusError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDeveloperDetails, setShowDeveloperDetails] = useState(
    developerDetailsDefault || !compact,
  );

  const commitStatus = useCallback(
    (nextStatus: KnoshRuntimeStatus | null) => {
      setStatus(nextStatus);
      onStatusChange?.(providerId, nextStatus);
    },
    [onStatusChange, providerId],
  );

  useEffect(() => {
    setShowDeveloperDetails(developerDetailsDefault || !compact);
  }, [compact, developerDetailsDefault]);

  const refreshPowerStatus = useCallback(async () => {
    try {
      const result = await fetchRobotPowerStatus({
        providerId,
        provider: {
          id: providerId,
          title: "Knosh",
        },
      });
      setPowerStatus(result.value ?? null);
      setPowerStatusError(result.error ?? null);
      onPowerStatusChange?.(providerId, result.value ?? null);
    } catch (nextError) {
      setPowerStatus(null);
      setPowerStatusError(nextError instanceof Error ? nextError.message : String(nextError));
      onPowerStatusChange?.(providerId, null);
    }
  }, [onPowerStatusChange, providerId]);

  const refreshStatus = useCallback(async () => {
    if (!runtime) {
      return;
    }
    setPendingAction("refresh");
    setError(null);
    try {
      const nextStatus = await runtime.getStatus();
      commitStatus(nextStatus);
      setOutput(nextStatus);
      await refreshPowerStatus();
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, refreshPowerStatus, runtime]);

  useEffect(() => {
    if (!hasRuntime) {
      return;
    }
    void refreshStatus();
  }, [hasRuntime, refreshStatus]);

  const handleRequestPermissions = useCallback(async () => {
    if (!runtime) {
      return;
    }
    setPendingAction("permissions");
    setError(null);
    try {
      const nextStatus = await runtime.requestPermissions();
      commitStatus(nextStatus);
      setOutput(nextStatus);
      await refreshPowerStatus();
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, refreshPowerStatus, runtime]);

  const handleScan = useCallback(async () => {
    if (!runtime) {
      return;
    }
    setPendingAction("scan");
    setError(null);
    try {
      const result = await runtime.scanDevices({ durationMs: 5000, filterToKnosh: true });
      commitStatus(result);
      setScanResult(result);
      setOutput(result);
      await refreshPowerStatus();
      if (result.error) {
        setError(result.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, refreshPowerStatus, runtime]);

  const handleScanAnyDevice = useCallback(async () => {
    if (!runtime) {
      return;
    }
    setPendingAction("scan_any");
    setError(null);
    try {
      const result = await runtime.scanDevices({ durationMs: 5000, filterToKnosh: false });
      commitStatus(result);
      setScanResult(result);
      setOutput(result);
      await refreshPowerStatus();
      if (result.error) {
        setError(result.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, refreshPowerStatus, runtime]);

  const handleCancelScan = useCallback(async () => {
    if (!runtime) {
      return;
    }
    setPendingAction("cancel");
    setError(null);
    try {
      const result = await runtime.cancelScan();
      commitStatus(result);
      setScanResult(result);
      setOutput(result);
      await refreshPowerStatus();
      if (result.error) {
        setError(result.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, refreshPowerStatus, runtime]);

  const handleConnect = useCallback(async (address: string) => {
    if (!runtime) {
      return;
    }
    setPendingAction("connect");
    setError(null);
    try {
      const nextStatus = await runtime.connectDevice(address);
      commitStatus(nextStatus);
      setOutput(nextStatus);
      await refreshPowerStatus();
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, refreshPowerStatus, runtime]);

  const handleDisconnect = useCallback(async () => {
    if (!runtime) {
      return;
    }
    setPendingAction("disconnect");
    setError(null);
    try {
      const nextStatus = await runtime.disconnectDevice();
      commitStatus(nextStatus);
      setOutput(nextStatus);
      await refreshPowerStatus();
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, refreshPowerStatus, runtime]);

  const handleReadGattStatus = useCallback(async () => {
    if (!runtime) {
      return;
    }
    setPendingAction("read_status");
    setError(null);
    try {
      const result = await runtime.readStatus();
      commitStatus(result);
      setOutput(result);
      await refreshPowerStatus();
      if (result.error) {
        setError(result.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, refreshPowerStatus, runtime]);

  const handleTestCommand = useCallback(async () => {
    if (!runtime) {
      return;
    }
    setPendingAction("test_command");
    setError(null);
    try {
      const result = await runtime.sendSafeTestCommand();
      commitStatus(result);
      setOutput(result);
      await refreshPowerStatus();
      if (result.error) {
        setError(result.error);
      }
    } finally {
      setPendingAction(null);
    }
  }, [commitStatus, refreshPowerStatus, runtime]);

  const scanReady = status?.permissions.scanReady === true && status?.bleSupported === true;
  const connectionReady = status?.connection.ready === true;
  const savedDeviceAddress = useMemo(() => {
    const address = savedDevice?.address?.trim() ?? "";
    if (address.length > 0) {
      return address;
    }
    return savedDevice?.identifier.trim() ?? "";
  }, [savedDevice]);
  const connectedDeviceAddress = status?.connection.deviceAddress?.trim() ?? "";
  const connectedDevice = useMemo(() => {
    if (!connectedDeviceAddress) {
      return null;
    }
    return (
      scanResult?.devices.find((device) => device.address === connectedDeviceAddress) ??
      (savedDeviceAddress === connectedDeviceAddress
        ? {
            address: connectedDeviceAddress,
            name: savedDevice?.name ?? null,
            localName: null,
          }
        : null)
    );
  }, [connectedDeviceAddress, savedDevice?.name, savedDeviceAddress, scanResult?.devices]);
  const connectedDeviceSaved = Boolean(
    connectedDeviceAddress &&
      savedDeviceAddress &&
      connectedDeviceAddress.toLowerCase() === savedDeviceAddress.toLowerCase(),
  );
  const latestOutput = useMemo(() => output ?? scanResult ?? status, [output, scanResult, status]);
  const latestDebugInfo = useMemo(
    () => getRuntimeDebugInfo(latestOutput) ?? getRuntimeDebugInfo(status),
    [latestOutput, status],
  );
  const rootClassName = useMemo(() => {
    const baseClassName = "space-y-3";
    return className?.trim() ? `${baseClassName} ${className.trim()}` : baseClassName;
  }, [className]);
  const showProjectContextLabels = !(compact && embedded);
  const embeddedShellOwnsSavedState = compact && embedded && surfaceCoverage?.savedState === true;
  const embeddedShellOwnsRuntimeStatus =
    compact && embedded && surfaceCoverage?.runtimeStatus === true;
  const showSavedDeviceLabel = !embeddedShellOwnsSavedState;
  const showConnectedDeviceLabel = !embeddedShellOwnsRuntimeStatus;
  const showAdvancedActions = !compact || showDeveloperDetails;
  const showStatusCheckAction = status === null;
  const showPermissionAction = Boolean(status && status.permissions.bluetooth !== "granted");
  const showScanAction = Boolean(status && !showPermissionAction);
  const showCancelScanAction =
    pendingAction === "scan" || pendingAction === "cancel" || status?.scanning === true;
  const buildTestId = useCallback(
    (suffix: string) => `${testIdPrefix}-${suffix}`,
    [testIdPrefix],
  );

  const handleSaveConnectedDevice = useCallback(async () => {
    if (!onSaveConnectedDevice || !connectedDeviceAddress) {
      return;
    }
    setPendingAction("save_device");
    setError(null);
    try {
      await onSaveConnectedDevice({
        transport: "ble",
        identifier: connectedDeviceAddress,
        address: connectedDeviceAddress,
        name:
          connectedDevice?.name?.trim() ||
          connectedDevice?.localName?.trim() ||
          savedDevice?.name?.trim() ||
          null,
        nativePlatform: platform === "android" || platform === "ios" ? platform : null,
        connectedAt: new Date().toISOString(),
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPendingAction(null);
    }
  }, [connectedDevice, connectedDeviceAddress, onSaveConnectedDevice, platform, savedDevice?.name]);

  const handleForgetSavedDevice = useCallback(async () => {
    if (!onForgetSavedDevice) {
      return;
    }
    setPendingAction("forget_device");
    setError(null);
    try {
      await onForgetSavedDevice();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPendingAction(null);
    }
  }, [onForgetSavedDevice]);

  const handleRunRuntimeProbe = useCallback(async () => {
    if (!onRunRuntimeProbe) {
      return;
    }
    setPendingAction("runtime_probe");
    setError(null);
    try {
      const result = await onRunRuntimeProbe();
      if (result !== undefined) {
        setOutput(
          result && typeof result === "object" && !Array.isArray(result)
            ? (result as DiagnosticsOutput | Record<string, unknown>)
            : ({ result } as Record<string, unknown>),
        );
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPendingAction(null);
    }
  }, [onRunRuntimeProbe]);

  if (!hasRuntime) {
    return null;
  }

  const desktopRuntimeLabel =
    runtime?.id === "native_desktop_ble"
      ? "Native desktop bridge"
      : runtime?.id === "web_bluetooth"
        ? "Browser Web Bluetooth"
        : null;
  const statusHeadline = formatKnoshStatusHeadline(status);
  const statusDetail = formatKnoshStatusDetail({
    status,
    platformLabel,
    desktopRuntimeLabel,
  });
  const desktopHints =
    platform === "web"
      ? getKnoshDesktopOperatorHints({
          runtimeId: runtime?.id ?? null,
          status,
          scanResult,
          error,
          debug: latestDebugInfo,
          latestOutput,
        })
      : [];

  const content = (
    <>
      <NativeExtensionSetupStatus
        title={statusHeadline}
        detail={statusDetail}
        tone={formatKnoshStatusTone(status)}
      />

      {!compact || showDeveloperDetails ? (
        <div className="space-y-1">
          <Text as="p" variant="caption" tone="muted" className="text-xxs">
            Expected device: {status?.expectedDeviceName ?? "Knosh V1"}
          </Text>
          <Text as="p" variant="caption" tone="muted" className="text-xxs">
            Expected service: {status?.expectedServiceUuid ?? "Unavailable"}
          </Text>
        </div>
      ) : null}

      {savedDeviceAddress ? (
        <NativeExtensionDetailCard>
          <div className="space-y-1">
            {showSavedDeviceLabel ? (
              <Text as="p" variant="caption" tone="secondary">
                {showProjectContextLabels ? "Saved device for this project" : "Saved device"}
              </Text>
            ) : null}
            {!embeddedShellOwnsSavedState || (connectedDeviceSaved && !embeddedShellOwnsRuntimeStatus) ? (
              <Text as="p" variant="caption" tone="muted" className="text-xxs">
                {[
                  !embeddedShellOwnsSavedState
                    ? `Transport: ${savedDevice?.transport?.trim() || "ble"}`
                    : null,
                  connectedDeviceSaved && !embeddedShellOwnsRuntimeStatus ? "Connected" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            ) : null}
          </div>
          <Text as="p" variant="caption" tone="muted" className="text-xxs">
            {resolveKnoshDeviceName(savedDevice)}
          </Text>
          <Text as="p" variant="caption" tone="muted" className="text-xxs">
            {savedDeviceAddress}
          </Text>
          <NativeExtensionActionRow>
            <Button
              variant="outline"
              size="xs"
              radius="full"
              isDisabled={
                pendingAction !== null ||
                savePending ||
                !savedDeviceAddress ||
                connectedDeviceSaved
              }
              onPress={() => {
                void handleConnect(savedDeviceAddress);
              }}
              data-testid={buildTestId("connect-saved")}
            >
              {pendingAction === "connect" ? "Connecting…" : "Connect saved device"}
            </Button>
            {onForgetSavedDevice ? (
              <Button
                variant="ghost"
                size="xs"
                radius="full"
                isDisabled={pendingAction !== null || savePending}
                onPress={() => {
                  void handleForgetSavedDevice();
                }}
                data-testid={buildTestId("forget-saved")}
              >
                {pendingAction === "forget_device" || savePending
                  ? "Forgetting…"
                  : "Forget saved device"}
              </Button>
            ) : null}
            {onRunRuntimeProbe && showAdvancedActions ? (
              <Button
                variant="outline"
                size="xs"
                radius="full"
                isDisabled={pendingAction !== null || savePending}
                onPress={() => {
                  void handleRunRuntimeProbe();
                }}
                data-testid={buildTestId("runtime-probe")}
              >
                {pendingAction === "runtime_probe" ? "Running…" : "Run runtime probe"}
              </Button>
            ) : null}
          </NativeExtensionActionRow>
        </NativeExtensionDetailCard>
      ) : null}

      <div className="space-y-2">
        <NativeExtensionActionRow>
          {showStatusCheckAction ? (
            <Button
              variant="primary"
              size="sm"
              radius="xl"
              isDisabled={pendingAction !== null}
              onPress={() => {
                void refreshStatus();
              }}
              data-testid={buildTestId("refresh")}
            >
              {pendingAction === "refresh" ? "Checking…" : "Check Bluetooth"}
            </Button>
          ) : showPermissionAction ? (
            <Button
              variant="primary"
              size="sm"
              radius="xl"
              isDisabled={pendingAction !== null}
              onPress={() => {
                void handleRequestPermissions();
              }}
              data-testid={buildTestId("permissions")}
            >
              {pendingAction === "permissions" ? "Requesting…" : "Allow Bluetooth"}
            </Button>
          ) : showScanAction ? (
            <Button
              variant="primary"
              size="sm"
              radius="xl"
              isDisabled={pendingAction !== null || !scanReady || status?.scanning === true}
              onPress={() => {
                void handleScan();
              }}
              data-testid={buildTestId("scan")}
            >
              {pendingAction === "scan" ? "Scanning…" : "Scan for Knosh"}
            </Button>
          ) : null}
          {!showStatusCheckAction ? (
            <Button
              variant="ghost"
              size="sm"
              radius="xl"
              isDisabled={pendingAction !== null}
              onPress={() => {
                void refreshStatus();
              }}
              data-testid={buildTestId("refresh")}
            >
              {pendingAction === "refresh" ? "Refreshing…" : "Refresh status"}
            </Button>
          ) : null}
          {platform === "web" && showAdvancedActions ? (
            <Button
              variant="ghost"
              size="xs"
              radius="full"
              isDisabled={pendingAction !== null || !scanReady || status?.scanning === true}
              onPress={() => {
                void handleScanAnyDevice();
              }}
              data-testid={buildTestId("scan-any")}
            >
              {pendingAction === "scan_any" ? "Scanning any BLE…" : "Scan any BLE device (debug)"}
            </Button>
          ) : null}
          {showCancelScanAction ? (
            <Button
              variant="ghost"
              size="xs"
              radius="full"
              isDisabled={pendingAction !== null || status?.scanning !== true}
              onPress={() => {
                void handleCancelScan();
              }}
              data-testid={buildTestId("cancel-scan")}
            >
              {pendingAction === "cancel" ? "Stopping…" : "Stop scan"}
            </Button>
          ) : null}
        </NativeExtensionActionRow>
      </div>

      {platform === "web" ? (
        <KnoshDesktopNoticeStack
          runtimeId={runtime?.id === "native_desktop_ble" || runtime?.id === "web_bluetooth" ? runtime.id : null}
          showDeveloperDetails={showDeveloperDetails}
          hints={desktopHints}
          buildTestId={buildTestId}
        />
      ) : null}

      {status?.connection.deviceAddress ? (
        <NativeExtensionDetailCard>
          <div className="space-y-1">
            {showConnectedDeviceLabel ? (
              <Text as="p" variant="caption" tone="secondary">
                Connected device
              </Text>
            ) : null}
            {connectedDeviceSaved && !embeddedShellOwnsSavedState ? (
              <Text as="p" variant="caption" tone="muted" className="text-xxs">
                Saved to project
              </Text>
            ) : null}
          </div>
          <Text as="p" variant="caption" tone="muted" className="text-xxs">
            {resolveKnoshDeviceName(connectedDevice ?? savedDevice)}
          </Text>
          <Text as="p" variant="caption" tone="muted" className="text-xxs">
            {status.connection.deviceAddress}
          </Text>
          <NativeExtensionActionRow>
            {showAdvancedActions ? (
              <>
                <Button
                  variant="outline"
                  size="xs"
                  radius="full"
                  isDisabled={pendingAction !== null || !connectionReady}
                  onPress={() => {
                    void handleReadGattStatus();
                  }}
                  data-testid={buildTestId("read-status")}
                >
                  {pendingAction === "read_status" ? "Reading…" : "Read GATT status"}
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  radius="full"
                  isDisabled={pendingAction !== null || !connectionReady}
                  onPress={() => {
                    void handleTestCommand();
                  }}
                  data-testid={buildTestId("test-command")}
                >
                  {pendingAction === "test_command" ? "Sending…" : "Send safe test command"}
                </Button>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              radius="full"
              isDisabled={pendingAction !== null || !status.connection.connected}
              onPress={() => {
                void handleDisconnect();
              }}
              data-testid={buildTestId("disconnect")}
            >
              {pendingAction === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </Button>
            {onSaveConnectedDevice && !connectedDeviceSaved ? (
              <Button
                variant="outline"
                size="xs"
                radius="full"
                isDisabled={pendingAction !== null || savePending || !connectedDeviceAddress}
                onPress={() => {
                  void handleSaveConnectedDevice();
                }}
                data-testid={buildTestId("save-connected")}
              >
                {pendingAction === "save_device" || savePending
                  ? "Saving…"
                  : "Save device to project"}
              </Button>
            ) : null}
          </NativeExtensionActionRow>
        </NativeExtensionDetailCard>
      ) : null}

      {powerStatus?.available ? (
        <NativeExtensionDetailCard>
          <div className="space-y-1">
            <Text as="p" variant="caption" tone="secondary">
              Power snapshot
            </Text>
            <Text
              as="p"
              variant="caption"
              tone={getFaultFlagsTone(powerStatus.fault_flags) === "danger" ? "danger" : "muted"}
              className="text-xxs"
            >
              {formatBatteryVoltageLabel(powerStatus.battery_voltage_v)} · Watchdog{" "}
              {powerStatus.watchdog_state?.trim() || "unknown"} ·{" "}
              {formatFaultFlagsLabel(powerStatus.fault_flags)}
            </Text>
          </div>
          {!compact || showDeveloperDetails ? (
            <div className="space-y-1">
              <Text as="p" variant="caption" tone="muted" className="text-xxs">
                Source: {powerStatus.source ?? "Unavailable"}
              </Text>
              {powerStatus.path ? (
                <Text as="p" variant="caption" tone="muted" className="text-xxs">
                  Session: {powerStatus.path}
                </Text>
              ) : null}
            </div>
          ) : null}
        </NativeExtensionDetailCard>
      ) : null}

      {!powerStatus?.available && showDeveloperDetails && (powerStatus?.reason || powerStatusError) ? (
        <div className="space-y-1">
          <Text as="p" variant="caption" tone="muted">
            Power snapshot unavailable
          </Text>
          <Text as="p" variant="caption" tone="muted" className="text-xxs">
            {powerStatus?.reason ?? powerStatusError}
          </Text>
        </div>
      ) : null}

      {error ? (
        <div className="space-y-1">
          <Text as="p" variant="caption" tone="warning">
            Diagnostics error
          </Text>
          <Text as="p" variant="caption" tone="warning" className="text-xxs">
            {error}
          </Text>
        </div>
      ) : null}

      {allowDeveloperToggle ? (
        <div className="space-y-2">
          <Button
            variant="ghost"
            size="xs"
            radius="full"
            onPress={() => setShowDeveloperDetails((current) => !current)}
            data-testid={buildTestId("developer-toggle")}
          >
            {showDeveloperDetails ? "Hide developer details" : "Developer details"}
          </Button>
        </div>
      ) : null}

      {showDeveloperDetails && latestDebugInfo ? (
        <div className="space-y-1">
          <NativeExtensionMetaLine tone="secondary">
            Latest desktop BLE trace
          </NativeExtensionMetaLine>
          <NativeExtensionMetaLine>
            Stage: {latestDebugInfo.stage}
          </NativeExtensionMetaLine>
          {latestDebugInfo.detail ? (
            <NativeExtensionMetaLine>
              Detail: {latestDebugInfo.detail}
            </NativeExtensionMetaLine>
          ) : null}
          <NativeExtensionMetaLine>
            Updated: {latestDebugInfo.updatedAt}
          </NativeExtensionMetaLine>
        </div>
      ) : null}

      {scanResult ? (
        <div className="space-y-2">
          <NativeExtensionMetaLine tone="secondary">
            Latest scan:{" "}
            {scanResult.deviceCount}{" "}
            {scanResult.filterToKnosh
              ? `match${scanResult.deviceCount === 1 ? "" : "es"}`
              : `device${scanResult.deviceCount === 1 ? "" : "s"}`}
          </NativeExtensionMetaLine>
          {scanResult.devices.length > 0 ? (
            <div className="space-y-2">
              {scanResult.devices.map((device) => {
                const isConnected = status?.connection.deviceAddress === device.address;
                return (
                  <NativeExtensionDeviceCard
                    key={device.address}
                    title={device.name || device.localName || "Unnamed Knosh device"}
                    className="bg-white/80 px-3 py-2 dark:bg-slate-950/40"
                    meta={[
                      device.address,
                      `RSSI ${typeof device.rssi === "number" ? `${device.rssi} dBm` : "Unavailable"}`,
                    ]}
                    end={
                      isConnected ? (
                        <Text as="p" variant="caption" tone="success" className="shrink-0 text-xxs">
                          Connected
                        </Text>
                      ) : (
                        <Button
                          variant="outline"
                          size="xs"
                          radius="full"
                          isDisabled={pendingAction !== null}
                          onPress={() => {
                            void handleConnect(device.address);
                          }}
                          data-testid={buildTestId(`connect-${device.address}`)}
                        >
                          {pendingAction === "connect" ? "Connecting…" : "Connect"}
                        </Button>
                      )
                    }
                  />
                );
              })}
            </div>
          ) : (
            <NativeExtensionMetaLine>
              {scanResult.filterToKnosh
                ? "No matching Knosh devices found during the latest scan."
                : "No BLE devices were found during the latest debug scan."}
            </NativeExtensionMetaLine>
          )}
        </div>
      ) : null}

      {latestOutput && (!compact || showDeveloperDetails) ? (
        <NativeExtensionRawOutput
          output={formatJson(latestOutput)}
          testId={buildTestId("output")}
        />
      ) : null}
    </>
  );

  if (embedded) {
    return <div className={rootClassName}>{content}</div>;
  }

  return (
    <Card tone="muted" radius="2xl" shadow="none" padding="sm" className={rootClassName}>
      {content}
    </Card>
  );
}
