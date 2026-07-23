#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_BUNDLE_ID = "dev.instafy.studio";
const DEFAULT_TEST_SELECTOR = "AppUITests/AppUITests/testWebViewLoads";
const XCODE_PROJECT_PATH = path.resolve(
  process.cwd(),
  process.env.INSTAFY_IOS_XCODE_PROJECT_PATH?.trim() ||
    "packages/frontend/ios/App/App.xcodeproj",
);
const UI_TEST_CONTEXT_PATH = path.resolve(process.cwd(), "tmp/ios-ui-test-context.json");

function printUsage() {
  console.error(`Usage:
  node scripts/ios-device-debug.mjs status [--udid <udid>] [--json]
  node scripts/ios-device-debug.mjs launch [--udid <udid>] [--bundle-id <id>] [--url <url>] [--console]
  node scripts/ios-device-debug.mjs webview [--udid <udid>] [--timeout <ms>] [--json]
  node scripts/ios-device-debug.mjs uitest [--udid <udid>] [--team <team>] [--test <selector>] [--url <url>] [--derived-data-path <path>] [--result-bundle-path <path>] [--attachments-path <dir>]
  node scripts/ios-device-debug.mjs capture [--udid <udid>] [--team <team>] [--test <selector>] [--url <url>] [--derived-data-path <path>] [--result-bundle-path <path>] [--attachments-path <dir>]`);
}

function formatUiAutomationHint(command) {
  if (command !== "uitest" && command !== "capture") {
    return null;
  }

  return [
    "Apple may require the iPhone passcode whenever a new physical-device UI-automation session starts.",
    "Enter it before the prompt times out; there is no supported passcode bypass for a protected device.",
    "Group related checks in one XCTest session when possible; the test app keeps the phone awake once launched.",
  ].join("\n");
}

function isUiAutomationModeTimeout(output) {
  return /Timed out while enabling automation mode/i.test(output);
}

function isInsufficientStorageInstallError(output) {
  return /Insufficient storage|Not enough space|enough storage|No space left on device/i.test(output);
}

function isUntrustedDeveloperCertificateError(output) {
  return /Developer App Certificate is not trusted|profile has not been explicitly trusted by the user|VPN & Device Management|xctrunner/i.test(
    output,
  );
}

function isMissingXcodeAccountOrProvisioningError(output) {
  return /No Account for Team|No profiles for '|provisioning profiles matching|valid credentials/i.test(
    output,
  );
}

function formatProvisioningAccountHint(teamId) {
  const teamDetail = teamId ? ` for team "${teamId}"` : "";
  return [
    `Xcode cannot sign the physical-device iPhone test bundle${teamDetail}.`,
    "Open Xcode -> Settings -> Accounts and verify the Apple Development account is signed in and valid.",
    "Then let Xcode refresh provisioning profiles for both dev.instafy.studio and dev.instafy.studio.uitests.xctrunner, and rerun.",
  ].join(" ");
}

async function readFailureAttachmentText(attachmentsPath) {
  if (!attachmentsPath || !fs.existsSync(attachmentsPath)) {
    return "";
  }

  try {
    const entries = await fs.promises.readdir(attachmentsPath);
    const textEntries = entries.filter((entry) => entry.toLowerCase().endsWith(".txt"));
    const payloads = await Promise.all(
      textEntries.map(async (entry) => {
        const entryPath = path.join(attachmentsPath, entry);
        const contents = (await readFile(entryPath, "utf8")).trim();
        return contents ? `${entry}:\n${contents}` : "";
      }),
    );
    return payloads.filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  let command = "status";
  const options = {
    udid: null,
    json: false,
    bundleId: DEFAULT_BUNDLE_ID,
    url: null,
    console: false,
    timeoutMs: 12000,
    team: process.env.IOS_DEVELOPMENT_TEAM ?? null,
    test: DEFAULT_TEST_SELECTOR,
    derivedDataPath: null,
    resultBundlePath: null,
    attachmentsPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("-") && command === "status") {
      command = arg;
      continue;
    }
    if (arg === "--udid") {
      options.udid = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--bundle-id") {
      options.bundleId = argv[index + 1] ?? DEFAULT_BUNDLE_ID;
      index += 1;
      continue;
    }
    if (arg === "--url") {
      options.url = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--console") {
      options.console = true;
      continue;
    }
    if (arg === "--timeout") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("Invalid --timeout value.");
      }
      options.timeoutMs = parsed;
      index += 1;
      continue;
    }
    if (arg === "--team") {
      options.team = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--test") {
      options.test = argv[index + 1] ?? DEFAULT_TEST_SELECTOR;
      index += 1;
      continue;
    }
    if (arg === "--derived-data-path") {
      options.derivedDataPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--result-bundle-path") {
      options.resultBundlePath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--attachments-path") {
      options.attachmentsPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, options };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableCoreDeviceError(detail) {
  return /Operation timed out|Connection was invalidated|Transport error|could not be established|Failed to allocate RSD device|unable to locate a device matching the requested device identifier/i.test(
    detail,
  );
}

