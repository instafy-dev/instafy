#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "packages", "frontend");
const syncedAssetRoot = path.join(
  frontendRoot,
  "android",
  "app",
  "src",
  "main",
  "assets",
  "public",
  "assets",
);
const appId = process.env.ANDROID_APP_ID?.trim() || "dev.instafy.studio";
const mainActivity = process.env.ANDROID_MAIN_ACTIVITY?.trim() || ".MainActivity";
let adbPath = null;
let serial = null;
let chromium = null;
let settleMs = 12_000;
let reportPath = null;

const helpText = `Usage: node scripts/android-debug-ota-proof.mjs

Prove that a connected Android debug app is using its synced Capacitor assets and
cannot reselect a native Live Update bundle. The proof is repeated after a cold
process relaunch and does not require authentication or a controller fixture.

Environment:
  ANDROID_ADB                   adb executable (otherwise PATH/Android SDK is used)
  ANDROID_DEVICE_SERIAL         device serial (required when more than one is ready)
  ANDROID_APP_ID                package id (default: dev.instafy.studio)
  ANDROID_MAIN_ACTIVITY         launch activity (default: .MainActivity)
  ANDROID_OTA_PROOF_WAIT_MS     post-launch observation window (default: 12000)
  ANDROID_OTA_PROOF_REPORT      optional JSON report output path
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(helpText);
  process.exit(0);
}
if (process.argv.length > 2) {
  throw new Error(`Unknown argument: ${process.argv[2]}. Use --help for usage.`);
}

function readPositiveInteger(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function executableName() {
  return process.platform === "win32" ? "adb.exe" : "adb";
}

function executableCandidate(value) {
  if (!value) return null;
  const candidate = path.resolve(value);
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function resolveFromPath(command) {
  if (command.includes(path.sep) || (process.platform === "win32" && command.includes("/"))) {
    return executableCandidate(command);
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const resolved = executableCandidate(path.join(directory, command));
    if (resolved) return resolved;
  }
  return null;
}

function resolveAdb() {
  const explicit = process.env.ANDROID_ADB?.trim();
  if (explicit) {
    const resolved = resolveFromPath(explicit);
    if (resolved) return resolved;
    throw new Error(`ANDROID_ADB does not resolve to an executable: ${explicit}`);
  }

  const fromPath = resolveFromPath(executableName());
  if (fromPath) return fromPath;

  const sdkCandidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ].filter(Boolean);
  for (const sdkRoot of sdkCandidates) {
    const resolved = executableCandidate(path.join(sdkRoot, "platform-tools", executableName()));
    if (resolved) return resolved;
  }
  throw new Error("Unable to find adb. Set ANDROID_ADB, add adb to PATH, or configure ANDROID_SDK_ROOT/ANDROID_HOME.");
}

function runAdb(adb, args, options = {}) {
  return execFileSync(adb, args, {
    cwd: repoRoot,
    encoding: Object.prototype.hasOwnProperty.call(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function parseDevices(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices") && !line.startsWith("* daemon"))
    .map((line) => {
      const [deviceSerial, state = "unknown"] = line.split(/\s+/u);
      return { serial: deviceSerial, state };
    });
}

function selectDevice(adb) {
  const devices = parseDevices(runAdb(adb, ["devices"]));
  const requestedSerial = process.env.ANDROID_DEVICE_SERIAL?.trim();
  if (requestedSerial) {
    const requested = devices.find((device) => device.serial === requestedSerial);
    assert(requested, `ANDROID_DEVICE_SERIAL ${requestedSerial} is not listed by adb.`);
    assert.equal(requested.state, "device", `Android device ${requestedSerial} is ${requested.state}, not ready.`);
    return requestedSerial;
  }
  const ready = devices.filter((device) => device.state === "device");
  assert(ready.length > 0, "No ready Android device found. Unlock the phone and approve USB debugging.");
  assert.equal(
    ready.length,
    1,
    `More than one Android device is ready (${ready.map((device) => device.serial).join(", ")}); set ANDROID_DEVICE_SERIAL.`,
  );
  return ready[0].serial;
}

function adb(args, options = {}) {
  assert(adbPath && serial, "Android device setup is incomplete.");
  return runAdb(adbPath, ["-s", serial, ...args], options);
}

function adbOptional(args) {
  try {
    return adb(args).trim();
  } catch (error) {
    return typeof error?.stdout === "string" ? error.stdout.trim() : "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPid() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pid = adbOptional(["shell", "pidof", appId]).split(/\s+/u).find(Boolean);
    if (pid) return pid;
    await sleep(300);
  }
  throw new Error(`Android process ${appId} did not start.`);
}

async function waitForCdp(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok && (await response.json()).some((target) => target.type === "page")) return;
    } catch {
      // The WebView is still starting.
    }
    await sleep(400);
  }
  throw new Error("Android WebView CDP did not become ready. Confirm that a debuggable APK is installed.");
}

async function connectToWebView() {
  adb(["shell", "am", "start", "-W", "-n", `${appId}/${mainActivity}`]);
  const pid = await waitForPid();
  const portOutput = adb([
    "forward",
    "tcp:0",
    `localabstract:webview_devtools_remote_${pid}`,
  ]).trim();
  const port = Number(portOutput);
  assert(Number.isSafeInteger(port) && port > 0, `adb did not allocate a WebView forwarding port: ${portOutput}`);
  try {
    await waitForCdp(port);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context?.pages().find((candidate) => candidate.url() !== "about:blank") || context?.pages()[0];
    assert(page, "No page target was exposed by the Android WebView.");
    return { browser, page, pid, port };
  } catch (error) {
    adbOptional(["forward", "--remove", `tcp:${port}`]);
    throw error;
  }
}

async function disconnectFromWebView(session) {
  if (!session) return;
  await session.browser.close().catch(() => {});
  adbOptional(["forward", "--remove", `tcp:${session.port}`]);
}

function nativeFilesystemState() {
  assert.match(adb(["shell", "run-as", appId, "id"]), /uid=/u, `run-as ${appId} failed; install a debuggable APK.`);
  const bundleOutput = adbOptional([
    "shell",
    "run-as",
    appId,
    "find",
    "files/_capacitor_live_update_bundles",
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-print",
  ]);
  const preferenceOutput = adbOptional([
    "shell",
    "run-as",
    appId,
    "find",
    "shared_prefs",
    "-maxdepth",
    "1",
    "-type",
    "f",
    "-name",
    "CapawesomeLiveUpdate.xml",
    "-print",
  ]);
  return {
    retainedBundleEntries: bundleOutput ? bundleOutput.split(/\r?\n/u).filter(Boolean).sort() : [],
    liveUpdatePreferenceXmlPresent: Boolean(preferenceOutput),
  };
}

function assetRole(file) {
  if (/^StudioRoute-[^.]+\.js$/u.test(file)) return "StudioRoute";
  if (/^StudioProviders-[^.]+\.js$/u.test(file)) return "StudioProviders";
  if (/^index-[^.]+\.js$/u.test(file)) return "index";
  return null;
}

async function loadProofRoute(page) {
  const current = new URL(page.url());
  const target = new URL("/studio", current.origin);
  await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => {
    const files = performance.getEntriesByType("resource").map((entry) => {
      try {
        return new URL(entry.name).pathname.split("/").pop() || "";
      } catch {
        return "";
      }
    });
    return files.some((file) => /^index-[^.]+\.js$/u.test(file))
      && files.some((file) => /^StudioRoute-[^.]+\.js$/u.test(file))
      && files.some((file) => /^StudioProviders-[^.]+\.js$/u.test(file));
  }, null, { timeout: 30_000 });
}

async function readNativeState(page) {
  const deadline = Date.now() + 20_000;
  let state = null;
  while (Date.now() < deadline) {
    state = await page.evaluate(async () => {
      const runtimeMethod = window.Capacitor?.Plugins?.InstafyRuntimeConfig?.getRuntimeConfig;
      const bundleMethod = window.Capacitor?.Plugins?.LiveUpdate?.getCurrentBundle;
      if (typeof runtimeMethod !== "function" || typeof bundleMethod !== "function") return null;
      return {
        runtimeConfig: await runtimeMethod(),
        currentBundle: await bundleMethod(),
      };
    });
    if (state) break;
    await sleep(250);
  }
  assert(state, "InstafyRuntimeConfig or LiveUpdate is unavailable in the Android WebView.");
  assert.equal(
    state.runtimeConfig?.disableNativeOta,
    true,
    "InstafyRuntimeConfig.disableNativeOta must be true in a debug APK.",
  );
  assert.equal(
    state.currentBundle?.bundleId,
    null,
    `LiveUpdate selected native bundle ${state.currentBundle?.bundleId ?? "<missing>"}; expected null.`,
  );
  return {
    disableNativeOta: state.runtimeConfig.disableNativeOta,
    currentBundleId: state.currentBundle.bundleId,
  };
}

async function readLoadedAssets(page) {
  const encodedAssets = await page.evaluate(async () => {
    const candidates = [...new Set(performance.getEntriesByType("resource").map((entry) => entry.name))]
      .map((url) => {
        try {
          const file = new URL(url).pathname.split("/").pop() || "";
          return /^(?:index|StudioRoute|StudioProviders)-[^.]+\.js$/u.test(file) ? { file, url } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const results = [];
    for (const candidate of candidates) {
      const response = await fetch(candidate.url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to read loaded asset ${candidate.file}: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
      }
      results.push({ file: candidate.file, base64: btoa(binary) });
    }
    return results;
  });

  const assets = encodedAssets.map(({ file, base64 }) => {
    const role = assetRole(file);
    assert(role, `Unexpected proof asset name: ${file}`);
    const localPath = path.join(syncedAssetRoot, path.basename(file));
    assert(fs.existsSync(localPath), `Loaded WebView asset ${file} is absent from the synced Android bundle.`);
    const loadedBytes = Buffer.from(base64, "base64");
    const syncedBytes = fs.readFileSync(localPath);
    assert(
      loadedBytes.equals(syncedBytes),
      `Loaded WebView asset ${file} is not byte-identical to packages/frontend/android assets.`,
    );
    return {
      role,
      file,
      bytes: loadedBytes.byteLength,
      sha256: crypto.createHash("sha256").update(loadedBytes).digest("hex"),
    };
  }).sort((left, right) => left.file.localeCompare(right.file));

  for (const role of ["index", "StudioRoute", "StudioProviders"]) {
    assert(assets.some((asset) => asset.role === role), `No loaded ${role} JavaScript asset was found.`);
  }
  return assets;
}

async function verifyPhase(label) {
  let session = null;
  try {
    session = await connectToWebView();
    await loadProofRoute(session.page);
    await sleep(settleMs);
    const native = await readNativeState(session.page);
    const filesystem = nativeFilesystemState();
    assert.deepEqual(
      filesystem.retainedBundleEntries,
      [],
      `${label}: the debug app downloaded or retained content in the native OTA bundle directory.`,
    );
    const assets = await readLoadedAssets(session.page);
    return {
      pid: session.pid,
      url: session.page.url(),
      native,
      filesystem,
      assets,
    };
  } finally {
    await disconnectFromWebView(session);
  }
}

async function main() {
  settleMs = readPositiveInteger("ANDROID_OTA_PROOF_WAIT_MS", 12_000);
  reportPath = process.env.ANDROID_OTA_PROOF_REPORT?.trim()
    ? path.resolve(process.env.ANDROID_OTA_PROOF_REPORT.trim())
    : null;
  adbPath = resolveAdb();
  serial = selectDevice(adbPath);
  const requireFromFrontend = createRequire(path.join(frontendRoot, "package.json"));
  ({ chromium } = requireFromFrontend("@playwright/test"));
  const initial = await verifyPhase("initial launch");
  adb(["shell", "am", "force-stop", appId]);
  await sleep(500);
  const relaunch = await verifyPhase("cold relaunch");
  const report = {
    ok: true,
    appId,
    serial,
    settleMs,
    initial,
    relaunch,
  };
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
