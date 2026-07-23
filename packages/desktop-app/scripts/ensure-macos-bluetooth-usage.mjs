import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const BLUETOOTH_USAGE_DESCRIPTION =
  "Instafy Studio uses Bluetooth to connect to hardware selected by you.";
const DEV_BUNDLE_IDENTIFIER = "dev.instafy.studio.dev";
const DEV_BUNDLE_NAME = "Instafy Studio";

const PREPARED_ELECTRON_APP_DIRNAME = "InstafyBluetoothElectron.app";

function runPlutil(args) {
  return spawnSync("/usr/bin/plutil", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCodesign(args) {
  return spawnSync("/usr/bin/codesign", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runDitto(args) {
  return spawnSync("/usr/bin/ditto", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function upsertPlistString(plistPath, key, value) {
  const replaceResult = runPlutil(["-replace", key, "-string", value, plistPath]);
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = runPlutil(["-insert", key, "-string", value, plistPath]);
  if (insertResult.status === 0) {
    return;
  }

  const detail = [replaceResult.stderr, insertResult.stderr]
    .map((entry) => entry?.trim())
    .filter(Boolean)
    .join("\n");
  throw new Error(detail || `Failed to update ${key} in ${plistPath}.`);
}

function resolveInfoPlistPath(appBinaryPath) {
  if (!appBinaryPath) {
    return null;
  }
  const normalizedPath = path.resolve(appBinaryPath);
  const contentsDir = path.resolve(normalizedPath, "..", "..");
  const infoPlistPath = path.join(contentsDir, "Info.plist");
  if (!infoPlistPath.endsWith(path.join(".app", "Contents", "Info.plist"))) {
    return null;
  }
  return infoPlistPath;
}

function resolveAppBundlePath(appBinaryPath) {
  if (!appBinaryPath) {
    return null;
  }
  const normalizedPath = path.resolve(appBinaryPath);
  const appBundlePath = path.resolve(normalizedPath, "..", "..", "..");
  if (!appBundlePath.endsWith(".app")) {
    return null;
  }
  return appBundlePath;
}

function adHocCodesignApp(appBundlePath) {
  const result = runCodesign(["--force", "--sign", "-", "--timestamp=none", appBundlePath]);
  if (result.status === 0) {
    return;
  }

  const detail = [result.stdout, result.stderr]
    .map((entry) => entry?.trim())
    .filter(Boolean)
    .join("\n");
  throw new Error(detail || `Failed to codesign ${appBundlePath}.`);
}

function resolveBinaryPathFromAppBundle(appBundlePath) {
  return path.join(appBundlePath, "Contents", "MacOS", "Electron");
}

function prepareAppBundleCopy(sourceAppBundlePath, destinationRootDir) {
  const destinationAppBundlePath = path.join(destinationRootDir, PREPARED_ELECTRON_APP_DIRNAME);
  fs.rmSync(destinationAppBundlePath, { recursive: true, force: true });
  fs.mkdirSync(destinationRootDir, { recursive: true });
  const result = runDitto([sourceAppBundlePath, destinationAppBundlePath]);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .map((entry) => entry?.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(detail || `Failed to copy ${sourceAppBundlePath} to ${destinationAppBundlePath}.`);
  }
  return destinationAppBundlePath;
}

export function ensureMacosBluetoothUsageDescription(appBinaryPath) {
  if (process.platform !== "darwin") {
    return appBinaryPath;
  }

  const infoPlistPath = resolveInfoPlistPath(appBinaryPath);
  const appBundlePath = resolveAppBundlePath(appBinaryPath);
  if (!infoPlistPath || !appBundlePath) {
    return appBinaryPath;
  }

  upsertPlistString(infoPlistPath, "NSBluetoothAlwaysUsageDescription", BLUETOOTH_USAGE_DESCRIPTION);
  upsertPlistString(
    infoPlistPath,
    "NSBluetoothPeripheralUsageDescription",
    BLUETOOTH_USAGE_DESCRIPTION,
  );
  upsertPlistString(infoPlistPath, "CFBundleIdentifier", DEV_BUNDLE_IDENTIFIER);
  upsertPlistString(infoPlistPath, "CFBundleName", DEV_BUNDLE_NAME);
  upsertPlistString(infoPlistPath, "CFBundleDisplayName", DEV_BUNDLE_NAME);
  adHocCodesignApp(appBundlePath);
  return resolveBinaryPathFromAppBundle(appBundlePath);
}

export function prepareMacosBluetoothElectronBinary(appBinaryPath, options = {}) {
  if (process.platform !== "darwin") {
    return appBinaryPath;
  }

  const sourceAppBundlePath = resolveAppBundlePath(appBinaryPath);
  if (!sourceAppBundlePath) {
    return appBinaryPath;
  }

  const destinationRootDir =
    options.copyRootDir?.trim() ||
    path.join(os.tmpdir(), "instafy-bluetooth-electron");
  const copiedAppBundlePath = prepareAppBundleCopy(sourceAppBundlePath, destinationRootDir);
  const copiedBinaryPath = resolveBinaryPathFromAppBundle(copiedAppBundlePath);
  return ensureMacosBluetoothUsageDescription(copiedBinaryPath);
}
