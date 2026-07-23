import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  LocalHardwareIoAction,
  LocalHardwareIoActionRunRequest,
  LocalHardwareIoActionRunResult,
  LocalHardwareIoOpportunity,
  LocalHardwareIoOpportunityListResult,
  SerialPortDescriptor,
  SerialPortKind,
  SerialPortListResult,
  SerialPortProbeResult,
} from "./hardwareProvider.js";
import { SERIAL_HARDWARE_PROVIDER_ID } from "./hardwareProvider.js";

export interface HardwareSerialListOptions {
  scanDirs?: string[];
}

interface SerialCandidate {
  path: string;
  kind: SerialPortKind;
  displayName: string;
}

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function defaultSerialScanDirs(platform = process.platform): string[] {
  if (platform === "darwin" || platform === "linux") {
    return ["/dev", "/dev/serial/by-id"];
  }
  return [];
}

function classifySerialPort(fileName: string, fullPath: string): SerialPortKind | null {
  if (/^(cu|tty)\.(usbserial|usbmodem|wchusbserial|SLAB_USBtoUART)/i.test(fileName)) {
    return "usb_serial";
  }
  if (/^(ttyUSB|ttyACM)[0-9]+$/i.test(fileName)) {
    return "usb_serial";
  }
  if (/^(cu|tty)\.Bluetooth/i.test(fileName)) {
    return "bluetooth_serial";
  }
  if (fullPath.includes("/dev/serial/by-id/")) {
    return "usb_serial";
  }
  if (/^(cu|tty)\./i.test(fileName)) {
    return "serial";
  }
  return null;
}

