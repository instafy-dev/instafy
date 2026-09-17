import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  COMMAND_NAME_STOP_ALL_MOTION,
  EXPECTED_DEVICE_NAME,
  PRIMARY_CONTROL_COMMAND_CHARACTERISTIC_UUID,
  PRIMARY_CONTROL_SERVICE_UUID,
  PRIMARY_CONTROL_STATUS_CHARACTERISTIC_UUID,
  PRIMARY_CONTROL_TELEMETRY_CHARACTERISTIC_UUID,
} from "../../contract/knoshContract.generated.js";

function requireKnoshContractString(name: string, value: string | null): string {
  if (!value) {
    throw new Error(`@knosh/contract is missing required field: ${name}`);
  }
  return value;
}

export const NATIVE_KNOSH_EXPECTED_DEVICE_NAME = EXPECTED_DEVICE_NAME;
export const NATIVE_KNOSH_EXPECTED_SERVICE_UUID = requireKnoshContractString(
  "PRIMARY_CONTROL_SERVICE_UUID",
  PRIMARY_CONTROL_SERVICE_UUID,
);
export const NATIVE_KNOSH_COMMAND_CHARACTERISTIC_UUID =
  requireKnoshContractString(
    "PRIMARY_CONTROL_COMMAND_CHARACTERISTIC_UUID",
    PRIMARY_CONTROL_COMMAND_CHARACTERISTIC_UUID,
  );
export const NATIVE_KNOSH_TELEMETRY_CHARACTERISTIC_UUID =
  requireKnoshContractString(
    "PRIMARY_CONTROL_TELEMETRY_CHARACTERISTIC_UUID",
    PRIMARY_CONTROL_TELEMETRY_CHARACTERISTIC_UUID,
  );
export const NATIVE_KNOSH_STATUS_CHARACTERISTIC_UUID =
  requireKnoshContractString(
    "PRIMARY_CONTROL_STATUS_CHARACTERISTIC_UUID",
    PRIMARY_CONTROL_STATUS_CHARACTERISTIC_UUID,
  );
export const NATIVE_KNOSH_SAFE_TEST_COMMAND_NAME = COMMAND_NAME_STOP_ALL_MOTION;

export type NativeKnoshPermissionState = "granted" | "denied" | "prompt" | "prompt-with-rationale";

export type NativeKnoshConnectionState = {
  connected: boolean;
  deviceAddress?: string | null;
  servicesDiscovered: boolean;
  ready: boolean;
  lastStatusText?: string | null;
  lastTelemetryText?: string | null;
  lastTelemetryReplyToMessageId?: string | null;
};

export type NativeKnoshDiagnosticsStatus = {
  supported: boolean;
  platform: string;
  bleSupported: boolean;
  bluetoothEnabled: boolean;
  permissions: {
    bluetooth: NativeKnoshPermissionState;
    location: NativeKnoshPermissionState;
    /** Android 13+ POST_NOTIFICATIONS state; absent on older builds/platforms. */
    notifications?: NativeKnoshPermissionState;
    scanReady: boolean;
  };
  expectedDeviceName: string;
  expectedServiceUuid: string;
  scanning: boolean;
  connection: NativeKnoshConnectionState;
  error?: string;
};

export type NativeKnoshScannedDevice = {
  address: string;
  name?: string | null;
  localName?: string | null;
  rssi?: number | null;
  serviceUuids?: string[];
  manufacturerDataPresent?: boolean;
  txPower?: number | null;
};

export type NativeKnoshScanResult = NativeKnoshDiagnosticsStatus & {
  scanned: boolean;
  durationMs: number;
  filterToKnosh: boolean;
  cancelled?: boolean;
  devices: NativeKnoshScannedDevice[];
  deviceCount: number;
};

export type NativeKnoshStatusReadResult = NativeKnoshDiagnosticsStatus & {
  characteristicUuid: string;
  valueText?: string | null;
};

export type NativeKnoshCommandResult = NativeKnoshDiagnosticsStatus & {
  action: string;
  messageId?: string | null;
  commandText?: string | null;
  writeCompleted: boolean;
  durationMs: number;
  telemetryText?: string | null;
  replyToMessageId?: string | null;
};

