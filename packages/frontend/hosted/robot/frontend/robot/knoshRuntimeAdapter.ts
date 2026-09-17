import { Capacitor } from "@capacitor/core";
import {
  NATIVE_KNOSH_COMMAND_CHARACTERISTIC_UUID,
  NATIVE_KNOSH_EXPECTED_DEVICE_NAME,
  NATIVE_KNOSH_EXPECTED_SERVICE_UUID,
  NATIVE_KNOSH_SAFE_TEST_COMMAND_NAME,
  NATIVE_KNOSH_STATUS_CHARACTERISTIC_UUID,
  NATIVE_KNOSH_TELEMETRY_CHARACTERISTIC_UUID,
  cancelNativeKnoshScan,
  connectNativeKnoshDevice,
  disconnectNativeKnoshDevice,
  getNativeKnoshDiagnosticsStatus,
  readNativeKnoshStatusCharacteristic,
  requestNativeKnoshBluetoothPermissions,
  scanForNativeKnoshDevices,
  sendNativeKnoshCommand,
  sendNativeKnoshTestCommand,
  type NativeKnoshCommandResult,
  type NativeKnoshDiagnosticsStatus,
  type NativeKnoshScanResult,
  type NativeKnoshStatusReadResult,
} from "./nativeKnoshDiagnosticsBridge";

export type KnoshRuntimePlatform = "android" | "ios" | "web";

export type KnoshRuntimeDebugInfo = {
  surface: "web_bluetooth" | "desktop_native_bridge";
  stage: string;
  detail?: string | null;
  updatedAt: string;
};

export type KnoshRuntimeStatus = NativeKnoshDiagnosticsStatus & {
  debug?: KnoshRuntimeDebugInfo;
};
export type KnoshRuntimeScanResult = NativeKnoshScanResult & {
  debug?: KnoshRuntimeDebugInfo;
};
export type KnoshRuntimeStatusReadResult = NativeKnoshStatusReadResult & {
  debug?: KnoshRuntimeDebugInfo;
};
export type KnoshRuntimeCommandResult = NativeKnoshCommandResult & {
  debug?: KnoshRuntimeDebugInfo;
};

export type KnoshRuntimeAdapter = {
  id: "native_mobile_ble" | "native_desktop_ble" | "web_bluetooth";
  backendId: "real_ble";
  transportKind: "ble";
  platform: KnoshRuntimePlatform;
  getStatus: () => Promise<KnoshRuntimeStatus>;
  requestPermissions: () => Promise<KnoshRuntimeStatus>;
  scanDevices: (options?: {
    durationMs?: number;
    filterToKnosh?: boolean;
  }) => Promise<KnoshRuntimeScanResult>;
  cancelScan: () => Promise<KnoshRuntimeScanResult>;
  connectDevice: (address: string) => Promise<KnoshRuntimeStatus>;
  disconnectDevice: () => Promise<KnoshRuntimeStatus>;
  readStatus: () => Promise<KnoshRuntimeStatusReadResult>;
  sendSafeTestCommand: () => Promise<KnoshRuntimeCommandResult>;
  sendCommand: (
    commandJson: Record<string, unknown> | string,
    options?: {
      action?: string;
      sessionId?: string;
      source?: string;
    },
  ) => Promise<KnoshRuntimeCommandResult>;
};

type BluetoothValueView = {
  buffer: ArrayBuffer;
};

type BluetoothRemoteGATTCharacteristicLike = EventTarget & {
  value?: BluetoothValueView | null;
  readValue: () => Promise<BluetoothValueView>;
  writeValue: (value: Uint8Array) => Promise<void>;
  startNotifications: () => Promise<unknown>;
};

type BluetoothRemoteGATTServiceLike = {
  getCharacteristic: (uuid: string) => Promise<BluetoothRemoteGATTCharacteristicLike>;
};

type BluetoothRemoteGATTServerLike = {
  connected: boolean;
  connect: () => Promise<BluetoothRemoteGATTServerLike>;
  disconnect: () => void;
  getPrimaryService: (uuid: string) => Promise<BluetoothRemoteGATTServiceLike>;
};

type BluetoothDeviceLike = EventTarget & {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServerLike | null;
};

type BluetoothApiLike = {
  requestDevice: (options: {
    filters?: Array<Record<string, unknown>>;
    optionalServices?: string[];
    acceptAllDevices?: boolean;
  }) => Promise<BluetoothDeviceLike>;
  getDevices?: () => Promise<BluetoothDeviceLike[]>;
};