function inspectPort(portPath: string): SerialPortProbeResult {
  const resolvedPath = path.resolve(portPath);
  let exists = false;
  let readable = false;
  let writable = false;
  let isCharacterDevice = false;
  let error: string | null = null;

  try {
    const stat = fs.statSync(resolvedPath);
    exists = true;
    isCharacterDevice = stat.isCharacterDevice();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  if (exists) {
    try {
      fs.accessSync(resolvedPath, fs.constants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }
    try {
      fs.accessSync(resolvedPath, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
  }

  return {
    providerId: SERIAL_HARDWARE_PROVIDER_ID,
    path: resolvedPath,
    exists,
    readable,
    writable,
    isCharacterDevice,
    available: exists && readable && writable && isCharacterDevice,
    error,
  };
}

function listCandidates(scanDirs: string[]): SerialCandidate[] {
  const candidates: SerialCandidate[] = [];
  for (const scanDir of scanDirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(scanDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(scanDir, entry);
      const kind = classifySerialPort(entry, fullPath);
      if (!kind) {
        continue;
      }
      candidates.push({
        path: fullPath,
        kind,
        displayName: path.basename(fullPath),
      });
    }
  }
  return candidates;
}

export function listHardwareSerialPorts(
  options: HardwareSerialListOptions = {},
): SerialPortListResult {
  const scanDirs = uniqueStrings([
    ...(options.scanDirs ?? []),
    ...(options.scanDirs && options.scanDirs.length > 0 ? [] : defaultSerialScanDirs()),
  ]);
  const byPath = new Map<string, SerialPortDescriptor>();

  for (const candidate of listCandidates(scanDirs)) {
    const probe = inspectPort(candidate.path);
    byPath.set(probe.path, {
      path: probe.path,
      displayName: candidate.displayName,
      kind: candidate.kind,
      source: "host",
      available: probe.available,
      isCharacterDevice: probe.isCharacterDevice,
      detail: probe.error,
    });
  }

  return {
    providerId: SERIAL_HARDWARE_PROVIDER_ID,
    platform: os.platform(),
    ports: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function probeHardwareSerialPort(device: string): SerialPortProbeResult {
  const trimmed = device.trim();
  if (!trimmed) {
    throw new Error("Serial device path is required.");
  }
  return inspectPort(trimmed);
}

function serialActionsForPort(): LocalHardwareIoAction[] {
  return [
    {
      id: "serial.probe",
      label: "Probe",
      status: "available",
      source: "runtime",
      description: "Check whether this runtime can read and write the serial device.",
    },
  ];
}

function opportunityForSerialPort(
  port: SerialPortDescriptor,
): LocalHardwareIoOpportunity {
  const isUsbSerial = port.kind === "usb_serial";
  return {
    id: `serial:${port.path}`,
    providerId: SERIAL_HARDWARE_PROVIDER_ID,
    kind: isUsbSerial ? "usb_serial_device" : "serial_port",
    title: isUsbSerial ? `USB serial device: ${port.displayName}` : `Serial device: ${port.displayName}`,
    detail: port.detail,
    resource: {
      kind: "serial_device",
      id: port.path,
      path: port.path,
      displayName: port.displayName,
    },
    available: port.available,
    actions: serialActionsForPort(),
  };
}

function serialOpportunityKey(port: SerialPortDescriptor): string {
  return port.path
    .replace("/dev/cu.", "/dev/serial.")
    .replace("/dev/tty.", "/dev/serial.");
}

function shouldReplaceSerialOpportunity(
  existing: LocalHardwareIoOpportunity,
  candidate: SerialPortDescriptor,
): boolean {
  return existing.resource.path.includes("/dev/tty.") && candidate.path.includes("/dev/cu.");
}

export function listHardwareIoOpportunities(
  options: HardwareSerialListOptions = {},
): LocalHardwareIoOpportunityListResult {
  const result = listHardwareSerialPorts(options);
  const opportunitiesByDevice = new Map<string, LocalHardwareIoOpportunity>();
  for (const port of result.ports) {
    if (port.kind !== "usb_serial") {
      continue;
    }
    const key = serialOpportunityKey(port);
    const existing = opportunitiesByDevice.get(key);
    if (!existing || shouldReplaceSerialOpportunity(existing, port)) {
      opportunitiesByDevice.set(key, opportunityForSerialPort(port));
    }
  }
  return {
    providerId: result.providerId,
    platform: result.platform,
    opportunities: [...opportunitiesByDevice.values()].sort((left, right) =>
      left.title.localeCompare(right.title),
    ),
  };
}

export function runHardwareIoAction(
  request: LocalHardwareIoActionRunRequest,
): LocalHardwareIoActionRunResult {
  const startedAt = new Date().toISOString();
  if (request.actionId === "serial.probe" && request.resource.kind !== "serial_device") {
    const finishedAt = new Date().toISOString();
    return {
      providerId: SERIAL_HARDWARE_PROVIDER_ID,
      actionId: request.actionId,
      ok: false,
      message: "serial.probe requires a serial device resource.",
      startedAt,
      finishedAt,
      serialProbe: null,
      process: null,
      error: "unsupported_resource",
    };
  }
  if (request.actionId === "serial.probe") {
    try {
      const serialProbe = probeHardwareSerialPort(request.resource.path);
      const finishedAt = new Date().toISOString();
      return {
        providerId: SERIAL_HARDWARE_PROVIDER_ID,
        actionId: request.actionId,
        ok: serialProbe.available,
        message: serialProbe.available
          ? `Serial probe succeeded for ${serialProbe.path}.`
          : `Serial probe could not fully access ${serialProbe.path}.`,
        startedAt,
        finishedAt,
        serialProbe,
        process: null,
        error: serialProbe.available ? null : (serialProbe.error ?? "serial_not_available"),
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      return {
        providerId: SERIAL_HARDWARE_PROVIDER_ID,
        actionId: request.actionId,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt,
        serialProbe: null,
        process: null,
        error: "action_failed",
      };
    }
  }
  const finishedAt = new Date().toISOString();
  return {
    providerId: SERIAL_HARDWARE_PROVIDER_ID,
    actionId: request.actionId,
    ok: false,
    message: `${request.actionId} is not a runtime-native hardware action.`,
    startedAt,
    finishedAt,
    serialProbe: null,
    process: null,
    error: "action_not_available",
  };
}