interface NativeKnoshDiagnosticsPlugin {
  getStatus(): Promise<NativeKnoshDiagnosticsStatus>;
  requestBluetoothPermissions(): Promise<NativeKnoshDiagnosticsStatus>;
  setKeepScreenOn(options: { enabled: boolean }): Promise<{ keepScreenOn: boolean }>;
  scanDevices(options?: {
    durationMs?: number;
    filterToKnosh?: boolean;
  }): Promise<NativeKnoshScanResult>;
  cancelScan(): Promise<NativeKnoshScanResult>;
  connectDevice(options: { address: string }): Promise<NativeKnoshDiagnosticsStatus>;
  disconnectDevice(): Promise<NativeKnoshDiagnosticsStatus>;
  readStatusCharacteristic(): Promise<NativeKnoshStatusReadResult>;
  sendTestCommand(): Promise<NativeKnoshCommandResult>;
  sendCommand(options: {
    commandJson: string;
    action?: string;
    sessionId?: string;
    source?: string;
  }): Promise<NativeKnoshCommandResult>;
}

let nativeKnoshDiagnosticsPlugin: NativeKnoshDiagnosticsPlugin | null = null;
let nativeKnoshDiagnosticsPluginInitialized = false;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildFallbackStatus(error?: string): NativeKnoshDiagnosticsStatus {
  const platform = Capacitor.getPlatform();
  const isNativeMobile = platform === "android" || platform === "ios";
  return {
    supported: isNativeMobile,
    platform,
    bleSupported: false,
    bluetoothEnabled: false,
    permissions: {
      bluetooth: "denied",
      location: "denied",
      scanReady: false,
    },
    expectedDeviceName: NATIVE_KNOSH_EXPECTED_DEVICE_NAME,
    expectedServiceUuid: NATIVE_KNOSH_EXPECTED_SERVICE_UUID,
    scanning: false,
    connection: {
      connected: false,
      servicesDiscovered: false,
      ready: false,
    },
    error,
  };
}

function buildUnsupportedScanResult(error?: string): NativeKnoshScanResult {
  return {
    ...buildFallbackStatus(error),
    scanned: false,
    durationMs: 0,
    filterToKnosh: true,
    devices: [],
    deviceCount: 0,
  };
}

function buildUnsupportedStatusReadResult(error?: string): NativeKnoshStatusReadResult {
  return {
    ...buildFallbackStatus(error),
    characteristicUuid: NATIVE_KNOSH_STATUS_CHARACTERISTIC_UUID,
    valueText: null,
  };
}

function buildUnsupportedCommandResult(error?: string, action = "command"): NativeKnoshCommandResult {
  return {
    ...buildFallbackStatus(error),
    action,
    writeCompleted: false,
    durationMs: 0,
  };
}

function getNativeKnoshDiagnosticsPlugin(): NativeKnoshDiagnosticsPlugin | null {
  const platform = Capacitor.getPlatform();
  if (platform !== "android" && platform !== "ios") {
    return null;
  }
  if (!nativeKnoshDiagnosticsPluginInitialized) {
    nativeKnoshDiagnosticsPlugin =
      registerPlugin<NativeKnoshDiagnosticsPlugin>("InstafyKnoshDiagnostics");
    nativeKnoshDiagnosticsPluginInitialized = true;
  }
  return nativeKnoshDiagnosticsPlugin;
}

async function buildCurrentStatusWithError(error: unknown): Promise<NativeKnoshDiagnosticsStatus> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  const message = getErrorMessage(error);
  if (!plugin) {
    return buildFallbackStatus(message);
  }
  try {
    const status = await plugin.getStatus();
    return {
      ...status,
      error: message,
    };
  } catch {
    return buildFallbackStatus(message);
  }
}

async function buildCurrentScanResultWithError(error: unknown): Promise<NativeKnoshScanResult> {
  const status = await buildCurrentStatusWithError(error);
  return {
    ...status,
    scanned: false,
    durationMs: 0,
    filterToKnosh: true,
    devices: [],
    deviceCount: 0,
  };
}

async function buildCurrentStatusReadResultWithError(
  error: unknown,
): Promise<NativeKnoshStatusReadResult> {
  const status = await buildCurrentStatusWithError(error);
  return {
    ...status,
    characteristicUuid: NATIVE_KNOSH_STATUS_CHARACTERISTIC_UUID,
    valueText: status.connection.lastStatusText ?? null,
  };
}

async function buildCurrentCommandResultWithError(
  error: unknown,
  action = "command",
): Promise<NativeKnoshCommandResult> {
  const status = await buildCurrentStatusWithError(error);
  return {
    ...status,
    action,
    writeCompleted: false,
    durationMs: 0,
    telemetryText: status.connection.lastTelemetryText ?? null,
    replyToMessageId: status.connection.lastTelemetryReplyToMessageId ?? null,
  };
}

