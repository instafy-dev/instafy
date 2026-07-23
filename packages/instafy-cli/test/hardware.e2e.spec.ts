import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function execCli(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const entry = "dist/index.js";
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn("node", [entry, ...args], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, ...(opts?.env ?? {}) },
      cwd: new URL("../", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutPromise = readAll(child.stdout);
    const stderrPromise = readAll(child.stderr);
    const [code] = (await once(child, "exit")) as [number | null];
    return {
      code,
      stdout: await stdoutPromise,
      stderr: await stderrPromise,
    };
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

describe("hardware serial CLI", () => {
  it("lists host serial candidates through a deterministic scan directory", async () => {
    const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-serial-dev-"));
    try {
      fs.writeFileSync(path.join(scanDir, "cu.usbserial-test"), "");
      fs.writeFileSync(path.join(scanDir, "tty.Bluetooth-Incoming-Port"), "");
      fs.writeFileSync(path.join(scanDir, "not-a-serial-port"), "");

      const result = await execCli([
        "hardware",
        "serial",
        "list",
        "--scan-dir",
        scanDir,
        "--json",
      ]);

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        providerId: string;
        ports: Array<{ path: string; kind: string; available: boolean }>;
      };
      expect(payload.providerId).toBe("hardware.serial");
      expect(payload.ports.map((port) => path.basename(port.path))).toEqual([
        "cu.usbserial-test",
        "tty.Bluetooth-Incoming-Port",
      ]);
      expect(payload.ports.map((port) => port.kind)).toEqual([
        "usb_serial",
        "bluetooth_serial",
      ]);
      expect(payload.ports.every((port) => port.available === false)).toBe(true);
    } finally {
      fs.rmSync(scanDir, { recursive: true, force: true });
    }
  });

  it("probes a serial path without requiring the device to be usable", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-serial-probe-"));
    try {
      const fakeDevice = path.join(tmpDir, "cu.usbserial-test");
      fs.writeFileSync(fakeDevice, "");

      const result = await execCli([
        "hardware",
        "serial",
        "probe",
        "--device",
        fakeDevice,
        "--json",
      ]);

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        providerId: string;
        path: string;
        exists: boolean;
        isCharacterDevice: boolean;
        available: boolean;
      };
      expect(payload).toMatchObject({
        providerId: "hardware.serial",
        path: fakeDevice,
        exists: true,
        isCharacterDevice: false,
        available: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("discovers and runs runtime-native serial IO actions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-serial-action-"));
    try {
      const scanDir = path.join(tmpDir, "dev");
      fs.mkdirSync(scanDir, { recursive: true });
      fs.writeFileSync(path.join(scanDir, "cu.usbserial-test"), "");

      const opportunities = await execCli([
        "hardware",
        "opportunities",
        "--scan-dir",
        scanDir,
        "--json",
      ]);

      expect(opportunities.code).toBe(0);
      const opportunityPayload = JSON.parse(opportunities.stdout) as {
        opportunities: Array<{
          kind: string;
          actions: Array<{ id: string; label: string; source?: string; status: string }>;
        }>;
      };
      const serialOpportunity = opportunityPayload.opportunities.find(
        (opportunity) => opportunity.kind === "usb_serial_device",
      );
      expect(serialOpportunity).toMatchObject({
        kind: "usb_serial_device",
      });
      expect(serialOpportunity?.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "serial.probe",
            label: "Probe",
            source: "runtime",
            status: "available",
          }),
        ]),
      );
      expect(
        opportunityPayload.opportunities.some(
          (opportunity) => opportunity.kind === "runtime_host",
        ),
      ).toBe(false);

      const fakeDevice = path.join(scanDir, "cu.usbserial-test");
      const run = await execCli([
        "hardware",
        "run",
        "serial.probe",
        "--device",
        fakeDevice,
        "--json",
      ]);

      expect(run.code).toBe(0);
      const runPayload = JSON.parse(run.stdout) as {
        ok: boolean;
        actionId: string;
        message: string;
        process?: { exitCode: number | null; stdout: string };
      };
      expect(runPayload).toMatchObject({
        ok: false,
        actionId: "serial.probe",
        message: `Serial probe could not fully access ${fakeDevice}.`,
      });
      expect(runPayload.process).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("grants, shows, and revokes project-scoped local hardware bindings", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-hardware-binding-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".instafy"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".instafy", "space.json"),
        JSON.stringify(
          {
            spaceId: "space-test",
          },
          null,
          2,
        ),
      );
      const fakeDevice = path.join(tmpDir, "cu.usbserial-test");

      const grant = await execCli(
        [
          "hardware",
          "bindings",
          "grant",
          "hardware.serial",
          "--path",
          tmpDir,
          "--purpose",
          "Probe the attached ESP32 board",
          "--device",
          fakeDevice,
          "--json",
        ],
        { cwd: tmpDir },
      );

      expect(grant.code).toBe(0);
      expect(JSON.parse(grant.stdout)).toMatchObject({
        providerId: "hardware.serial",
        projectId: "space-test",
        grantedCapabilities: ["hardware_serial_list", "hardware_serial_probe"],
        grantedResources: [
          {
            kind: "serial_device",
            id: fakeDevice,
            path: fakeDevice,
            displayName: "cu.usbserial-test",
          },
        ],
        purpose: "Probe the attached ESP32 board",
        status: "bound",
      });

      const bindingsPath = path.join(tmpDir, ".instafy", "hardware-bindings.json");
      expect(fs.existsSync(bindingsPath)).toBe(true);
      const stored = JSON.parse(fs.readFileSync(bindingsPath, "utf8")) as {
        version: number;
        bindings: Record<string, unknown>;
      };
      expect(stored.version).toBe(1);
      expect(stored.bindings).toHaveProperty("hardware.serial");

      const show = await execCli(
        ["hardware", "bindings", "show", "hardware.serial", "--path", tmpDir, "--json"],
        { cwd: tmpDir },
      );
      expect(show.code).toBe(0);
      expect(JSON.parse(show.stdout)).toMatchObject({
        providerId: "hardware.serial",
        projectId: "space-test",
        status: "bound",
      });

      const revoke = await execCli(
        ["hardware", "bindings", "revoke", "hardware.serial", "--path", tmpDir, "--json"],
        { cwd: tmpDir },
      );
      expect(revoke.code).toBe(0);
      expect(JSON.parse(revoke.stdout)).toEqual({
        revoked: true,
        providerId: "hardware.serial",
      });

      const finalStore = JSON.parse(fs.readFileSync(bindingsPath, "utf8")) as {
        version: number;
        bindings: Record<string, unknown>;
      };
      expect(finalStore.version).toBe(1);
      expect(finalStore.bindings).toEqual({});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
