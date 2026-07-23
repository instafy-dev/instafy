#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_BUNDLE_ID = "dev.instafy.studio";
const DEFAULT_TEST_SELECTOR = "AppUITests/AppUITests/testWebViewLoads";
const DEFAULT_SIMULATOR_NAME = process.env.IOS_SIMULATOR_NAME?.trim() || "iPhone 16e";
const XCODE_PROJECT_PATH = "packages/frontend/ios/App/App.xcodeproj";
const UI_TEST_CONTEXT_PATH = path.resolve(process.cwd(), "tmp/ios-ui-test-context.json");
const envUser = readEnvFile(path.resolve(process.cwd(), ".env.user"));
const envUserAlt = readEnvFile(path.resolve(process.cwd(), ".env.user.1"));

function printUsage() {
  console.error(`Usage:
  node scripts/ios-simulator-debug.mjs status [--udid <udid>] [--json]
  node scripts/ios-simulator-debug.mjs launch [--udid <udid>] [--bundle-id <id>] [--url <url>]
  node scripts/ios-simulator-debug.mjs uitest [--udid <udid>] [--test <selector>] [--url <url>] [--result-bundle-path <path>] [--attachments-path <dir>]
  node scripts/ios-simulator-debug.mjs capture [--udid <udid>] [--test <selector>] [--url <url>] [--result-bundle-path <path>] [--attachments-path <dir>]`);
}