export async function getNativeKnoshDiagnosticsStatus(): Promise<NativeKnoshDiagnosticsStatus> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  if (!plugin) {
    return buildFallbackStatus("Knosh BLE diagnostics are only available on native mobile builds.");
  }
  try {
    return await plugin.getStatus();
  } catch (error) {
    return buildFallbackStatus(getErrorMessage(error));
  }
}

/**
 * Keep the phone screen on while the mounted Knosh runtime surface is active.
 *
 * Best-effort: resolves false (never throws) on web/desktop platforms and on
 * native builds whose plugin predates the setKeepScreenOn method.
 */
export async function setNativeKnoshKeepScreenOn(enabled: boolean): Promise<boolean> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  if (!plugin) {
    return false;
  }
  try {
    const result = await plugin.setKeepScreenOn({ enabled });
    return result.keepScreenOn === enabled;
  } catch {
    return false;
  }
}

export async function requestNativeKnoshBluetoothPermissions(): Promise<NativeKnoshDiagnosticsStatus> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  if (!plugin) {
    return buildFallbackStatus("Knosh BLE diagnostics are only available on native mobile builds.");
  }
  try {
    return await plugin.requestBluetoothPermissions();
  } catch (error) {
    return buildCurrentStatusWithError(error);
  }
}

export async function scanForNativeKnoshDevices(options?: {
  durationMs?: number;
  filterToKnosh?: boolean;
}): Promise<NativeKnoshScanResult> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  if (!plugin) {
    return buildUnsupportedScanResult("Knosh BLE diagnostics are only available on native mobile builds.");
  }
  try {
    return await plugin.scanDevices(options);
  } catch (error) {
    return buildCurrentScanResultWithError(error);
  }
}

export async function cancelNativeKnoshScan(): Promise<NativeKnoshScanResult> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  if (!plugin) {
    return buildUnsupportedScanResult("Knosh BLE diagnostics are only available on native mobile builds.");
  }
  try {
    return await plugin.cancelScan();
  } catch (error) {
    return buildCurrentScanResultWithError(error);
  }
}

export async function connectNativeKnoshDevice(address: string): Promise<NativeKnoshDiagnosticsStatus> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  if (!plugin) {
    return buildFallbackStatus("Knosh BLE diagnostics are only available on native mobile builds.");
  }
  try {
    return await plugin.connectDevice({ address });
  } catch (error) {
    return buildCurrentStatusWithError(error);
  }
}

export async function disconnectNativeKnoshDevice(): Promise<NativeKnoshDiagnosticsStatus> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  if (!plugin) {
    return buildFallbackStatus("Knosh BLE diagnostics are only available on native mobile builds.");
  }
  try {
    return await plugin.disconnectDevice();
  } catch (error) {
    return buildCurrentStatusWithError(error);
  }
}

export async function readNativeKnoshStatusCharacteristic(): Promise<NativeKnoshStatusReadResult> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  if (!plugin) {
    return buildUnsupportedStatusReadResult("Knosh BLE diagnostics are only available on native mobile builds.");
  }
  try {
    return await plugin.readStatusCharacteristic();
  } catch (error) {
    return buildCurrentStatusReadResultWithError(error);
  }
}

export async function sendNativeKnoshTestCommand(): Promise<NativeKnoshCommandResult> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  if (!plugin) {
    return buildUnsupportedCommandResult(
      "Knosh BLE diagnostics are only available on native mobile builds.",
      NATIVE_KNOSH_SAFE_TEST_COMMAND_NAME,
    );
  }
  try {
    return await plugin.sendTestCommand();
  } catch (error) {
    return buildCurrentCommandResultWithError(error, NATIVE_KNOSH_SAFE_TEST_COMMAND_NAME);
  }
}

export async function sendNativeKnoshCommand(
  commandJson: Record<string, unknown> | string,
  options?: {
    action?: string;
    sessionId?: string;
    source?: string;
  },
): Promise<NativeKnoshCommandResult> {
  const plugin = getNativeKnoshDiagnosticsPlugin();
  const commandText =
    typeof commandJson === "string" ? commandJson : JSON.stringify(commandJson);
  const action = options?.action?.trim() || "command";
  if (!plugin) {
    return buildUnsupportedCommandResult(
      "Knosh BLE diagnostics are only available on native mobile builds.",
      action,
    );
  }
  try {
    return await plugin.sendCommand({
      commandJson: commandText,
      action,
      sessionId: options?.sessionId,
      source: options?.source,
    });
  } catch (error) {
    return buildCurrentCommandResultWithError(error, action);
  }
}
