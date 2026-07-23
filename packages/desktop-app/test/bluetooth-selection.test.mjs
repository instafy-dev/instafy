import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const bluetoothSelectionModulePath = path.join(packageRoot, "dist", "bluetoothSelection.js");
const {
  chooseDesktopBluetoothDevice,
  createBluetoothSelectionCoordinator,
} = await import(bluetoothSelectionModulePath);

test("chooseDesktopBluetoothDevice selects the first available device", () => {
  const selected = chooseDesktopBluetoothDevice([
    { deviceId: "1", deviceName: "Sensor A" },
    { deviceId: "2", deviceName: "Controller B" },
  ]);
  assert.equal(selected, "1");
});

test("coordinator waits for later bluetooth updates before cancelling", () => {
  const callbacks = [];
  const timers = [];
  const cleared = new Set();
  const logs = [];
  const coordinator = createBluetoothSelectionCoordinator({
    timeoutMs: 12_000,
    onLog: (event, payload) => logs.push({ event, payload }),
    setTimeoutImpl: (fn, delay) => {
      const handle = { fn, delay };
      timers.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => {
      cleared.add(handle);
    },
  });

  const callback = (deviceId) => callbacks.push(deviceId);
  coordinator.handleDeviceUpdate([], callback);
  assert.deepEqual(callbacks, []);
  coordinator.handleDeviceUpdate(
    [{ deviceId: "controller-1", deviceName: "Controller" }],
    callback,
  );
  assert.deepEqual(callbacks, ["controller-1"]);
  assert.equal(timers.length, 1);
  assert.equal(cleared.has(timers[0]), true);
  assert.equal(logs.some((entry) => entry.event === "select-bluetooth-device.resolve"), true);
});

test("coordinator cancels after timeout when no devices appear", () => {
  const callbacks = [];
  const timers = [];
  const coordinator = createBluetoothSelectionCoordinator({
    timeoutMs: 12_000,
    setTimeoutImpl: (fn, delay) => {
      const handle = { fn, delay };
      timers.push(handle);
      return handle;
    },
    clearTimeoutImpl: () => {},
  });

  coordinator.handleDeviceUpdate([], (deviceId) => callbacks.push(deviceId));
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.deepEqual(callbacks, [""]);
});