function runCommand(command, args, { inherit = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    if (!inherit) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
    }

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runCommandOrThrow(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(output || `${command} exited with code ${result.code}.`);
  }
  return result;
}

function runStreamingCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function loadPersistedUiTestContext() {
  try {
    const raw = fs.readFileSync(UI_TEST_CONTEXT_PATH, "utf8");
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object") {
      return {};
    }
    const context = {};
    for (const key of [
      "INSTAFY_UI_TEST_EMAIL",
      "INSTAFY_UI_TEST_PASSWORD",
      "INSTAFY_UI_TEST_PROJECT_ID",
      "INSTAFY_UI_TEST_PROJECT_NAME",
      "INSTAFY_UI_TEST_EXPECT_FRESH_AI_ONBOARDING",
      "INSTAFY_UI_TEST_EXPECT_CHATGPT_DEVICE_CODE_ONBOARDING",
      "INSTAFY_UI_TEST_EXPECT_SHARED_CHAT",
      "INSTAFY_UI_TEST_CONVERSATION_TITLE",
      "INSTAFY_UI_TEST_CONVERSATION_CONTROLLER_ID",
      "INSTAFY_UI_TEST_SHARED_CHAT_INCOMING_TEXT",
      "INSTAFY_UI_TEST_SHARED_CHAT_REPLY_TEXT",
      "INSTAFY_UI_TEST_SHARED_CHAT_FINAL_INCOMING_TEXT",
      "INSTAFY_UI_TEST_SHARED_CHAT_PEER_TYPING_TEXT",
      "INSTAFY_UI_TEST_SHARED_CHAT_PEER_LABEL",
      "INSTAFY_UI_TEST_SHARED_CHAT_TIMEOUT_SECONDS",
      "INSTAFY_UI_TEST_SHARED_CHAT_TYPING_HOLD_SECONDS",
      "INSTAFY_UI_TEST_VOICE_TEXT",
      "INSTAFY_UI_TEST_VOICE_HOST",
    ]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim().length > 0) {
        context[key] = value.trim();
      }
    }
    return context;
  } catch {
    return {};
  }
}

function resolveUiTestContext() {
  return {
    ...loadPersistedUiTestContext(),
    ...uiTestContextFromEnvironment(),
  };
}

function writeUiTestContextFromEnvironment() {
  const context = resolveUiTestContext();

  if (Object.keys(context).length === 0) {
    console.log("[ios-device-debug] No UI test context values were available to persist.");
    return null;
  }

  fs.mkdirSync(path.dirname(UI_TEST_CONTEXT_PATH), { recursive: true });
  fs.writeFileSync(UI_TEST_CONTEXT_PATH, JSON.stringify(context, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  // writeFileSync preserves an existing file's permissions, so enforce the
  // private mode after every overwrite as the context can contain a password.
  fs.chmodSync(UI_TEST_CONTEXT_PATH, 0o600);
  console.log(`[ios-device-debug] Wrote UI test context to ${UI_TEST_CONTEXT_PATH}.`);
  return UI_TEST_CONTEXT_PATH;
}

function uiTestContextFromEnvironment() {
  const context = {};
  for (const key of [
    "INSTAFY_UI_TEST_EMAIL",
    "INSTAFY_UI_TEST_PASSWORD",
    "INSTAFY_UI_TEST_PROJECT_ID",
    "INSTAFY_UI_TEST_PROJECT_NAME",
    "INSTAFY_UI_TEST_EXPECT_FRESH_AI_ONBOARDING",
    "INSTAFY_UI_TEST_EXPECT_CHATGPT_DEVICE_CODE_ONBOARDING",
    "INSTAFY_UI_TEST_EXPECT_SHARED_CHAT",
    "INSTAFY_UI_TEST_CONVERSATION_TITLE",
    "INSTAFY_UI_TEST_CONVERSATION_CONTROLLER_ID",
    "INSTAFY_UI_TEST_SHARED_CHAT_INCOMING_TEXT",
    "INSTAFY_UI_TEST_SHARED_CHAT_REPLY_TEXT",
    "INSTAFY_UI_TEST_SHARED_CHAT_FINAL_INCOMING_TEXT",
    "INSTAFY_UI_TEST_SHARED_CHAT_PEER_TYPING_TEXT",
    "INSTAFY_UI_TEST_SHARED_CHAT_PEER_LABEL",
    "INSTAFY_UI_TEST_SHARED_CHAT_TIMEOUT_SECONDS",
    "INSTAFY_UI_TEST_SHARED_CHAT_TYPING_HOLD_SECONDS",
    "INSTAFY_UI_TEST_VOICE_TEXT",
    "INSTAFY_UI_TEST_VOICE_HOST",
  ]) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      context[key] = value.trim();
    }
  }
  return context;
}