function parseArgs(argv) {
  let command = "status";
  const options = {
    udid: process.env.IOS_SIMULATOR_UDID?.trim() || null,
    json: false,
    bundleId: DEFAULT_BUNDLE_ID,
    url: null,
    test: DEFAULT_TEST_SELECTOR,
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
    if (arg === "--test") {
      options.test = argv[index + 1] ?? DEFAULT_TEST_SELECTOR;
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

function parseEnvFile(contents) {
  const env = {};
  for (const rawLine of String(contents).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line
      .slice(index + 1)
      .trim()
      .replace(/^"(.*)"$/u, "$1")
      .replace(/^'(.*)'$/u, "$1");
    if (key) {
      env[key] = value;
    }
  }
  return env;
}

function readEnvFile(filePath) {
  try {
    return parseEnvFile(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function pickEnvValue(...keys) {
  for (const key of keys) {
    const value =
      process.env[key] ??
      envUser[key] ??
      envUserAlt[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
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

function runStreamingCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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

function uiTestContextFromEnvironment() {
  const context = {};
  const email = pickEnvValue("INSTAFY_UI_TEST_EMAIL", "TRI_CLIENT_EMAIL", "TEST_USER_1_EMAIL");
  const password = pickEnvValue("INSTAFY_UI_TEST_PASSWORD", "TRI_CLIENT_PASSWORD", "TEST_USER_1_PASSWORD");

  if (email) {
    context.INSTAFY_UI_TEST_EMAIL = email;
  }
  if (password) {
    context.INSTAFY_UI_TEST_PASSWORD = password;
  }

  for (const key of [
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
    const value = pickEnvValue(key);
    if (value) {
      context[key] = value;
    }
  }
  return context;
}

function writeUiTestContextFromEnvironment() {
  const context = uiTestContextFromEnvironment();
  if (Object.keys(context).length === 0) {
    return null;
  }

  fs.mkdirSync(path.dirname(UI_TEST_CONTEXT_PATH), { recursive: true });
  fs.writeFileSync(UI_TEST_CONTEXT_PATH, JSON.stringify(context, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(UI_TEST_CONTEXT_PATH, 0o600);
  console.log(`[ios-simulator-debug] Wrote UI test context to ${UI_TEST_CONTEXT_PATH}.`);
  return UI_TEST_CONTEXT_PATH;
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
  target.EnvironmentVariables = {
    ...(target.EnvironmentVariables ?? {}),
    ...context,
  };
  target.TestingEnvironmentVariables = {
    ...(target.TestingEnvironmentVariables ?? {}),
    ...context,
  };
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

async function listSimulators() {
  const result = await runCommandOrThrow("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  const payload = JSON.parse(result.stdout);
  const entries = [];
  for (const [runtime, devices] of Object.entries(payload.devices ?? {})) {
    for (const device of Array.isArray(devices) ? devices : []) {
      if (device?.isAvailable === false) {
        continue;
      }
      entries.push({
        runtime,
        name: device.name ?? null,
        udid: device.udid ?? null,
        state: device.state ?? "Shutdown",
      });
    }
  }
  return entries;
}

async function resolveSimulator(requestedUdid) {
  const simulators = await listSimulators();
  if (simulators.length === 0) {
    throw new Error("No available iOS simulators found.");
  }

  if (requestedUdid) {
    const match = simulators.find((entry) => entry.udid === requestedUdid);
    if (!match) {
      throw new Error(`iOS simulator ${requestedUdid} was not found.`);
    }
    return match;
  }

  const bootedIphone = simulators.find(
    (entry) => entry.state === "Booted" && typeof entry.name === "string" && entry.name.startsWith("iPhone"),
  );
  if (bootedIphone) {
    return bootedIphone;
  }

  const preferredNamedIphone = simulators.find((entry) => entry.name === DEFAULT_SIMULATOR_NAME);
  if (preferredNamedIphone) {
    return preferredNamedIphone;
  }

  const firstIphone = simulators.find(
    (entry) => typeof entry.name === "string" && entry.name.startsWith("iPhone"),
  );
  return firstIphone ?? simulators[0];
}

async function ensureSimulatorBooted(udid) {
  await runCommand("xcrun", ["simctl", "boot", udid]);
  await runCommandOrThrow("xcrun", ["simctl", "bootstatus", udid, "-b"]);
}

async function commandStatus(options) {
  const simulator = await resolveSimulator(options.udid);
  const summary = {
    device: simulator,
    bundleId: options.bundleId,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`${simulator.name} · ${simulator.runtime}`);
  console.log(`UDID: ${simulator.udid}`);
  console.log(`State: ${simulator.state}`);
}

async function commandLaunch(options) {
  const simulator = await resolveSimulator(options.udid);
  await ensureSimulatorBooted(simulator.udid);
  if (options.url) {
    await runCommandOrThrow("xcrun", ["simctl", "openurl", simulator.udid, options.url]);
    return;
  }
  await runCommandOrThrow("xcrun", ["simctl", "launch", simulator.udid, options.bundleId]);
}

async function installBuiltAppOnSimulator({ simulatorUdid, appBundlePath }) {
  if (!fs.existsSync(appBundlePath)) {
    throw new Error(`Unable to install the app because ${appBundlePath} does not exist.`);
  }
  await runCommandOrThrow("xcrun", ["simctl", "install", simulatorUdid, appBundlePath]);
}

async function resetInstalledAppOnSimulatorIfRequested({ simulatorUdid, bundleId }) {
  if (process.env.IOS_SIMULATOR_RESET_APP !== "1") {
    return;
  }
  await runCommand("xcrun", ["simctl", "terminate", simulatorUdid, bundleId]);
  await runCommand("xcrun", ["simctl", "uninstall", simulatorUdid, bundleId]);
}

async function prelaunchAppForUiTestIfNeeded(options, simulatorUdid, builtAppPath) {
  if (!options.url) {
    return;
  }
  await installBuiltAppOnSimulator({
    simulatorUdid,
    appBundlePath: builtAppPath,
  });
  await runCommand("xcrun", ["simctl", "terminate", simulatorUdid, options.bundleId]);
  await runCommandOrThrow("xcrun", ["simctl", "openurl", simulatorUdid, options.url]);
  await delay(2_000);
}

async function runUiTest(options, { exportAttachments = false } = {}) {
  const simulator = await resolveSimulator(options.udid);
  await ensureSimulatorBooted(simulator.udid);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "instafy-ios-simulator-uitest-"));
  const derivedDataPath = path.join(tempDir, "DerivedData");
  const resultBundlePath = options.resultBundlePath ?? path.join(tempDir, "AppUITests.xcresult");
  const attachmentsPath =
    options.attachmentsPath ?? (exportAttachments ? path.join(tempDir, "attachments") : null);
  const uiTestContext = uiTestContextFromEnvironment();
  const uiTestContextPath = writeUiTestContextFromEnvironment();

  try {
    if (process.env.IOS_SIMULATOR_SKIP_CAP_SYNC !== "1") {
      console.log("[ios-simulator-debug] Syncing frontend bundle into the iOS app...");
      const syncResult = await runStreamingCommand("pnpm", [
        "-C",
        "packages/frontend",
        "cap:sync",
      ]);
      if (syncResult.code !== 0) {
        const syncFailureOutput = [syncResult.stderr.trim(), syncResult.stdout.trim()]
          .filter(Boolean)
          .join("\n");
        throw new Error(syncFailureOutput || `pnpm cap:sync exited with code ${syncResult.code}.`);
      }
    }

    const buildForTestingArgs = [
      "-project",
      XCODE_PROJECT_PATH,
      "-scheme",
      "App",
      "-destination",
      `id=${simulator.udid}`,
      "-derivedDataPath",
      derivedDataPath,
      "build-for-testing",
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
    ];

    const buildResult = await runStreamingCommand("xcodebuild", buildForTestingArgs);
    if (buildResult.code !== 0) {
      const buildFailureOutput = [buildResult.stderr.trim(), buildResult.stdout.trim()].filter(Boolean).join("\n");
      throw new Error(buildFailureOutput || `xcodebuild build-for-testing exited with code ${buildResult.code}.`);
    }

    const builtAppPath = path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator", "App.app");
    await resetInstalledAppOnSimulatorIfRequested({
      simulatorUdid: simulator.udid,
      bundleId: options.bundleId,
    });
    const productsPath = path.join(derivedDataPath, "Build", "Products");
    const sourceXctestrunPath = findFirstFileRecursive(
      productsPath,
      (entryPath) => entryPath.endsWith(".xctestrun"),
    );
    if (!sourceXctestrunPath) {
      throw new Error(`Unable to locate an .xctestrun file under ${productsPath}.`);
    }

    const injectedXctestrunPath = path.join(
      path.dirname(sourceXctestrunPath),
      "InjectedAppUITests.xctestrun",
    );
    if (Object.keys(uiTestContext).length > 0) {
      await createInjectedXctestrun({
        sourcePath: sourceXctestrunPath,
        outputPath: injectedXctestrunPath,
        context: uiTestContext,
      });
    } else {
      fs.copyFileSync(sourceXctestrunPath, injectedXctestrunPath);
    }

    await prelaunchAppForUiTestIfNeeded(options, simulator.udid, builtAppPath);

    const testWithoutBuildingArgs = [
      "test-without-building",
      "-xctestrun",
      injectedXctestrunPath,
      "-destination",
      `id=${simulator.udid}`,
      "-only-testing:" + options.test,
      "-resultBundlePath",
      resultBundlePath,
      "-collect-test-diagnostics",
      "never",
    ];

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

    if (testResult.code !== 0) {
      const failureOutput = [testResult.stderr.trim(), testResult.stdout.trim()].filter(Boolean).join("\n");
      const attachmentHint =
        attachmentsPath && resultBundleReady
          ? `\n\nResult bundle: ${resultBundlePath}\nAttachments: ${attachmentsPath}`
          : "";
      throw new Error((failureOutput || `xcodebuild exited with code ${testResult.code}.`) + attachmentHint);
    }

    if (attachmentExportError) {
      throw new Error(attachmentExportError);
    }
  } finally {
    void uiTestContextPath;
  }

  const summary = {
    device: {
      name: simulator.name,
      udid: simulator.udid,
    },
    bundleId: options.bundleId,
    test: options.test,
    resultBundlePath,
    attachmentsPath,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`iOS simulator UI test succeeded on ${summary.device.name} (${summary.device.udid}).`);
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
  printUsage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
