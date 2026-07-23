export type ElectronBluetoothDeviceDescriptor = {
  deviceId: string;
  deviceName?: string;
};

type TimeoutHandle = ReturnType<typeof setTimeout>;

type BluetoothSelectionCoordinatorOptions = {
  timeoutMs?: number;
  onLog?: (event: string, payload: Record<string, unknown>) => void;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

type PendingBluetoothSelection = {
  requestId: number;
  callback: (deviceId: string) => void;
  timer: TimeoutHandle | null;
  resolved: boolean;
};

const DEFAULT_SELECTION_TIMEOUT_MS = 12_000;

export function chooseDesktopBluetoothDevice(
  deviceList: ElectronBluetoothDeviceDescriptor[],
): string {
  return deviceList[0]?.deviceId ?? "";
}

export function summarizeBluetoothDevices(deviceList: ElectronBluetoothDeviceDescriptor[]) {
  return deviceList.map((device) => ({
    deviceId: device.deviceId,
    deviceName: device.deviceName ?? null,
  }));
}

export function createBluetoothSelectionCoordinator(
  options: BluetoothSelectionCoordinatorOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SELECTION_TIMEOUT_MS;
  const onLog = options.onLog ?? (() => {});
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  let requestCounter = 0;
  let pending: PendingBluetoothSelection | null = null;

  function clearPendingTimer() {
    if (!pending?.timer) {
      return;
    }
    clearTimeoutImpl(pending.timer);
    pending.timer = null;
  }

  function resolvePendingSelection(deviceId: string, reason: string) {
    if (!pending || pending.resolved) {
      return;
    }
    pending.resolved = true;
    clearPendingTimer();
    onLog("select-bluetooth-device.resolve", {
      requestId: pending.requestId,
      reason,
      selectedDeviceId: deviceId,
    });
    pending.callback(deviceId);
    pending = null;
  }

  function startNewPendingSelection(callback: (deviceId: string) => void) {
    const nextRequestId = requestCounter + 1;
    requestCounter = nextRequestId;
    pending = {
      requestId: nextRequestId,
      callback,
      timer: setTimeoutImpl(() => {
        resolvePendingSelection("", "timeout");
      }, timeoutMs),
      resolved: false,
    };
    onLog("select-bluetooth-device.start", {
      requestId: nextRequestId,
      timeoutMs,
    });
  }

  return {
    handleDeviceUpdate(
      deviceList: ElectronBluetoothDeviceDescriptor[],
      callback: (deviceId: string) => void,
    ) {
      if (!pending || pending.callback !== callback) {
        if (pending && !pending.resolved) {
          resolvePendingSelection("", "superseded");
        }
        startNewPendingSelection(callback);
      }

      onLog("select-bluetooth-device.update", {
        requestId: pending?.requestId ?? null,
        deviceCount: deviceList.length,
        devices: summarizeBluetoothDevices(deviceList),
      });

      const selectedDeviceId = chooseDesktopBluetoothDevice(deviceList);
      if (selectedDeviceId) {
        resolvePendingSelection(selectedDeviceId, "device_found");
      }
    },
    dispose() {
      if (!pending) {
        return;
      }
      if (!pending.resolved) {
        resolvePendingSelection("", "disposed");
        return;
      }
      clearPendingTimer();
      pending = null;
    },
  };
}