async function waitForResultBundle(resultBundlePath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const infoPlistPath = path.join(resultBundlePath, "Info.plist");
  while (Date.now() < deadline) {
    if (fs.existsSync(infoPlistPath)) {
      return true;
    }
    await delay(500);
  }
  return fs.existsSync(infoPlistPath);
}

function findFirstFileRecursive(rootPath, predicate) {
  const queue = [rootPath];
  while (queue.length > 0) {
    const currentPath = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (predicate(entryPath, entry)) {
        return entryPath;
      }
    }
  }
  return null;
}

function injectUiTestContextIntoTarget(target, context) {
  if (!target || typeof target !== "object") {
    return;
  }
  const mergedEnvironment = {
    ...(target.EnvironmentVariables ?? {}),
    ...context,
  };
  const mergedTestingEnvironment = {
    ...(target.TestingEnvironmentVariables ?? {}),
    ...context,
  };
  target.EnvironmentVariables = mergedEnvironment;
  target.TestingEnvironmentVariables = mergedTestingEnvironment;
  if (target.UITargetAppPath || target.UITargetAppBundleIdentifier || target.UITargetAppEnvironmentVariables) {
    target.UITargetAppEnvironmentVariables = {
      ...(target.UITargetAppEnvironmentVariables ?? {}),
      ...context,
    };
  }
}

async function createInjectedXctestrun({ sourcePath, outputPath, context }) {
  const tempJsonPath = `${outputPath}.json`;
  await runCommandOrThrow("plutil", ["-convert", "json", "-o", tempJsonPath, sourcePath]);
  const payload = JSON.parse(await readFile(tempJsonPath, "utf8"));

  if (Array.isArray(payload?.TestConfigurations)) {
    for (const configuration of payload.TestConfigurations) {
      for (const target of configuration?.TestTargets ?? []) {
        injectUiTestContextIntoTarget(target, context);
      }
    }
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (key === "__xctestrun_metadata__" || key === "CodeCoverageBuildableInfos" || key === "TestPlan") {
        continue;
      }
      injectUiTestContextIntoTarget(value, context);
    }
  }

  fs.writeFileSync(tempJsonPath, JSON.stringify(payload, null, 2), "utf8");
  await runCommandOrThrow("plutil", ["-convert", "xml1", "-o", outputPath, tempJsonPath]);
}

async function runDevicectlJson(args) {
  const maxAttempts = Math.max(
    1,
    Number.parseInt(process.env.IOS_DEVICE_DEBUG_RETRIES ?? "3", 10) || 3,
  );
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "instafy-ios-devicectl-"));
    const jsonPath = path.join(tempDir, "result.json");
    try {
      await runCommandOrThrow("xcrun", ["devicectl", ...args, "--json-output", jsonPath]);
      return JSON.parse(await readFile(jsonPath, "utf8"));
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts || !isRetriableCoreDeviceError(detail)) {
        throw error;
      }
      await delay(1_000 * attempt);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function listDevices() {
  const payload = await runDevicectlJson(["list", "devices"]);
  return payload.result?.devices ?? [];
}

async function resolveDevice(requestedUdid) {
  const devices = await listDevices();
  if (devices.length === 0) {
    throw new Error("No connected iOS devices found.");
  }

  if (requestedUdid) {
    const match = devices.find((device) => {
      return device.hardwareProperties?.udid === requestedUdid || device.identifier === requestedUdid;
    });
    if (!match) {
      throw new Error(`Connected iOS device ${requestedUdid} was not found.`);
    }
    return match;
  }

  if (devices.length > 1) {
    const choices = devices
      .map((device) => `${device.deviceProperties?.name ?? "(unknown)"} (${device.hardwareProperties?.udid ?? device.identifier})`)
      .join(", ");
    throw new Error(`Multiple connected iOS devices found. Pass --udid. (${choices})`);
  }

  return devices[0];
}

async function getLockState(deviceUdid) {
  const payload = await runDevicectlJson(["device", "info", "lockState", "--device", deviceUdid]);
  return payload.result ?? null;
}

async function waitForDeviceUnlocked(device, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastLockState = null;

  while (Date.now() < deadline) {
    lastLockState = await getLockState(device.hardwareProperties.udid).catch(() => lastLockState);
    if (lastLockState?.passcodeRequired !== true) {
      return lastLockState;
    }
    await delay(1_000);
  }

  const deviceName = device.deviceProperties?.name ?? "the connected iPhone";
  throw new Error(
    `${deviceName} is still locked. Unlock the iPhone and keep it awake, then rerun the physical iPhone UI test.`,
  );
}