type NavigatorWithBluetooth = Navigator & {
  bluetooth?: BluetoothApiLike;
};

type WebBluetoothRuntimeState = {
  device: BluetoothDeviceLike | null;
  server: BluetoothRemoteGATTServerLike | null;
  commandCharacteristic: BluetoothRemoteGATTCharacteristicLike | null;
  statusCharacteristic: BluetoothRemoteGATTCharacteristicLike | null;
  telemetryCharacteristic: BluetoothRemoteGATTCharacteristicLike | null;
  lastStatusText: string | null;
  lastTelemetryText: string | null;
  lastTelemetryReplyToMessageId: string | null;
  scanning: boolean;
  notificationsStarted: boolean;
  debug: KnoshRuntimeDebugInfo | null;
};

const webBluetoothRuntimeState: WebBluetoothRuntimeState = {
  device: null,
  server: null,
  commandCharacteristic: null,
  statusCharacteristic: null,
  telemetryCharacteristic: null,
  lastStatusText: null,
  lastTelemetryText: null,
  lastTelemetryReplyToMessageId: null,
  scanning: false,
  notificationsStarted: false,
  debug: null,
};

function normalizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getExpectedWebBluetoothNamePrefix() {
  const normalized = NATIVE_KNOSH_EXPECTED_DEVICE_NAME.trim();
  if (!normalized) {
    return "Knosh";
  }
  const [firstToken] = normalized.split(/\s+/);
  return firstToken?.trim() || "Knosh";
}

