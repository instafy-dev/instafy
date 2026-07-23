import kleur from "kleur";
import type {
  LocalHardwareIoOpportunityListResult,
  LocalHardwareIoActionId,
  LocalHardwareIoActionRunResult,
  SerialPortListResult,
  SerialPortProbeResult,
} from "@instafy/sdk/hardware-provider";
import {
  listHardwareIoOpportunities,
  listHardwareSerialPorts,
  probeHardwareSerialPort,
  runHardwareIoAction,
} from "@instafy/sdk/hardware-node";

export interface HardwareSerialListOptions {
  json?: boolean;
  scanDirs?: string[];
}

export interface HardwareSerialProbeOptions {
  device: string;
  json?: boolean;
}

export interface HardwareIoOpportunityOptions {
  json?: boolean;
  scanDirs?: string[];
}

export interface HardwareIoRunOptions {
  actionId: LocalHardwareIoActionId;
  device: string;
  json?: boolean;
}

function printSerialPorts(result: SerialPortListResult) {
  if (result.ports.length === 0) {
    console.log(kleur.yellow("No local serial devices were discovered."));
    return;
  }
  console.log(kleur.cyan(`Local serial devices (${result.platform}):`));
  for (const port of result.ports) {
    const status = port.available ? kleur.green("available") : kleur.yellow("not ready");
    console.log(`- ${port.path} (${port.kind}, ${status})`);
  }
}

function printProbe(probe: SerialPortProbeResult) {
  console.log(kleur.cyan(`Serial device: ${probe.path}`));
  console.log(`Exists: ${probe.exists ? "yes" : "no"}`);
  console.log(`Readable: ${probe.readable ? "yes" : "no"}`);
  console.log(`Writable: ${probe.writable ? "yes" : "no"}`);
  console.log(`Character device: ${probe.isCharacterDevice ? "yes" : "no"}`);
  console.log(`Available: ${probe.available ? kleur.green("yes") : kleur.yellow("no")}`);
  if (probe.error) {
    console.log(`Detail: ${probe.error}`);
  }
}

function printIoOpportunities(result: LocalHardwareIoOpportunityListResult) {
  if (result.opportunities.length === 0) {
    console.log(kleur.yellow("No local IO opportunities were discovered."));
    return;
  }
  console.log(kleur.cyan(`Local IO opportunities (${result.platform}):`));
  for (const opportunity of result.opportunities) {
    const status = opportunity.available ? kleur.green("available") : kleur.yellow("not ready");
    console.log(`- ${opportunity.title} (${status})`);
    console.log(`  Resource: ${opportunity.resource.path}`);
    const available = opportunity.actions
      .filter((action) => action.status === "available")
      .map((action) => action.id);
    const planned = opportunity.actions
      .filter((action) => action.status === "planned")
      .map((action) => action.id);
    if (available.length > 0) {
      console.log(`  Now: ${available.join(", ")}`);
    }
    if (planned.length > 0) {
      console.log(`  Planned: ${planned.join(", ")}`);
    }
  }
}

function printIoActionResult(result: LocalHardwareIoActionRunResult) {
  const status = result.ok ? kleur.green("ok") : kleur.red("failed");
  console.log(kleur.cyan(`Local IO action: ${result.actionId} (${status})`));
  console.log(result.message);
  if (result.serialProbe) {
    printProbe(result.serialProbe);
  }
  if (result.process) {
    const exit = result.process.exitCode ?? result.process.signal ?? "unknown";
    console.log(`Process exit: ${exit}`);
    if (result.process.stdout.trim()) {
      console.log(kleur.dim("stdout:"));
      console.log(result.process.stdout.trimEnd());
    }
    if (result.process.stderr.trim()) {
      console.log(kleur.dim("stderr:"));
      console.log(result.process.stderr.trimEnd());
    }
  }
}

export function hardwareSerialList(options: HardwareSerialListOptions) {
  const result = listHardwareSerialPorts(options);
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  printSerialPorts(result);
}

export function hardwareSerialProbe(options: HardwareSerialProbeOptions) {
  const device = options.device.trim();
  if (!device) {
    throw new Error("Serial device path is required.");
  }
  const result = probeHardwareSerialPort(device);
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  printProbe(result);
}

export function hardwareIoOpportunities(options: HardwareIoOpportunityOptions) {
  const result = listHardwareIoOpportunities(options);
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  printIoOpportunities(result);
}

export function hardwareIoRun(options: HardwareIoRunOptions) {
  const device = options.device.trim();
  if (!device) {
    throw new Error("Serial device path is required for hardware run.");
  }
  const result = runHardwareIoAction({
    actionId: options.actionId,
    resource: {
      kind: "serial_device",
      id: device,
      path: device,
      displayName: device.split("/").filter(Boolean).at(-1) ?? device,
    },
  });
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  printIoActionResult(result);
}