async function getInstalledApps(deviceIdentifier) {
  const payload = await runDevicectlJson(["device", "info", "apps", "--device", deviceIdentifier]);
  return payload.result?.apps ?? [];
}

async function getTideviceAppInfo(udid, bundleId) {
  const script = `
import ast
import json
import subprocess
import sys

command = [sys.executable, "-m", "tidevice", "-u", sys.argv[1], "appinfo", sys.argv[2]]
completed = subprocess.run(command, capture_output=True, text=True)
if completed.returncode != 0:
    sys.stderr.write(completed.stderr)
    sys.exit(completed.returncode)
payload = completed.stdout.strip()
if not payload:
    sys.exit(0)
print(json.dumps(ast.literal_eval(payload)))
`.trim();
  const result = await runCommandOrThrow("python3", ["-c", script, udid, bundleId]);
  const stdout = result.stdout.trim();
  return stdout ? JSON.parse(stdout) : null;
}

async function getSigningIdentities() {
  const result = await runCommandOrThrow("security", ["find-identity", "-p", "codesigning", "-v"]);
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^\d+\)/u.test(line));
}

async function resolveTeamIdFromXcodeProvisioningAccounts() {
  const result = await runCommand("defaults", [
    "read",
    "com.apple.dt.Xcode",
    "IDEProvisioningTeamByIdentifier",
  ]);
  if (result.code !== 0) {
    return null;
  }

  const teamIds = [...result.stdout.matchAll(/teamID = ([^;]+);/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((candidate) => /^[A-Z0-9]{10}$/u.test(candidate));
  const uniqueTeamIds = [...new Set(teamIds)];
  return uniqueTeamIds.length === 1 ? uniqueTeamIds[0] : null;
}

function resolveTeamIdFromSigningIdentities(identities) {
  if (!Array.isArray(identities) || identities.length === 0) {
    return null;
  }

  const parsedTeamIds = identities
    .map((line) => {
      const match = line.match(/\(([^()]+)\)\s*"?$/u);
      if (!match) {
        return null;
      }
      const candidate = match[1]?.trim() ?? "";
      return /^[A-Z0-9]{10}$/u.test(candidate) ? candidate : null;
    })
    .filter(Boolean);

  const uniqueTeamIds = [...new Set(parsedTeamIds)];
  return uniqueTeamIds.length === 1 ? uniqueTeamIds[0] : null;
}

function decodeProvisioningProfile(profilePath) {
  return new Promise((resolve, reject) => {
    const decodeProcess = spawn("security", ["cms", "-D", "-i", profilePath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const convertProcess = spawn("plutil", ["-convert", "json", "-o", "-", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let decodedStdout = "";
    let decodeStderr = "";
    let convertStderr = "";
    let decodeCode = null;
    let convertCode = null;

    decodeProcess.stdout.pipe(convertProcess.stdin);
    decodeProcess.stderr.on("data", (chunk) => {
      decodeStderr += chunk.toString("utf8");
    });
    convertProcess.stdout.on("data", (chunk) => {
      decodedStdout += chunk.toString("utf8");
    });
    convertProcess.stderr.on("data", (chunk) => {
      convertStderr += chunk.toString("utf8");
    });

    decodeProcess.on("error", reject);
    convertProcess.on("error", reject);

    const maybeFinish = () => {
      if (decodeCode === null || convertCode === null) {
        return;
      }
      if (decodeCode !== 0 || convertCode !== 0) {
        const detail = [decodeStderr.trim(), convertStderr.trim()].filter(Boolean).join("\n");
        reject(new Error(detail || `Unable to decode provisioning profile ${profilePath}.`));
        return;
      }
      try {
        resolve(JSON.parse(decodedStdout));
      } catch (error) {
        reject(error);
      }
    };

    decodeProcess.on("close", (code) => {
      decodeCode = code ?? 1;
      maybeFinish();
    });
    convertProcess.on("close", (code) => {
      convertCode = code ?? 1;
      maybeFinish();
    });
  });
}

async function resolveTeamIdFromProvisioningProfiles(bundleId, udid) {
  const profilesDir = path.join(
    os.homedir(),
    "Library",
    "Developer",
    "Xcode",
    "UserData",
    "Provisioning Profiles",
  );
  let entries = [];
  try {
    entries = fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mobileprovision"))
      .map((entry) => path.join(profilesDir, entry.name));
  } catch {
    return null;
  }

  for (const profilePath of entries) {
    let payload = null;
    try {
      payload = await decodeProvisioningProfile(profilePath);
    } catch {
      continue;
    }
    const appIdentifier = payload?.Entitlements?.["application-identifier"];
    const provisionedDevices = Array.isArray(payload?.ProvisionedDevices) ? payload.ProvisionedDevices : [];
    const teamId =
      payload?.Entitlements?.["com.apple.developer.team-identifier"] ??
      (Array.isArray(payload?.TeamIdentifier) ? payload.TeamIdentifier[0] : null) ??
      (Array.isArray(payload?.ApplicationIdentifierPrefix) ? payload.ApplicationIdentifierPrefix[0] : null);
    if (
      typeof appIdentifier === "string" &&
      appIdentifier.endsWith(`.${bundleId}`) &&
      typeof teamId === "string" &&
      teamId.trim().length > 0 &&
      (provisionedDevices.length === 0 || provisionedDevices.includes(udid))
    ) {
      return teamId.trim();
    }
  }

  return null;
}

async function commandStatus(options) {
  const device = await resolveDevice(options.udid);
  const lockState = await getLockState(device.hardwareProperties.udid);
  const apps = await getInstalledApps(device.identifier);
  const appRow = apps.find((app) => app.bundleIdentifier === options.bundleId) ?? null;
  let appInfo = null;
  if (appRow) {
    try {
      appInfo = await getTideviceAppInfo(device.hardwareProperties.udid, options.bundleId);
    } catch {
      appInfo = null;
    }
  }
  const fallbackTeamId =
    appRow && device.hardwareProperties?.udid
      ? await resolveTeamIdFromProvisioningProfiles(options.bundleId, device.hardwareProperties.udid)
      : null;
  const identities = await getSigningIdentities();

  const summary = {
    device: {
      name: device.deviceProperties?.name ?? null,
      identifier: device.identifier,
      udid: device.hardwareProperties?.udid ?? null,
      model: device.hardwareProperties?.marketingName ?? null,
      productType: device.hardwareProperties?.productType ?? null,
      osVersion: device.deviceProperties?.osVersionNumber ?? null,
      developerModeStatus: device.deviceProperties?.developerModeStatus ?? null,
      screenViewingURL: device.deviceProperties?.screenViewingURL ?? null,
    },
    lockState,
    app: appRow
      ? {
          bundleId: appRow.bundleIdentifier,
          name: appRow.name,
          version: appRow.version,
          build: appRow.bundleVersion,
          teamId:
            appInfo?.Entitlements?.["com.apple.developer.team-identifier"] ??
            fallbackTeamId ??
            null,
          signerIdentity: appInfo?.SignerIdentity ?? null,
        }
      : null,
    signingIdentities: identities,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`${summary.device.name} · ${summary.device.model}`);
  console.log(`UDID: ${summary.device.udid}`);
  console.log(`Device ID: ${summary.device.identifier}`);
  console.log(`OS: ${summary.device.osVersion}`);
  console.log(`Developer mode: ${summary.device.developerModeStatus}`);
  console.log(`Passcode required: ${summary.lockState?.passcodeRequired ? "yes" : "no"}`);
  console.log(`Unlocked since boot: ${summary.lockState?.unlockedSinceBoot ? "yes" : "no"}`);
  if (summary.app) {
    console.log(`App: ${summary.app.name} (${summary.app.bundleId}) v${summary.app.version} (${summary.app.build})`);
    console.log(`Signing team: ${summary.app.teamId ?? "(unknown)"}`);
  } else {
    console.log(`App: ${options.bundleId} is not installed`);
  }
  if (summary.signingIdentities.length > 0) {
    console.log(`Signing identities: ${summary.signingIdentities.length}`);
  }
}

async function commandLaunch(options) {
  const device = await resolveDevice(options.udid);
  const args = [
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    device.hardwareProperties.udid,
    "--terminate-existing",
  ];
  if (options.url) {
    args.push("--payload-url", options.url);
  }
  if (options.console) {
    args.push("--console");
  }
  args.push(options.bundleId);

  await runCommandOrThrow("xcrun", args, { inherit: true });
}

async function prelaunchAppForUiTestIfNeeded(options, deviceUdid) {
  if (!options.url) {
    return;
  }

  const args = [
    "xcrun",
    [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      deviceUdid,
      "--terminate-existing",
      "--payload-url",
      options.url,
      options.bundleId,
    ],
  ];

  try {
    await runCommandOrThrow(args[0], args[1]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to prelaunch ${options.bundleId} for the iPhone UI test with deep link ${options.url}.\n${detail}`,
    );
  }

  await delay(2_000);
}

async function uninstallBundleFromDevice(deviceUdid, bundleId) {
  try {
    await runCommandOrThrow("xcrun", [
      "devicectl",
      "device",
      "uninstall",
      "app",
      "--device",
      deviceUdid,
      bundleId,
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/not installed|could not be found|not found/i.test(detail)) {
      throw new Error(`Unable to uninstall ${bundleId} from iPhone ${deviceUdid}.\n${detail}`);
    }
  }
}

async function installBuiltAppOnDevice({ deviceUdid, appBundlePath, bundleId, allowRetryAfterReset = true }) {
  if (!fs.existsSync(appBundlePath)) {
    throw new Error(`Unable to install ${bundleId} for iPhone UI testing because ${appBundlePath} does not exist.`);
  }

  try {
    await runCommandOrThrow("xcrun", [
      "devicectl",
      "device",
      "install",
      "app",
      "--device",
      deviceUdid,
      appBundlePath,
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (allowRetryAfterReset && isInsufficientStorageInstallError(detail)) {
      console.warn(
        `[ios-device-debug] iPhone install for ${bundleId} failed due to insufficient storage; uninstalling the existing app and retrying.`,
      );
      await uninstallBundleFromDevice(deviceUdid, bundleId);
      await installBuiltAppOnDevice({
        deviceUdid,
        appBundlePath,
        bundleId,
        allowRetryAfterReset: false,
      });
      return;
    }
    throw new Error(
      `Unable to install ${bundleId} onto iPhone ${deviceUdid} from ${appBundlePath}.\n${detail}`,
    );
  }
}

async function readBundleIdentifierFromApp(appBundlePath) {
  const infoPlistPath = path.join(appBundlePath, "Info.plist");
  if (!fs.existsSync(infoPlistPath)) {
    return null;
  }

  try {
    const result = await runCommandOrThrow("plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      infoPlistPath,
    ]);
    const bundleId = result.stdout.trim();
    return bundleId || null;
  } catch {
    return null;
  }
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function resolveUiTestBuildArtifacts(derivedDataPath) {
  const productsPath = path.join(derivedDataPath, "Build", "Products");
  const builtAppPath = path.join(productsPath, "Debug-iphoneos", "App.app");
  const builtUiTestRunnerPath = path.join(
    productsPath,
    "Debug-iphoneos",
    "AppUITests-Runner.app",
  );
  const sourceXctestrunPath = findFirstFileRecursive(
    productsPath,
    (entryPath) => entryPath.endsWith(".xctestrun"),
  );
  return {
    productsPath,
    builtAppPath,
    builtUiTestRunnerPath,
    sourceXctestrunPath,
  };
}

function hasReusableUiTestBuildArtifacts(derivedDataPath) {
  const artifacts = resolveUiTestBuildArtifacts(derivedDataPath);
  return (
    pathExists(artifacts.builtAppPath) &&
    pathExists(artifacts.builtUiTestRunnerPath) &&
    typeof artifacts.sourceXctestrunPath === "string" &&
    pathExists(artifacts.sourceXctestrunPath)
  );
}

async function commandWebview(options) {
  const device = await resolveDevice(options.udid);
  const args = ["scripts/ios-webview.mjs", "list", "--udid", device.hardwareProperties.udid, "--timeout", String(options.timeoutMs)];
  if (options.json) {
    args.push("--json");
  }
  await runCommandOrThrow(process.execPath, args, { inherit: true });
}

async function syncFrontendBundleForPhysicalDevice() {
  if (process.env.IOS_DEVICE_SKIP_CAP_SYNC === "1") {
    return;
  }

  const capacitorFrontendEnv = (process.env.CAPACITOR_FRONTEND_ENV ?? "").trim() || "hosted";
  console.log(
    `[ios-device-debug] Syncing frontend bundle into the iOS app (${capacitorFrontendEnv} mode)...`,
  );
  const syncResult = await runStreamingCommand("pnpm", ["-C", "packages/frontend", "cap:sync"], {
    env: {
      ...process.env,
      CAPACITOR_FRONTEND_ENV: capacitorFrontendEnv,
    },
  });
  if (syncResult.code !== 0) {
    const syncFailureOutput = [syncResult.stderr.trim(), syncResult.stdout.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(syncFailureOutput || `pnpm cap:sync exited with code ${syncResult.code}.`);
  }
}

async function runUiTest(options, { exportAttachments = false } = {}) {
  const device = await resolveDevice(options.udid);
  const xcodeProvisioningTeamId =
    options.team ? null : await resolveTeamIdFromXcodeProvisioningAccounts();
  const appInfo =
    options.team
      ? null
      : await getTideviceAppInfo(device.hardwareProperties.udid, options.bundleId).catch(() => null);
  const fallbackTeamId =
    options.team
      ? null
      : await resolveTeamIdFromProvisioningProfiles(options.bundleId, device.hardwareProperties.udid);
  const signingIdentityTeamId =
    options.team ? null : resolveTeamIdFromSigningIdentities(await getSigningIdentities());
  const teamId =
    options.team ??
    xcodeProvisioningTeamId ??
    appInfo?.Entitlements?.["com.apple.developer.team-identifier"] ??
    fallbackTeamId ??
    signingIdentityTeamId ??
    null;

  if (!teamId) {
    throw new Error(
      "Unable to determine iOS development team. Pass --team or set IOS_DEVELOPMENT_TEAM.",
    );
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "instafy-ios-uitest-"));
  const derivedDataPath =
    options.derivedDataPath != null
      ? path.resolve(process.cwd(), options.derivedDataPath)
      : path.join(tempDir, "DerivedData");
  const resultBundlePath = options.resultBundlePath ?? path.join(tempDir, "AppUITests.xcresult");
  const attachmentsPath =
    options.attachmentsPath ?? (exportAttachments ? path.join(tempDir, "attachments") : null);
  const maxUiAutomationAttempts = Math.max(
    1,
    Number.parseInt(process.env.IOS_UI_TEST_AUTOMATION_RETRIES ?? "2", 10) || 2,
  );
  const uiTestContext = resolveUiTestContext();
  const uiTestContextPath = writeUiTestContextFromEnvironment();

  try {
    await syncFrontendBundleForPhysicalDevice();
    const canReuseBuildArtifacts =
      process.env.IOS_DEVICE_SKIP_CAP_SYNC === "1" && hasReusableUiTestBuildArtifacts(derivedDataPath);

    if (!canReuseBuildArtifacts) {
      const buildForTestingArgs = [
        "-project",
        XCODE_PROJECT_PATH,
        "-scheme",
        "App",
        "-destination",
        `id=${device.hardwareProperties.udid}`,
        "-derivedDataPath",
        derivedDataPath,
        "build-for-testing",
        "-allowProvisioningUpdates",
        "-allowProvisioningDeviceRegistration",
        `DEVELOPMENT_TEAM=${teamId}`,
        "CODE_SIGN_STYLE=Automatic",
      ];

      const buildResult = await runStreamingCommand("xcodebuild", buildForTestingArgs);
      if (buildResult.code !== 0) {
        const buildFailureOutput = [buildResult.stderr.trim(), buildResult.stdout.trim()].filter(Boolean).join("\n");
        if (isMissingXcodeAccountOrProvisioningError(buildFailureOutput)) {
          throw new Error(`${formatProvisioningAccountHint(teamId)}\n\n${buildFailureOutput}`);
        }
        throw new Error(buildFailureOutput || `xcodebuild build-for-testing exited with code ${buildResult.code}.`);
      }
    } else {
      console.log(`[ios-device-debug] Reusing existing build artifacts from ${derivedDataPath}.`);
    }

    const buildArtifacts = resolveUiTestBuildArtifacts(derivedDataPath);
    if (!buildArtifacts.sourceXctestrunPath) {
      throw new Error(`Unable to locate an .xctestrun file under ${buildArtifacts.productsPath}.`);
    }

    const injectedXctestrunPath = path.join(
      path.dirname(buildArtifacts.sourceXctestrunPath),
      "InjectedAppUITests.xctestrun",
    );
    if (Object.keys(uiTestContext).length > 0) {
      await createInjectedXctestrun({
        sourcePath: buildArtifacts.sourceXctestrunPath,
        outputPath: injectedXctestrunPath,
        context: uiTestContext,
      });
    } else {
      fs.copyFileSync(buildArtifacts.sourceXctestrunPath, injectedXctestrunPath);
    }

    const testWithoutBuildingArgs = [
      "test-without-building",
      "-xctestrun",
      injectedXctestrunPath,
      "-destination",
      `id=${device.hardwareProperties.udid}`,
      "-only-testing:" + options.test,
      "-resultBundlePath",
      resultBundlePath,
      "-collect-test-diagnostics",
      "never",
    ];

    // Build while the phone may remain locked, then ask for one unlock as late
    // as possible. The XCTest-only app hook keeps the device awake from launch.
    await waitForDeviceUnlocked(device, 30_000);
    await installBuiltAppOnDevice({
      deviceUdid: device.hardwareProperties.udid,
      appBundlePath: buildArtifacts.builtAppPath,
      bundleId: options.bundleId,
    });
    const uiTestRunnerBundleId = await readBundleIdentifierFromApp(buildArtifacts.builtUiTestRunnerPath);
    if (uiTestRunnerBundleId) {
      await installBuiltAppOnDevice({
        deviceUdid: device.hardwareProperties.udid,
        appBundlePath: buildArtifacts.builtUiTestRunnerPath,
        bundleId: uiTestRunnerBundleId,
      });
    }
    await prelaunchAppForUiTestIfNeeded(options, device.hardwareProperties.udid);

    let lastFailureOutput = "";
    for (let attempt = 1; attempt <= maxUiAutomationAttempts; attempt += 1) {
      if (attempt > 1) {
        console.warn(
          `Retrying physical iPhone UI automation after Apple automation-mode timeout (${attempt}/${maxUiAutomationAttempts})...`,
        );
        await delay(3_000);
        await waitForDeviceUnlocked(device, 30_000);
        await prelaunchAppForUiTestIfNeeded(options, device.hardwareProperties.udid);
      }

      await rm(resultBundlePath, { recursive: true, force: true }).catch(() => {});
      if (attachmentsPath) {
        await rm(attachmentsPath, { recursive: true, force: true }).catch(() => {});
      }

      const testResult = await runStreamingCommand("xcodebuild", testWithoutBuildingArgs);
      const resultBundleReady = await waitForResultBundle(resultBundlePath).catch(() => false);

      let attachmentExportError = null;
      if (attachmentsPath && resultBundleReady) {
        const exportResult = await runCommand("xcrun", [
          "xcresulttool",
          "export",
          "attachments",
          "--path",
          resultBundlePath,
          "--output-path",
          attachmentsPath,
        ]);
        if (exportResult.code !== 0) {
          attachmentExportError = [exportResult.stderr.trim(), exportResult.stdout.trim()]
            .filter(Boolean)
            .join("\n");
        }
      }

      if (testResult.code === 0) {
        if (attachmentExportError) {
          throw new Error(attachmentExportError);
        }
        lastFailureOutput = "";
        break;
      }

      const failureAttachmentText =
        attachmentsPath && resultBundleReady ? await readFailureAttachmentText(attachmentsPath) : "";
      lastFailureOutput = [testResult.stderr.trim(), testResult.stdout.trim(), failureAttachmentText]
        .filter(Boolean)
        .join("\n");
      const shouldRetryAutomationTimeout =
        attempt < maxUiAutomationAttempts && isUiAutomationModeTimeout(lastFailureOutput);
      if (shouldRetryAutomationTimeout) {
        console.warn(
          "Apple timed out while enabling UI automation on the physical iPhone. " +
            "Keeping the device awake and retrying once.",
        );
        continue;
      }

      const attachmentHint =
        attachmentsPath && resultBundleReady
          ? `\n\nResult bundle: ${resultBundlePath}\nAttachments: ${attachmentsPath}`
          : "";
      if (isUntrustedDeveloperCertificateError(lastFailureOutput)) {
        throw new Error(
          "The physical iPhone UI test runner is installed but not trusted on the device. " +
            "On the iPhone, open Settings -> General -> VPN & Device Management and trust the Developer App certificate, then rerun." +
            attachmentHint,
        );
      }
      if (isMissingXcodeAccountOrProvisioningError(lastFailureOutput)) {
        throw new Error(`${formatProvisioningAccountHint(teamId)}${attachmentHint}\n\n${lastFailureOutput}`);
      }
      throw new Error((lastFailureOutput || `xcodebuild exited with code ${testResult.code}.`) + attachmentHint);
    }

    if (lastFailureOutput) {
      const resultBundleReady = await waitForResultBundle(resultBundlePath).catch(() => false);
      const attachmentHint =
        attachmentsPath && resultBundleReady
          ? `\n\nResult bundle: ${resultBundlePath}\nAttachments: ${attachmentsPath}`
          : "";
      throw new Error((lastFailureOutput || "xcodebuild exited with a physical iPhone automation failure.") + attachmentHint);
    }
  } finally {
    // Keep the context file on disk for local physical-device debugging.
    // Each new run overwrites it.
    void uiTestContextPath;
  }

  const summary = {
    device: {
      name: device.deviceProperties?.name ?? null,
      udid: device.hardwareProperties?.udid ?? null,
    },
    teamId,
    bundleId: options.bundleId,
    test: options.test,
    resultBundlePath,
    attachmentsPath,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`iPhone UI test succeeded on ${summary.device.name} (${summary.device.udid}).`);
  console.log(`Team: ${summary.teamId}`);
  console.log(`Result bundle: ${summary.resultBundlePath}`);
  if (summary.attachmentsPath) {
    console.log(`Attachments: ${summary.attachmentsPath}`);
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "status") {
    await commandStatus(options);
    return;
  }
  if (command === "launch") {
    await commandLaunch(options);
    return;
  }
  if (command === "webview") {
    await commandWebview(options);
    return;
  }
  if (command === "uitest") {
    await runUiTest(options);
    return;
  }
  if (command === "capture") {
    await runUiTest(options, { exportAttachments: true });
    return;
  }

  throw new Error(`Unsupported command: ${command}`);
}

main().catch((error) => {
  let command = "status";
  try {
    command = parseArgs(process.argv.slice(2)).command;
  } catch {
    // Ignore secondary parse failures while rendering the original error.
  }

  const message = error instanceof Error ? error.message : String(error);
  const shouldPrintUsage = /Unknown argument:|Unsupported command:|Invalid --timeout value\./.test(
    message,
  );
  const hint = formatUiAutomationHint(command);
  if (shouldPrintUsage) {
    printUsage();
  }
  console.error(message);
  if (hint) {
    console.error(`\n${hint}`);
  }
  process.exit(1);
});