function serializeDebugDetail(detail: unknown) {
  if (detail == null) {
    return null;
  }
  if (typeof detail === "string") {
    return detail;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function updateWebBluetoothDebug(stage: string, detail?: unknown) {
  const serializedDetail = serializeDebugDetail(detail);
  webBluetoothRuntimeState.debug = {
    surface: "web_bluetooth",
    stage,
    detail: serializedDetail,
    updatedAt: new Date().toISOString(),
  };
  if (serializedDetail) {
    console.info("[knosh-web-bluetooth]", stage, serializedDetail);
    return;
  }
  console.info("[knosh-web-bluetooth]", stage);
}

function getWebBluetoothApi() {
  const navigatorWithBluetooth = typeof navigator === "undefined" ? null : (navigator as NavigatorWithBluetooth);
  if (!navigatorWithBluetooth?.bluetooth) {
    return null;
  }
  if (typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext) {
    return null;
  }
  return navigatorWithBluetooth.bluetooth;
}

function getDesktopKnoshBridge() {
  if (typeof window === "undefined") {
    return null;
  }
  const invokeDesktopExtension = window.instafyDesktop?.invokeDesktopExtension;
  if (typeof invokeDesktopExtension !== "function") {
    return null;
  }
  const callDesktopExtension = invokeDesktopExtension;

  function invoke<TResult>(
    method: string,
    payload?: Record<string, unknown>,
  ): Promise<TResult> {
    return callDesktopExtension({
      extensionId: "knosh",
      method,
      ...(payload === undefined ? {} : { payload }),
    }) as Promise<TResult>;
  }

  return Object.freeze({
    getStatus: () => invoke<KnoshRuntimeStatus>("status"),
    requestPermissions: () =>
      invoke<KnoshRuntimeStatus>("requestPermissions"),
    scanDevices: (options?: {
      durationMs?: number;
      filterToKnosh?: boolean;
    }) =>
      invoke<KnoshRuntimeScanResult>("scanDevices", options),
    cancelScan: () => invoke<KnoshRuntimeScanResult>("cancelScan"),
    connectDevice: (address: string) =>
      invoke<KnoshRuntimeStatus>("connectDevice", { address }),
    disconnectDevice: () =>
      invoke<KnoshRuntimeStatus>("disconnectDevice"),
    readStatus: () =>
      invoke<KnoshRuntimeStatusReadResult>("readStatusCharacteristic"),
    sendSafeTestCommand: () =>
      invoke<KnoshRuntimeCommandResult>("sendTestCommand"),
    sendCommand: (
      commandJson: Record<string, unknown> | string,
      options?: {
        action?: string;
        sessionId?: string;
        source?: string;
      },
    ) =>
      invoke<KnoshRuntimeCommandResult>("sendCommand", {
        commandJson:
          typeof commandJson === "string"
            ? commandJson
            : JSON.stringify(commandJson),
        ...(options?.action === undefined ? {} : { action: options.action }),
        ...(options?.sessionId === undefined
          ? {}
          : { sessionId: options.sessionId }),
        ...(options?.source === undefined ? {} : { source: options.source }),
      }),
  });
}

function parseTelemetryReplyToMessageId(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const replyTo = parsed.reply_to_message_id ?? parsed.replyToMessageId;
    return typeof replyTo === "string" && replyTo.trim().length > 0 ? replyTo.trim() : null;
  } catch {
    return null;
  }
}

function ensureWebBluetoothDisconnectListener(device: BluetoothDeviceLike) {
  device.removeEventListener("gattserverdisconnected", handleWebBluetoothDisconnected);
  device.addEventListener("gattserverdisconnected", handleWebBluetoothDisconnected);
}

function handleWebBluetoothDisconnected() {
  webBluetoothRuntimeState.server = null;
  webBluetoothRuntimeState.commandCharacteristic = null;
  webBluetoothRuntimeState.statusCharacteristic = null;
  webBluetoothRuntimeState.telemetryCharacteristic = null;
  webBluetoothRuntimeState.notificationsStarted = false;
  updateWebBluetoothDebug("connection.disconnected");
}

function buildWebBluetoothStatus(error?: string): KnoshRuntimeStatus {
  const api = getWebBluetoothApi();
  const device = webBluetoothRuntimeState.device;
  const server = webBluetoothRuntimeState.server;
  return {
    supported: Boolean(api),
    platform: "web",
    bleSupported: Boolean(api),
    bluetoothEnabled: Boolean(api),
    permissions: {
      bluetooth: device ? "granted" : api ? "prompt" : "denied",
      location: api ? "granted" : "denied",
      scanReady: Boolean(api),
    },
    expectedDeviceName: NATIVE_KNOSH_EXPECTED_DEVICE_NAME,
    expectedServiceUuid: NATIVE_KNOSH_EXPECTED_SERVICE_UUID,
    scanning: webBluetoothRuntimeState.scanning,
    connection: {
      connected: Boolean(server?.connected),
      deviceAddress: device?.id ?? null,
      servicesDiscovered:
        Boolean(webBluetoothRuntimeState.commandCharacteristic) &&
        Boolean(webBluetoothRuntimeState.statusCharacteristic),
      ready:
        Boolean(server?.connected) &&
        Boolean(webBluetoothRuntimeState.commandCharacteristic) &&
        Boolean(webBluetoothRuntimeState.statusCharacteristic),
      lastStatusText: webBluetoothRuntimeState.lastStatusText,
      lastTelemetryText: webBluetoothRuntimeState.lastTelemetryText,
      lastTelemetryReplyToMessageId: webBluetoothRuntimeState.lastTelemetryReplyToMessageId,
    },
    ...(webBluetoothRuntimeState.debug ? { debug: webBluetoothRuntimeState.debug } : {}),
    ...(error ? { error } : {}),
  };
}

async function requestWebBluetoothDevice(filterToKnosh: boolean) {
  const bluetooth = getWebBluetoothApi();
  if (!bluetooth) {
    updateWebBluetoothDebug("scan.request_device.unavailable");
    throw new Error("Web Bluetooth is unavailable on this client.");
  }
  webBluetoothRuntimeState.scanning = true;
  updateWebBluetoothDebug("scan.request_device.start", {
    filterToKnosh,
  });
  try {
    const expectedNamePrefix = getExpectedWebBluetoothNamePrefix();
    const request = filterToKnosh
      ? {
          filters: [
            { services: [NATIVE_KNOSH_EXPECTED_SERVICE_UUID] },
            { namePrefix: expectedNamePrefix },
          ],
          optionalServices: [NATIVE_KNOSH_EXPECTED_SERVICE_UUID],
        }
      : {
          acceptAllDevices: true,
          optionalServices: [NATIVE_KNOSH_EXPECTED_SERVICE_UUID],
        };
    updateWebBluetoothDebug("scan.request_device.prompting", request);
    const device = await bluetooth.requestDevice(request);
    webBluetoothRuntimeState.device = device;
    ensureWebBluetoothDisconnectListener(device);
    updateWebBluetoothDebug("scan.request_device.selected", {
      id: device.id || null,
      name: device.name || null,
    });
    return device;
  } catch (error) {
    updateWebBluetoothDebug("scan.request_device.failed", {
      message: normalizeErrorMessage(error),
      name: error instanceof Error ? error.name : null,
    });
    throw error;
  } finally {
    webBluetoothRuntimeState.scanning = false;
  }
}

async function findGrantedWebBluetoothDevice(identifier: string) {
  const bluetooth = getWebBluetoothApi();
  if (!bluetooth || typeof bluetooth.getDevices !== "function") {
    return null;
  }
  const devices = await bluetooth.getDevices();
  const normalizedIdentifier = identifier.trim().toLowerCase();
  return (
    devices.find((device: BluetoothDeviceLike) => {
      const id = device.id?.trim().toLowerCase() ?? "";
      const name = device.name?.trim().toLowerCase() ?? "";
      return id === normalizedIdentifier || name === normalizedIdentifier;
    }) ?? null
  );
}

async function ensureWebBluetoothCharacteristics(device: BluetoothDeviceLike) {
  updateWebBluetoothDebug("connect.characteristics.start", {
    id: device.id || null,
    name: device.name || null,
  });
  const server = device.gatt?.connected ? device.gatt : await device.gatt?.connect();
  if (!server) {
    updateWebBluetoothDebug("connect.characteristics.no_server");
    throw new Error("Unable to open a Web Bluetooth GATT session.");
  }

  const service = await server.getPrimaryService(NATIVE_KNOSH_EXPECTED_SERVICE_UUID);
  const [commandCharacteristic, statusCharacteristic, telemetryCharacteristic] = await Promise.all([
    service.getCharacteristic(NATIVE_KNOSH_COMMAND_CHARACTERISTIC_UUID),
    service.getCharacteristic(NATIVE_KNOSH_STATUS_CHARACTERISTIC_UUID),
    service.getCharacteristic(NATIVE_KNOSH_TELEMETRY_CHARACTERISTIC_UUID).catch(() => null),
  ]);

  webBluetoothRuntimeState.device = device;
  webBluetoothRuntimeState.server = server;
  webBluetoothRuntimeState.commandCharacteristic = commandCharacteristic;
  webBluetoothRuntimeState.statusCharacteristic = statusCharacteristic;
  webBluetoothRuntimeState.telemetryCharacteristic = telemetryCharacteristic;
  ensureWebBluetoothDisconnectListener(device);
  updateWebBluetoothDebug("connect.characteristics.ready", {
    deviceId: device.id || null,
    telemetryAvailable: Boolean(telemetryCharacteristic),
  });

  if (telemetryCharacteristic && !webBluetoothRuntimeState.notificationsStarted) {
    telemetryCharacteristic.addEventListener("characteristicvaluechanged", (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristicLike | null;
      const buffer = target?.value?.buffer;
      if (!buffer) {
        return;
      }
      const telemetryText = new TextDecoder().decode(buffer);
      webBluetoothRuntimeState.lastTelemetryText = telemetryText;
      webBluetoothRuntimeState.lastTelemetryReplyToMessageId =
        parseTelemetryReplyToMessageId(telemetryText);
    });
    await telemetryCharacteristic.startNotifications().catch(() => null);
    webBluetoothRuntimeState.notificationsStarted = true;
  }

  return {
    server,
    commandCharacteristic,
    statusCharacteristic,
    telemetryCharacteristic,
  };
}

async function connectWebBluetoothDevice(identifier: string) {
  updateWebBluetoothDebug("connect.start", {
    identifier,
  });
  const currentDevice = webBluetoothRuntimeState.device;
  if (
    currentDevice &&
    (currentDevice.id === identifier || currentDevice.name?.trim() === identifier.trim())
  ) {
    await ensureWebBluetoothCharacteristics(currentDevice);
    updateWebBluetoothDebug("connect.reused_granted_device", {
      identifier,
    });
    return buildWebBluetoothStatus();
  }

  const grantedDevice = await findGrantedWebBluetoothDevice(identifier);
  if (!grantedDevice) {
    updateWebBluetoothDebug("connect.granted_device_missing", {
      identifier,
    });
    return buildWebBluetoothStatus(
      "This desktop client cannot reconnect by device id until the device is granted again.",
    );
  }

  await ensureWebBluetoothCharacteristics(grantedDevice);
  updateWebBluetoothDebug("connect.granted_device_ready", {
    identifier,
  });
  return buildWebBluetoothStatus();
}

async function readWebBluetoothStatus() {
  const characteristic = webBluetoothRuntimeState.statusCharacteristic;
  if (!characteristic) {
    updateWebBluetoothDebug("read_status.unavailable");
    return {
      ...buildWebBluetoothStatus("Knosh status is unavailable until the device is connected."),
      characteristicUuid: NATIVE_KNOSH_STATUS_CHARACTERISTIC_UUID,
      valueText: null,
    };
  }

  try {
    updateWebBluetoothDebug("read_status.start");
    const value = await characteristic.readValue();
    const text = new TextDecoder().decode(value.buffer);
    webBluetoothRuntimeState.lastStatusText = text;
    updateWebBluetoothDebug("read_status.success", {
      bytes: value.buffer.byteLength,
    });
    return {
      ...buildWebBluetoothStatus(),
      characteristicUuid: NATIVE_KNOSH_STATUS_CHARACTERISTIC_UUID,
      valueText: text,
    };
  } catch (error) {
    updateWebBluetoothDebug("read_status.failed", {
      message: normalizeErrorMessage(error),
    });
    return {
      ...buildWebBluetoothStatus(normalizeErrorMessage(error)),
      characteristicUuid: NATIVE_KNOSH_STATUS_CHARACTERISTIC_UUID,
      valueText: webBluetoothRuntimeState.lastStatusText,
    };
  }
}

async function waitForNextWebBluetoothTelemetry(timeoutMs = 1500) {
  const characteristic = webBluetoothRuntimeState.telemetryCharacteristic;
  if (!characteristic) {
    return null;
  }

  return await new Promise<string | null>((resolve) => {
    const timeoutId = window.setTimeout(() => {
      characteristic.removeEventListener("characteristicvaluechanged", handleTelemetry);
      resolve(webBluetoothRuntimeState.lastTelemetryText);
    }, timeoutMs);

    const handleTelemetry = (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristicLike | null;
      const buffer = target?.value?.buffer;
      const telemetryText = buffer ? new TextDecoder().decode(buffer) : null;
      characteristic.removeEventListener("characteristicvaluechanged", handleTelemetry);
      window.clearTimeout(timeoutId);
      resolve(telemetryText);
    };

    characteristic.addEventListener("characteristicvaluechanged", handleTelemetry, { once: true });
  });
}

async function sendWebBluetoothCommand(
  commandJson: Record<string, unknown> | string,
  options?: {
    action?: string;
    sessionId?: string;
    source?: string;
  },
) {
  const characteristic = webBluetoothRuntimeState.commandCharacteristic;
  const action = options?.action?.trim() || "command";
  if (!characteristic) {
    updateWebBluetoothDebug("send_command.unavailable", {
      action,
    });
    return {
      ...buildWebBluetoothStatus("Knosh command writes are unavailable until the device is connected."),
      action,
      writeCompleted: false,
      durationMs: 0,
      telemetryText: webBluetoothRuntimeState.lastTelemetryText,
      replyToMessageId: webBluetoothRuntimeState.lastTelemetryReplyToMessageId,
    };
  }

  const commandText = typeof commandJson === "string" ? commandJson : JSON.stringify(commandJson);
  const startedAt = performance.now();
  try {
    updateWebBluetoothDebug("send_command.start", {
      action,
    });
    await characteristic.writeValue(new TextEncoder().encode(commandText));
    const telemetryText = await waitForNextWebBluetoothTelemetry();
    if (telemetryText) {
      webBluetoothRuntimeState.lastTelemetryText = telemetryText;
      webBluetoothRuntimeState.lastTelemetryReplyToMessageId =
        parseTelemetryReplyToMessageId(telemetryText);
    }
    return {
      ...buildWebBluetoothStatus(),
      action,
      commandText,
      writeCompleted: true,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      telemetryText: telemetryText ?? webBluetoothRuntimeState.lastTelemetryText,
      replyToMessageId: webBluetoothRuntimeState.lastTelemetryReplyToMessageId,
    };
  } catch (error) {
    updateWebBluetoothDebug("send_command.failed", {
      action,
      message: normalizeErrorMessage(error),
    });
    return {
      ...buildWebBluetoothStatus(normalizeErrorMessage(error)),
      action,
      commandText,
      writeCompleted: false,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      telemetryText: webBluetoothRuntimeState.lastTelemetryText,
      replyToMessageId: webBluetoothRuntimeState.lastTelemetryReplyToMessageId,
    };
  }
}

export function isKnoshNativeRuntimePlatform(
  platform: string = Capacitor.getPlatform(),
): platform is KnoshRuntimePlatform {
  return platform === "android" || platform === "ios" || platform === "web";
}

export function resolveKnoshRuntimeExecutionSurface(
  platform: string | null | undefined,
): "android" | "ios" | "desktop" | "native_extension" {
  if (platform === "android" || platform === "ios") {
    return platform;
  }
  if (platform === "web") {
    return "desktop";
  }
  return "native_extension";
}

export function getKnoshRuntimeAdapter(
  platform: string = Capacitor.getPlatform(),
): KnoshRuntimeAdapter | null {
  if (platform === "android" || platform === "ios") {
    return {
      id: "native_mobile_ble",
      backendId: "real_ble",
      transportKind: "ble",
      platform,
      getStatus: () => getNativeKnoshDiagnosticsStatus(),
      requestPermissions: () => requestNativeKnoshBluetoothPermissions(),
      scanDevices: (options) => scanForNativeKnoshDevices(options),
      cancelScan: () => cancelNativeKnoshScan(),
      connectDevice: (address) => connectNativeKnoshDevice(address),
      disconnectDevice: () => disconnectNativeKnoshDevice(),
      readStatus: () => readNativeKnoshStatusCharacteristic(),
      sendSafeTestCommand: () => sendNativeKnoshTestCommand(),
      sendCommand: (commandJson, options) => sendNativeKnoshCommand(commandJson, options),
    };
  }

  const desktopBridge = platform === "web" ? getDesktopKnoshBridge() : null;
  if (platform === "web" && desktopBridge) {
    return {
      id: "native_desktop_ble",
      backendId: "real_ble",
      transportKind: "ble",
      platform,
      getStatus: desktopBridge.getStatus,
      requestPermissions: desktopBridge.requestPermissions,
      scanDevices: desktopBridge.scanDevices,
      cancelScan: desktopBridge.cancelScan,
      connectDevice: desktopBridge.connectDevice,
      disconnectDevice: desktopBridge.disconnectDevice,
      readStatus: desktopBridge.readStatus,
      sendSafeTestCommand: desktopBridge.sendSafeTestCommand,
      sendCommand: desktopBridge.sendCommand,
    };
  }

  if (platform === "web" && getWebBluetoothApi()) {
    return {
      id: "web_bluetooth",
      backendId: "real_ble",
      transportKind: "ble",
      platform,
      getStatus: async () => buildWebBluetoothStatus(),
      requestPermissions: async () => {
        updateWebBluetoothDebug("permissions.noop");
        return buildWebBluetoothStatus();
      },
      scanDevices: async (options) => {
        try {
          const device = await requestWebBluetoothDevice(options?.filterToKnosh !== false);
          return {
            ...buildWebBluetoothStatus(),
            scanned: true,
            durationMs: options?.durationMs ?? 0,
            filterToKnosh: options?.filterToKnosh !== false,
            cancelled: false,
            devices: [
              {
                address: device.id || device.name || "web-bluetooth-device",
                name: device.name ?? null,
                localName: null,
              },
            ],
            deviceCount: 1,
          };
        } catch (error) {
          return {
            ...buildWebBluetoothStatus(normalizeErrorMessage(error)),
            scanned: false,
            durationMs: options?.durationMs ?? 0,
            filterToKnosh: options?.filterToKnosh !== false,
            cancelled: false,
            devices: [],
            deviceCount: 0,
          };
        }
      },
      cancelScan: async () => {
        updateWebBluetoothDebug("scan.cancelled");
        return {
          ...buildWebBluetoothStatus(),
          scanned: false,
          durationMs: 0,
          filterToKnosh: true,
          cancelled: true,
          devices: webBluetoothRuntimeState.device
            ? [
                {
                  address: webBluetoothRuntimeState.device.id || "web-bluetooth-device",
                  name: webBluetoothRuntimeState.device.name ?? null,
                  localName: null,
                },
              ]
            : [],
          deviceCount: webBluetoothRuntimeState.device ? 1 : 0,
        };
      },
      connectDevice: async (address) => connectWebBluetoothDevice(address),
      disconnectDevice: async () => {
        try {
          webBluetoothRuntimeState.server?.disconnect();
        } catch {
          // ignore disconnect failures on best-effort cleanup
        }
        handleWebBluetoothDisconnected();
        return buildWebBluetoothStatus();
      },
      readStatus: async () => readWebBluetoothStatus(),
      sendSafeTestCommand: async () =>
        sendWebBluetoothCommand({ name: NATIVE_KNOSH_SAFE_TEST_COMMAND_NAME }, {
          action: NATIVE_KNOSH_SAFE_TEST_COMMAND_NAME,
        }),
      sendCommand: async (commandJson, options) => sendWebBluetoothCommand(commandJson, options),
    };
  }

  return null;
}
