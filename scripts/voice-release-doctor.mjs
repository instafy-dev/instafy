#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function usage() {
  console.log(
    [
      "Usage: node scripts/voice-release-doctor.mjs [--serial <adb-serial>] [--udid <ios-udid>] [--json]",
      "",
      "Checks which voice validation lanes are runnable from the current machine state:",
      "- core release lane",
      "- Android hardware lane",
      "- full Android + physical iPhone hardware lane",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    serial: process.env.ANDROID_DEVICE_SERIAL?.trim() || "",
    udid: process.env.IOS_DEVICE_UDID?.trim() || "",
    json: false,
    require: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--serial" && argv[index + 1]) {
      options.serial = argv[++index].trim();
      continue;
    }
    if (arg === "--udid" && argv[index + 1]) {
      options.udid = argv[++index].trim();
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--require" && argv[index + 1]) {
      options.require = argv[++index].trim();
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveAdbPath() {
  const binaryName = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [
    process.env.ANDROID_ADB,
    process.env.ADB,
    process.env.ANDROID_SDK_ROOT
      ? path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", binaryName)
      : null,
    process.env.ANDROID_HOME
      ? path.join(process.env.ANDROID_HOME, "platform-tools", binaryName)
      : null,
    path.join(os.homedir(), "Library", "Android", "sdk", "platform-tools", binaryName),
  ].filter((value) => typeof value === "string" && value.trim().length > 0);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function parseAndroidDevices(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices attached"))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      return { serial, state, detail: rest.join(" ") };
    })
    .filter((entry) => entry.serial && entry.state === "device");
}

async function getAndroidResumedActivity(adbPath, serial) {
  const args = serial
    ? ["-s", serial, "shell", "dumpsys", "activity", "activities"]
    : ["shell", "dumpsys", "activity", "activities"];
  const result = await runCommand(adbPath, args);
  if (result.code !== 0) {
    return null;
  }
  const match = result.stdout.match(/mResumedActivity:.*?\s([A-Za-z0-9._$]+)\/([A-Za-z0-9._$/]+)\s/);
  if (!match) {
    return null;
  }
  return {
    packageName: match[1],
    activity: match[2],
  };
}

function androidLooksLocked(resumed) {
  if (!resumed || resumed.packageName !== "com.android.systemui") {
    return false;
  }
  return /keyguard|bouncer|password|pin/i.test(`${resumed.activity}`);
}

async function getAndroidStatus(preferredSerial) {
  const adbPath = resolveAdbPath();
  if (!adbPath) {
    return {
      ready: false,
      reason: "adb is not available. Set ANDROID_HOME, ANDROID_SDK_ROOT, ANDROID_ADB, or ADB.",
      serial: null,
    };
  }

  const result = await runCommand(adbPath, ["devices", "-l"]);
  if (result.code !== 0) {
    return {
      ready: false,
      reason: result.stderr.trim() || "Unable to list adb devices.",
      serial: null,
    };
  }

  const devices = parseAndroidDevices(result.stdout);
  if (preferredSerial) {
    const match = devices.find((device) => device.serial === preferredSerial);
    if (!match) {
      return {
        ready: false,
        reason: `Android device ${preferredSerial} is not connected over adb.`,
        serial: preferredSerial,
      };
    }
    const resumed = await getAndroidResumedActivity(adbPath, preferredSerial);
    if (androidLooksLocked(resumed)) {
      return {
        ready: false,
        reason: "Android phone is connected but locked.",
        serial: preferredSerial,
      };
    }
    return {
      ready: true,
      reason: "Android phone is connected and appears unlocked.",
      serial: preferredSerial,
    };
  }

  if (devices.length === 0) {
    return {
      ready: false,
      reason: "No Android phone is connected over adb.",
      serial: null,
    };
  }
  if (devices.length > 1) {
    return {
      ready: false,
      reason: `Multiple Android phones are connected (${devices.map((device) => device.serial).join(", ")}). Pass --serial.`,
      serial: null,
    };
  }

  const serial = devices[0].serial;
  const resumed = await getAndroidResumedActivity(adbPath, serial);
  if (androidLooksLocked(resumed)) {
    return {
      ready: false,
      reason: "Android phone is connected but locked.",
      serial,
    };
  }
  return {
    ready: true,
    reason: "Android phone is connected and appears unlocked.",
    serial,
  };
}

async function getIosStatus(preferredUdid) {
  const args = ["scripts/ios-device-debug.mjs", "status", "--json"];
  if (preferredUdid) {
    args.push("--udid", preferredUdid);
  }
  const result = await runCommand(process.execPath, args);
  if (result.code !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    return {
      ready: false,
      reason: detail || "No usable physical iPhone is available.",
      udid: preferredUdid || null,
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return {
      ready: false,
      reason: "Unable to parse iPhone status output.",
      udid: preferredUdid || null,
    };
  }

  const passcodeRequired = payload?.lockState?.passcodeRequired === true;
  const developerModeStatus = payload?.device?.developerModeStatus ?? null;
  const udid = payload?.device?.udid ?? preferredUdid ?? null;
  const teamId = payload?.app?.teamId ?? null;

  if (passcodeRequired) {
    return {
      ready: false,
      reason: "Physical iPhone is connected but locked.",
      udid,
      developerModeStatus,
      teamId,
    };
  }

  return {
    ready: true,
    reason: "Physical iPhone is connected and appears unlocked.",
    udid,
    developerModeStatus,
    teamId,
  };
}

function buildSummary(androidStatus, iosStatus) {
  return {
    lanes: {
      core: {
        ready: true,
        command: "pnpm test:voice:release",
        reason: "Core voice release lane is hardware-free.",
      },
      android: {
        ready: androidStatus.ready,
        command: "pnpm test:voice:release:android",
        reason: androidStatus.reason,
      },
      hardware: {
        ready: androidStatus.ready && iosStatus.ready,
        command: "pnpm test:voice:release:hardware",
        reason:
          androidStatus.ready && iosStatus.ready
            ? "Android and physical iPhone are both ready."
            : [androidStatus.ready ? null : `Android: ${androidStatus.reason}`, iosStatus.ready ? null : `iPhone: ${iosStatus.reason}`]
                .filter(Boolean)
                .join(" "),
      },
    },
    devices: {
      android: androidStatus,
      ios: iosStatus,
    },
  };
}

function printHumanSummary(summary) {
  const icon = (ready) => (ready ? "ready" : "blocked");
  console.log("Voice validation lanes:");
  console.log(`- Core: ${icon(summary.lanes.core.ready)} · ${summary.lanes.core.command}`);
  console.log(`  ${summary.lanes.core.reason}`);
  console.log(`- Android: ${icon(summary.lanes.android.ready)} · ${summary.lanes.android.command}`);
  console.log(`  ${summary.lanes.android.reason}`);
  console.log(`- Hardware: ${icon(summary.lanes.hardware.ready)} · ${summary.lanes.hardware.command}`);
  console.log(`  ${summary.lanes.hardware.reason}`);
  if (summary.devices.android.serial) {
    console.log(`- Android serial: ${summary.devices.android.serial}`);
  }
  if (summary.devices.ios.udid) {
    console.log(`- iPhone UDID: ${summary.devices.ios.udid}`);
  }
}

function laneReady(summary, requiredLane) {
  if (!requiredLane) {
    return true;
  }
  if (!(requiredLane in summary.lanes)) {
    throw new Error(`Unknown lane requirement: ${requiredLane}`);
  }
  return summary.lanes[requiredLane].ready;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [androidStatus, iosStatus] = await Promise.all([
    getAndroidStatus(options.serial),
    getIosStatus(options.udid),
  ]);
  const summary = buildSummary(androidStatus, iosStatus);

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    if (!laneReady(summary, options.require)) {
      process.exitCode = 1;
    }
    return;
  }

  printHumanSummary(summary);
  if (!laneReady(summary, options.require)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    `[voice-release-doctor] ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exit(1);
});
