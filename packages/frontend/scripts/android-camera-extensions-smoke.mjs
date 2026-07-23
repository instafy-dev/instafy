import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd(), "..", "..");
const envUser = readEnvFile(path.join(repoRoot, ".env.user"));
const APP_PACKAGE = "dev.instafy.studio";
const CAMERA_PACKAGE = "com.sec.android.app.camera";
const IN_APP_CAMERA_ACTIVITY_NAME = "InstafyCameraCaptureActivity";
const CONTROLLER_BASE_URL =
  process.env.VITE_CONTROLLER_URL?.trim() ||
  process.env.CONTROLLER_BASE_URL?.trim() ||
  "https://controller.instafy.dev";
const DEVTOOLS_PORT = Number.parseInt(process.env.INSTAFY_ANDROID_WEBVIEW_PORT ?? "9224", 10);
const SCREENSHOT_PATH = path.resolve(
  process.cwd(),
  "test-results",
  "android-camera-extensions-smoke.png",
);
const FAILURE_SCREENSHOT_PATH = path.resolve(
  process.cwd(),
  "test-results",
  "android-camera-extensions-smoke-failure.png",
);
const DEVICE_SCREENSHOT_PATH = path.resolve(
  process.cwd(),
  "test-results",
  "android-camera-extensions-device.png",
);
const TARGET_PROJECT_ID = process.env.INSTAFY_ANDROID_PROJECT_ID?.trim() || null;
const CHAT_PROMPT = process.env.INSTAFY_ANDROID_CHAT_PROMPT?.trim() || "@octo take a photo";
const EXPECTED_RESPONSE_TEXT =
  process.env.INSTAFY_ANDROID_EXPECTED_RESPONSE?.trim() || null;
const EXPECTED_RESPONSE_MATCHER =
  EXPECTED_RESPONSE_TEXT || /^Octo captured a rear photo (?:on .+|from Camera)\.$/;
const AUTH_EMAIL =
  pickEnvValue(process.env, "INSTAFY_ANDROID_EMAIL", "TRI_CLIENT_EMAIL", "TEST_USER_1_EMAIL") ||
  pickEnvValue(envUser, "INSTAFY_ANDROID_EMAIL", "TRI_CLIENT_EMAIL", "TEST_USER_1_EMAIL");
const AUTH_PASSWORD =
  pickEnvValue(process.env, "INSTAFY_ANDROID_PASSWORD", "TRI_CLIENT_PASSWORD", "TEST_USER_1_PASSWORD") ||
  pickEnvValue(envUser, "INSTAFY_ANDROID_PASSWORD", "TRI_CLIENT_PASSWORD", "TEST_USER_1_PASSWORD");
const LOGCAT_MATCHERS = [
  /InstafyCameraExtension/i,
  /ACTION_IMAGE_CAPTURE/i,
  /cameraCaptureResult/i,
  /capturePhoto/i,
  /CameraManagerGlobal/i,
];
const ANDROID_REVERSE_PORTS = [54321, 8788];

function printUsage() {
  console.log(`Usage:
  pnpm -C packages/frontend test:android:camera:smoke [--serial <adb-serial>]

Environment overrides:
  INSTAFY_ANDROID_PROJECT_ID=<project-id>
  INSTAFY_ANDROID_CHAT_PROMPT='@octo take a photo'
  INSTAFY_ANDROID_EXPECTED_RESPONSE='Octo captured a rear photo on samsung SM-G973F.'
  INSTAFY_ANDROID_EMAIL=<email>
  INSTAFY_ANDROID_PASSWORD=<password>
  INSTAFY_ANDROID_WEBVIEW_PORT=<port>`);
}

function parseEnvFile(contents) {
  const env = {};
  for (const rawLine of String(contents).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line
      .slice(index + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
    if (key) env[key] = value;
  }
  return env;
}

function readEnvFile(filePath) {
  try {
    return parseEnvFile(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function pickEnvValue(env, ...keys) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function parseArgs(argv) {
  const options = {
    serial: process.env.ANDROID_DEVICE_SERIAL?.trim() || null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--serial") {
      options.serial = argv[index + 1]?.trim() || null;
      index += 1;
    }
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
  ].filter(Boolean);

  return candidates[0] ?? null;
}

async function runCommand(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    const code = typeof error.code === "number" ? error.code : 1;
    if (!options.allowFailure) {
      const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      throw new Error(detail || `${command} ${args.join(" ")} failed with code ${code}`);
    }
    return { stdout, stderr, code };
  }
}

async function runAdb(adbPath, serial, args, options = {}) {
  const prefix = serial ? ["-s", serial] : [];
  return runCommand(adbPath, [...prefix, ...args], options);
}

async function ensureAdbReverse(adbPath, serial, port) {
  await runAdb(adbPath, serial, ["reverse", "--remove", `tcp:${port}`], {
    allowFailure: true,
  });
  await runAdb(adbPath, serial, ["reverse", `tcp:${port}`, `tcp:${port}`], {
    allowFailure: false,
  });
}

async function clearAdbReverse(adbPath, serial, port) {
  await runAdb(adbPath, serial, ["reverse", "--remove", `tcp:${port}`], {
    allowFailure: true,
  });
}

function parseDeviceList(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices attached"))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      return { serial, state, detail: rest.join(" ") };
    })
    .filter((entry) => entry.serial && entry.state === "device");
}

async function resolveDeviceSerial(adbPath, preferredSerial) {
  if (preferredSerial) {
    return preferredSerial;
  }
  const { stdout } = await runCommand(adbPath, ["devices", "-l"]);
  const devices = parseDeviceList(stdout);
  if (devices.length === 0) {
    throw new Error("No Android device is connected over adb.");
  }
  if (devices.length > 1) {
    throw new Error(
      `Multiple adb devices are connected (${devices.map((device) => device.serial).join(", ")}). Pass --serial.`,
    );
  }
  return devices[0].serial;
}

async function waitForWebViewList(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        if (Array.isArray(pages) && pages.length > 0) {
          return pages;
        }
      }
    } catch {
      // Retry until the forwarded WebView endpoint is live.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for WebView DevTools on :${port}.`);
}

async function waitForStudioReady(page) {
  await page.waitForLoadState("domcontentloaded");
  await ensureLoggedIn(page);
  await expect
    .poll(
      async () => {
        await ensureLoggedIn(page).catch(() => {});
        const title = await page.title().catch(() => "");
        return Boolean(title.includes("Instafy Studio") && (await studioShellVisible(page)));
      },
      {
        timeout: 60_000,
        message: "Expected the Android app to finish booting into the Studio shell.",
      },
    )
    .toBe(true);
}

async function maybeContinueAsGuest(page) {
  const guestButton = page.getByRole("button", { name: /continue as guest/i });
  if (!(await guestButton.isVisible().catch(() => false))) {
    return false;
  }

  await guestButton.click();
  await page.waitForTimeout(1200);
  return true;
}

async function studioShellVisible(page) {
  const chatVisible = await page.getByTestId("chat-input").isVisible().catch(() => false);
  const sidebarVisible = await page.getByTestId("sidebar-nav-chat").isVisible().catch(() => false);
  const extensionsVisible = await page.getByTestId("extensions-panel").isVisible().catch(() => false);
  const bodyText = ((await page.locator("body").textContent().catch(() => "")) || "").trim();
  return Boolean(chatVisible || sidebarVisible || extensionsVisible || bodyText.includes("Ask for something"));
}

async function submitAuthStep({ input, button }) {
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click().catch(async () => {
    await button.click({ force: true }).catch(async () => {
      await input.press("Enter").catch(() => {});
    });
  });
}

async function ensureLoggedIn(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  if (await maybeContinueAsGuest(page)) {
    return;
  }
  if (await studioShellVisible(page)) {
    return;
  }

  if (!AUTH_EMAIL || !AUTH_PASSWORD) {
    throw new Error(
      "Android camera smoke reached login and no credentials are configured. Set INSTAFY_ANDROID_EMAIL/INSTAFY_ANDROID_PASSWORD or TRI_CLIENT_EMAIL/TRI_CLIENT_PASSWORD in .env.user.",
    );
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await maybeContinueAsGuest(page)) {
      return;
    }
    if (await studioShellVisible(page)) {
      return;
    }

    const emailInput = page.getByRole("textbox", { name: /email address/i });
    const passwordInput = page.getByRole("textbox", { name: /^password$/i });
    const continueButton = page.getByRole("button", { name: /^continue$/i });

    if (await emailInput.isVisible().catch(() => false)) {
      await emailInput.fill(AUTH_EMAIL);
      await submitAuthStep({ input: emailInput, button: continueButton });
      await page.waitForTimeout(500);
      continue;
    }

    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill(AUTH_PASSWORD);
      await submitAuthStep({ input: passwordInput, button: continueButton });
      await page.waitForTimeout(1000);
      continue;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for the Android app to finish login on ${page.url()}`);
}

function buildStudioPanelDeepLink(currentUrl, panelId) {
  let parsed;
  try {
    parsed = new URL(currentUrl);
  } catch {
    return null;
  }

  const projectId = parsed.searchParams.get("projectId")?.trim();
  if (!projectId) {
    return null;
  }

  const deepLink = new URL("instafy:///studio");
  deepLink.searchParams.set("projectId", projectId);
  deepLink.searchParams.set("panel", panelId);
  return deepLink.toString();
}

function buildStudioPanelDeepLinkForProject(projectId, panelId) {
  const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
  if (!normalizedProjectId) {
    return null;
  }

  const deepLink = new URL("instafy:///studio");
  deepLink.searchParams.set("projectId", normalizedProjectId);
  deepLink.searchParams.set("panel", panelId);
  return deepLink.toString();
}

async function openStudioPanelViaDeepLink(adbPath, serial, page, panelId) {
  const deepLink = buildStudioPanelDeepLink(page.url(), panelId);
  if (!deepLink) {
    return false;
  }
  await runAdb(
    adbPath,
    serial,
    [
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      deepLink,
      APP_PACKAGE,
    ],
    { allowFailure: true },
  );
  await page.waitForTimeout(1500);
  return true;
}

async function openStudioProjectPanelViaDeepLink(adbPath, serial, projectId, panelId) {
  const deepLink = buildStudioPanelDeepLinkForProject(projectId, panelId);
  if (!deepLink) {
    return false;
  }
  await runAdb(
    adbPath,
    serial,
    [
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      deepLink,
      APP_PACKAGE,
    ],
    { allowFailure: true },
  );
  return true;
}

async function openPanel(page, panelId) {
  const target =
    panelId === "chat" ? page.getByTestId("chat-input") : page.getByTestId("extensions-panel");
  if (await target.isVisible().catch(() => false)) {
    return;
  }

  const navButton = page.getByTestId(`sidebar-nav-${panelId}`);
  const moreItem = page.getByTestId(`sidebar-more-item-${panelId}`);
  const moreButton = page.getByTestId("sidebar-nav-more");
  const sidebarToggle = page.getByTestId("topbar-sidebar-toggle");
  const buttonFallback =
    panelId === "extensions"
      ? page.getByRole("button", { name: /^extensions$/i }).last()
      : panelId === "chat"
        ? page.getByRole("button", { name: /^(assistant|chat)$/i }).last()
        : null;
  const textFallback =
    panelId === "extensions"
      ? page.getByText(/^Extensions$/)
      : panelId === "chat"
        ? page.getByText(/^Assistant$/)
        : null;
  const clickAndWaitForTarget = async (locator) => {
    await locator.click().catch(async () => {
      await locator.click({ force: true }).catch(() => {});
    });
    await target.waitFor({ state: "visible", timeout: 30_000 });
  };

  if (await navButton.isVisible().catch(() => false)) {
    await clickAndWaitForTarget(navButton);
    return;
  }

  if (await moreItem.isVisible().catch(() => false)) {
    await clickAndWaitForTarget(moreItem);
    return;
  }

  if (buttonFallback && (await buttonFallback.isVisible().catch(() => false))) {
    await clickAndWaitForTarget(buttonFallback);
    return;
  }

  if (textFallback && (await textFallback.isVisible().catch(() => false))) {
    await clickAndWaitForTarget(textFallback);
    return;
  }

  if (await moreButton.isVisible().catch(() => false)) {
    await moreButton.click();
    await moreItem.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if (await moreItem.isVisible().catch(() => false)) {
      await clickAndWaitForTarget(moreItem);
      return;
    }
  }

  if (await sidebarToggle.isVisible().catch(() => false)) {
    const sidebarOverlay = page.getByTestId("mobile-sidebar-overlay");
    await sidebarToggle.click({ force: true }).catch(() => {});
    await sidebarOverlay.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    if (await navButton.isVisible().catch(() => false)) {
      await clickAndWaitForTarget(navButton);
      return;
    }

    if (await moreItem.isVisible().catch(() => false)) {
      await clickAndWaitForTarget(moreItem);
      return;
    }

    if (buttonFallback && (await buttonFallback.isVisible().catch(() => false))) {
      await clickAndWaitForTarget(buttonFallback);
      return;
    }

    if (textFallback && (await textFallback.isVisible().catch(() => false))) {
      await clickAndWaitForTarget(textFallback);
      return;
    }

    if (await moreButton.isVisible().catch(() => false)) {
      await moreButton.click();
      await moreItem.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
      if (await moreItem.isVisible().catch(() => false)) {
        await clickAndWaitForTarget(moreItem);
        return;
      }
    }
  }

  await fs.mkdir(path.dirname(FAILURE_SCREENSHOT_PATH), { recursive: true }).catch(() => {});
  await page.screenshot({ path: FAILURE_SCREENSHOT_PATH, fullPage: true }).catch(() => {});
  throw new Error(`Unable to open ${panelId} on the Android app. See ${FAILURE_SCREENSHOT_PATH}.`);
}

async function ensureProviderDetailsExpanded(page, providerId) {
  const details = page.getByTestId(`project-provider-details-${providerId}`);
  if (await details.isVisible().catch(() => false)) {
    return;
  }

  const toggle = page.getByTestId(`project-provider-details-toggle-${providerId}`);
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  await expect(details).toBeVisible({ timeout: 30_000 });
}

async function clearNativeLiveUpdateState(adbPath, serial) {
  const cleanupCommands = [
    ["shell", "run-as", APP_PACKAGE, "rm", "-rf", "files/_capacitor_live_update_bundles"],
    ["shell", "run-as", APP_PACKAGE, "rm", "-f", "shared_prefs/CapWebViewSettings.xml"],
    ["shell", "run-as", APP_PACKAGE, "rm", "-f", "shared_prefs/CapawesomeLiveUpdate.xml"],
  ];

  for (const command of cleanupCommands) {
    await runAdb(adbPath, serial, command, { allowFailure: true });
  }
}

async function getNativeCameraStatus(page) {
  return page.evaluate(async () => {
    const plugin = window.Capacitor?.Plugins?.InstafyCameraExtension;
    if (!plugin?.getStatus) {
      return null;
    }
    return await plugin.getStatus();
  });
}

async function ensureCameraReady(page, adbPath, serial) {
  await runAdb(adbPath, serial, ["shell", "pm", "grant", APP_PACKAGE, "android.permission.CAMERA"], {
    allowFailure: true,
  });
  await page.waitForTimeout(800);

  let status = await getNativeCameraStatus(page);
  if (status?.permissionGranted) {
    return status;
  }

  await page.evaluate(() => {
    const plugin = window.Capacitor?.Plugins?.InstafyCameraExtension;
    if (plugin?.requestCameraPermissions) {
      void plugin.requestCameraPermissions();
    }
  });
  await page.waitForTimeout(500);

  const allowTexts = [
    "While using the app",
    "Allow only while using the app",
    "Allow",
  ];
  for (const text of allowTexts) {
    const tapped = await tapUiNodeWithText(adbPath, serial, text);
    if (tapped) {
      break;
    }
  }

  await page.waitForTimeout(1500);
  status = await getNativeCameraStatus(page);
  if (!status?.permissionGranted) {
    throw new Error("Camera permission is still not granted on the Android device.");
  }
  return status;
}

async function runCameraExtensionsSmoke(page, adbPath, serial) {
  const status = await ensureCameraReady(page, adbPath, serial);
  const providerId =
    typeof status?.providerId === "string" && status.providerId.trim().length > 0
      ? status.providerId.trim()
      : "camera";
  const prefix = `project-provider-camera-native-${providerId}`;

  await openPanel(page, "extensions");
  await expect(page.getByTestId("extensions-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`project-provider-row-${providerId}`)).toBeVisible({ timeout: 30_000 });
  const attachment = await ensureCameraAttached(page, providerId);
  await ensureProviderDetailsExpanded(page, providerId);

  const summary = page.getByTestId(`${prefix}-summary`);
  await expect(summary).toBeVisible({ timeout: 30_000 });

  return {
    providerId,
    summary: ((await summary.textContent()) || "").trim(),
    permission: status.permission,
    selectedLens: status.selectedLens,
    attachedViaApiFallback: attachment.attachedViaApiFallback,
  };
}

async function ensureCameraAttached(page, providerId, timeoutMs = 30_000) {
  const attachButton = page.getByTestId(`project-provider-attach-${providerId}`);
  const detachButton = page.getByTestId(`project-provider-detach-${providerId}`);
  const statusIndicator = page.getByTestId(`project-provider-status-${providerId}`);
  const deadline = Date.now() + timeoutMs;
  let attachAttempted = false;
  let apiFallbackUsed = false;

  while (Date.now() < deadline) {
    const attachVisible = await attachButton.isVisible().catch(() => false);
    const statusLabel =
      ((await statusIndicator.getAttribute("aria-label").catch(() => "")) || "").trim();
    const attachedVisible = statusLabel === "Attached";
    if ((await detachButton.isVisible().catch(() => false)) || (attachedVisible && !attachVisible)) {
      return {
        attachedViaApiFallback: apiFallbackUsed,
      };
    }

    if (attachVisible) {
      const disabled = await attachButton.isDisabled().catch(() => false);
      if (!disabled) {
        attachAttempted = true;
        const clicked = await attachButton
          .click({ force: true, timeout: 3_000 })
          .then(() => true)
          .catch(() => false);
        await page.waitForTimeout(1500);
        if (clicked) {
          continue;
        }
      }
    }

    if (!apiFallbackUsed && (attachAttempted || attachVisible)) {
      await upsertCameraProjectIntegrationFromDeviceSession(page);
      apiFallbackUsed = true;
      await page.waitForTimeout(1500);
      await openPanel(page, "extensions");
      continue;
    }

    await page.waitForTimeout(500);
  }

  throw new Error("Timed out waiting for Camera to become attached in Extensions.");
}

async function upsertCameraProjectIntegrationFromDeviceSession(page) {
  const result = await page.evaluate(async ({ controllerBaseUrl }) => {
    const projectIdFromUrl = new URL(window.location.href).searchParams.get("projectId")?.trim() ?? "";
    const projectIdFromWindow =
      typeof window.__INSTAFY_ACTIVE_PROJECT_ID__ === "string"
        ? window.__INSTAFY_ACTIVE_PROJECT_ID__.trim()
        : "";
    const projectId = projectIdFromUrl || projectIdFromWindow;
    if (!projectId) {
      return { success: false, error: "Missing active project id." };
    }

    const supabase = window.__INSTAFY_SUPABASE__;
    if (!supabase?.auth?.getSession) {
      return { success: false, error: "Instafy Supabase session is unavailable on this device." };
    }

    const sessionResult = await supabase.auth.getSession().catch(() => null);
    const accessToken = sessionResult?.data?.session?.access_token ?? "";
    if (!accessToken) {
      return { success: false, error: "Missing controller access token for the device session." };
    }

    const cameraStatus = await window.Capacitor?.Plugins?.InstafyCameraExtension?.getStatus?.().catch(() => null);
    const providerId =
      typeof cameraStatus?.providerId === "string" && cameraStatus.providerId.trim().length > 0
        ? cameraStatus.providerId.trim()
        : "camera";
    const deviceId =
      typeof cameraStatus?.deviceId === "string" && cameraStatus.deviceId.trim().length > 0
        ? cameraStatus.deviceId.trim()
        : providerId.replace(/^camera:/, "");
    const deviceLabel =
      typeof cameraStatus?.deviceLabel === "string" && cameraStatus.deviceLabel.trim().length > 0
        ? cameraStatus.deviceLabel.trim()
        : "This device";
    const integrationUrl = `${controllerBaseUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}/integrations/${encodeURIComponent(providerId)}`;
    const listUrl = `${controllerBaseUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}/integrations`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    const existingResponse = await fetch(listUrl, { headers }).catch(() => null);
    const existingIntegrations = existingResponse?.ok ? await existingResponse.json().catch(() => []) : [];
    const existingIntegration = Array.isArray(existingIntegrations)
      ? existingIntegrations.find(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            (entry.provider === providerId || entry.provider === "camera"),
        ) ?? null
      : null;
    const existingMetadata =
      existingIntegration?.metadata && typeof existingIntegration.metadata === "object"
        ? existingIntegration.metadata
        : {};
    const existingCapabilities = Array.isArray(existingIntegration?.capabilities)
      ? existingIntegration.capabilities.filter((entry) => typeof entry === "string")
      : [];
    const nowIso = new Date().toISOString();

    const response = await fetch(integrationUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        status: "attached",
        connectionType: "native_runtime",
        metadata: {
          ...existingMetadata,
          attached: true,
          enabled: true,
          attachedAt:
            typeof existingMetadata.attachedAt === "string" && existingMetadata.attachedAt.trim().length > 0
              ? existingMetadata.attachedAt
              : nowIso,
          attachedFrom: "android_camera_extensions_smoke",
          attachedVia: "native_runtime",
          selectedDevice: {
            transport: "native_camera",
            identifier: deviceId,
            address: deviceId,
            name: deviceLabel,
            nativePlatform: "android",
            connectedAt: nowIso,
          },
          updatedAt: nowIso,
        },
        capabilities: Array.from(new Set([...existingCapabilities, "camera_observation"])),
      }),
    }).catch((error) => ({
      ok: false,
      status: 0,
      text: async () => String(error),
      json: async () => null,
    }));

    if (!response.ok) {
      return {
        success: false,
        error: await response.text().catch(() => `Controller responded with status ${response.status}.`),
      };
    }

    const integration = await response.json().catch(() => null);
    return {
      success: true,
      integration,
    };
  }, {
    controllerBaseUrl: CONTROLLER_BASE_URL,
  });

  if (!result?.success) {
    throw new Error(result?.error || "Unable to attach Camera through the device controller session.");
  }
}

async function runCameraChatRequest(page) {
  const responseLocator = page.getByText(EXPECTED_RESPONSE_MATCHER);
  const beforeCount = await responseLocator.count().catch(() => 0);

  await openPanel(page, "chat");
  const chatInput = page.getByTestId("chat-input");
  await expect(chatInput).toBeVisible({ timeout: 30_000 });
  await chatInput.fill(CHAT_PROMPT);

  const sendButton = page.getByTestId("chat-send-button");
  await expect(sendButton).toBeEnabled({ timeout: 30_000 });
  await sendButton.click().catch(async () => {
    await sendButton.click({ force: true }).catch(async () => {
      await chatInput.press("Enter").catch(() => {});
    });
  });

  return {
    responseLocator,
    beforeCount,
  };
}

async function getDisplaySize(adbPath, serial) {
  const { stdout } = await runAdb(adbPath, serial, ["shell", "wm", "size"]);
  const match = stdout.match(/Physical size:\s*(\d+)x(\d+)/i);
  if (!match) {
    return { width: 1080, height: 2280 };
  }
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

async function getStayAwakeSetting(adbPath, serial) {
  const { stdout } = await runAdb(
    adbPath,
    serial,
    ["shell", "settings", "get", "global", "stay_on_while_plugged_in"],
    { allowFailure: true },
  );
  const value = stdout.trim();
  return /^\d+$/.test(value) ? value : "0";
}

async function setStayAwakeSetting(adbPath, serial, value) {
  await runAdb(
    adbPath,
    serial,
    ["shell", "settings", "put", "global", "stay_on_while_plugged_in", value],
    { allowFailure: true },
  );

  const stayOnMode =
    value === "0"
      ? "false"
      : value === "1"
        ? "ac"
        : value === "2"
          ? "usb"
          : value === "4"
            ? "wireless"
            : "true";
  await runAdb(adbPath, serial, ["shell", "svc", "power", "stayon", stayOnMode], {
    allowFailure: true,
  });
}

async function wakeAndDismissKeyguard(adbPath, serial) {
  const { width, height } = await getDisplaySize(adbPath, serial);
  const centerX = Math.round(width / 2);
  await runAdb(adbPath, serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], {
    allowFailure: true,
  });
  await runAdb(adbPath, serial, ["shell", "wm", "dismiss-keyguard"], {
    allowFailure: true,
  });
  await runAdb(
    adbPath,
    serial,
    [
      "shell",
      "input",
      "swipe",
      String(centerX),
      String(Math.round(height * 0.9)),
      String(centerX),
      String(Math.round(height * 0.3)),
      "250",
    ],
    { allowFailure: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await runAdb(adbPath, serial, ["shell", "wm", "dismiss-keyguard"], {
    allowFailure: true,
  });
}

async function getResumedActivity(adbPath, serial) {
  const { stdout } = await runAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
  const match = stdout.match(/mResumedActivity:.*?\s([A-Za-z0-9._$]+)\/([A-Za-z0-9._$/]+)\s/);
  if (!match) {
    return null;
  }
  return {
    packageName: match[1],
    activity: match[2],
  };
}

function isLikelyKeyguardActivity(resumed) {
  if (!resumed || resumed.packageName !== "com.android.systemui") {
    return false;
  }
  const activity = `${resumed.activity}`.toLowerCase();
  return /keyguard|bouncer|password|pin/.test(activity);
}

async function waitForResumedPackage(adbPath, serial, packageName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lockedCount = 0;
  while (Date.now() < deadline) {
    const resumed = await getResumedActivity(adbPath, serial);
    if (isLikelyKeyguardActivity(resumed)) {
      lockedCount += 1;
      if (lockedCount >= 3) {
        throw new Error("The connected Android device is locked. Unlock it and keep the screen awake before rerunning the camera smoke.");
      }
    } else {
      lockedCount = 0;
    }
    if (resumed?.packageName === packageName) {
      return resumed;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${packageName} to become the resumed Android activity.`);
}

async function launchInstafyApp(adbPath, serial, timeoutMs = 15_000) {
  const launchAttempts = [
    ["shell", "am", "start", "-W", "-n", `${APP_PACKAGE}/.MainActivity`],
    ["shell", "input", "keyevent", "KEYCODE_HOME"],
    ["shell", "am", "start", "-W", "-n", `${APP_PACKAGE}/.MainActivity`],
    ["shell", "monkey", "-p", APP_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"],
  ];

  for (const args of launchAttempts) {
    await runAdb(adbPath, serial, args, { allowFailure: true });
    await wakeAndDismissKeyguard(adbPath, serial);
    await ensureAndroidDeviceUnlocked(adbPath, serial, "app launch");
    try {
      await waitForResumedPackage(adbPath, serial, APP_PACKAGE, timeoutMs);
      return;
    } catch (error) {
      if (args === launchAttempts[launchAttempts.length - 1]) {
        throw error;
      }
    }
  }
}

async function waitForResumedActivityMatch(adbPath, serial, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastResumed = null;
  let lockedCount = 0;
  while (Date.now() < deadline) {
    const resumed = await getResumedActivity(adbPath, serial);
    lastResumed = resumed;
    if (isLikelyKeyguardActivity(resumed)) {
      lockedCount += 1;
      if (lockedCount >= 3) {
        throw new Error("The connected Android device is locked. Unlock it and keep the screen awake before rerunning the camera smoke.");
      }
    } else {
      lockedCount = 0;
    }
    if (resumed && predicate(resumed)) {
      return resumed;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const suffix = lastResumed
    ? ` last resumed ${lastResumed.packageName}/${lastResumed.activity}`
    : "";
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

async function waitForCameraForeground(adbPath, serial, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastResumed = null;
  let lockedCount = 0;
  while (Date.now() < deadline) {
    const resumed = await getResumedActivity(adbPath, serial);
    lastResumed = resumed;
    if (isLikelyKeyguardActivity(resumed)) {
      lockedCount += 1;
      if (lockedCount >= 3) {
        throw new Error("The connected Android device is locked. Unlock it and keep the screen awake before rerunning the camera smoke.");
      }
    } else {
      lockedCount = 0;
    }
    if (
      resumed &&
      (
        (
          resumed.packageName === APP_PACKAGE &&
          resumed.activity.includes(IN_APP_CAMERA_ACTIVITY_NAME)
        ) ||
        (
          resumed.packageName !== APP_PACKAGE &&
          `${resumed.packageName}/${resumed.activity}`.toLowerCase().match(/camera|capture|photo/)
        )
      )
    ) {
      return resumed;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const suffix = lastResumed
    ? ` last resumed ${lastResumed.packageName}/${lastResumed.activity}`
    : "";
  throw new Error(`Timed out waiting for a camera activity to become resumed.${suffix}`);
}

async function waitForAppPid(adbPath, serial, packageName, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runAdb(adbPath, serial, ["shell", "pidof", packageName], {
      allowFailure: true,
    });
    const pid = result.stdout.trim();
    if (pid) {
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for pidof ${packageName}.`);
}

async function dumpUiHierarchy(adbPath, serial, stem) {
  const remotePath = `/sdcard/${stem}.xml`;
  const localPath = path.resolve(process.cwd(), "test-results", `${stem}.xml`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await runAdb(adbPath, serial, ["shell", "uiautomator", "dump", remotePath], {
    allowFailure: true,
  });
  const { stdout } = await runAdb(adbPath, serial, ["shell", "cat", remotePath], {
    allowFailure: true,
  });
  await fs.writeFile(localPath, stdout);
  return stdout;
}

async function deviceAppearsLocked(adbPath, serial) {
  const xml = await dumpUiHierarchy(adbPath, serial, "android-camera-smoke-lock-check");
  return /Enter PIN to open|Device locked|keyguard_host_view|pinEntry/i.test(xml);
}

async function ensureAndroidDeviceUnlocked(adbPath, serial, contextLabel) {
  if (await deviceAppearsLocked(adbPath, serial)) {
    throw new Error(
      `The connected Android device is locked during ${contextLabel}. Unlock it and keep the screen awake before rerunning the camera smoke.`,
    );
  }
}

function parseUiNodeBounds(xml, textMatcher) {
  const matcher =
    typeof textMatcher === "string"
      ? (value) => value === textMatcher
      : (value) => textMatcher.test(value);
  const nodePattern = /text="([^"]*)"[^>]*bounds="(\[\d+,\d+\]\[\d+,\d+\])"/g;
  let match;
  while ((match = nodePattern.exec(xml)) !== null) {
    if (matcher(match[1])) {
      return match[2];
    }
  }
  return null;
}

function parseUiNodeBoundsByAttributes(xml, predicate) {
  const nodePattern = /<node\b[^>]*bounds="(\[\d+,\d+\]\[\d+,\d+\])"[^>]*\/?>/g;
  let match;
  while ((match = nodePattern.exec(xml)) !== null) {
    const node = match[0];
    const readAttribute = (name) => {
      const attributeMatch = node.match(new RegExp(`${name}="([^"]*)"`, "i"));
      return attributeMatch?.[1] ?? "";
    };
    const attrs = {
      text: readAttribute("text"),
      resourceId: readAttribute("resource-id"),
      contentDesc: readAttribute("content-desc"),
      className: readAttribute("class"),
      enabled: readAttribute("enabled"),
    };
    if (predicate(attrs)) {
      return match[1];
    }
  }
  return null;
}

function parseBoundsCenter(bounds) {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    return null;
  }
  const left = Number.parseInt(match[1], 10);
  const top = Number.parseInt(match[2], 10);
  const right = Number.parseInt(match[3], 10);
  const bottom = Number.parseInt(match[4], 10);
  return {
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2),
  };
}

async function tapUiNodeWithText(adbPath, serial, textMatcher) {
  const xml = await dumpUiHierarchy(adbPath, serial, "android-camera-smoke-ui");
  const bounds = parseUiNodeBounds(xml, textMatcher);
  const center = bounds ? parseBoundsCenter(bounds) : null;
  if (!center) {
    return false;
  }
  await runAdb(adbPath, serial, ["shell", "input", "tap", String(center.x), String(center.y)]);
  return true;
}

async function maybeDismissLocationPrompt(adbPath, serial) {
  const dismissTexts = ["Cancel", "Not now"];
  for (const text of dismissTexts) {
    const tapped = await tapUiNodeWithText(adbPath, serial, text);
    if (tapped) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    }
  }
  return false;
}

async function maybeConfirmCapturedPhoto(adbPath, serial) {
  const confirmed = await tapUiNodeWithText(adbPath, serial, "OK");
  if (confirmed) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return confirmed;
}

async function triggerCameraShutter(adbPath, serial) {
  const isInstafyShutter = (attrs) =>
    attrs.contentDesc === "Instafy camera shutter" ||
    attrs.resourceId === `${APP_PACKAGE}:id/instafy_camera_shutter`;
  const isSystemCameraShutter = (attrs) =>
    attrs.contentDesc === "Take picture" ||
    attrs.resourceId === "com.sec.android.app.camera:id/normal_center_button";
  const deadline = Date.now() + 12_000;
  let sawDisabledInstafyShutter = false;

  while (Date.now() < deadline) {
    const xml = await dumpUiHierarchy(adbPath, serial, "android-camera-smoke-shutter");
    const readyInstafyBounds = parseUiNodeBoundsByAttributes(
      xml,
      (attrs) => isInstafyShutter(attrs) && attrs.enabled !== "false",
    );
    const readyInstafyCenter = readyInstafyBounds ? parseBoundsCenter(readyInstafyBounds) : null;
    if (readyInstafyCenter) {
      await runAdb(adbPath, serial, [
        "shell",
        "input",
        "tap",
        String(readyInstafyCenter.x),
        String(readyInstafyCenter.y),
      ]);
      return;
    }

    const systemShutterBounds = parseUiNodeBoundsByAttributes(xml, isSystemCameraShutter);
    const systemShutterCenter = systemShutterBounds ? parseBoundsCenter(systemShutterBounds) : null;
    if (systemShutterCenter) {
      await runAdb(adbPath, serial, [
        "shell",
        "input",
        "tap",
        String(systemShutterCenter.x),
        String(systemShutterCenter.y),
      ]);
      return;
    }

    if (parseUiNodeBoundsByAttributes(xml, isInstafyShutter)) {
      sawDisabledInstafyShutter = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  if (sawDisabledInstafyShutter) {
    throw new Error("Timed out waiting for the in-app camera shutter to become enabled.");
  }

  const { width, height } = await getDisplaySize(adbPath, serial);
  await runAdb(adbPath, serial, [
    "shell",
    "input",
    "tap",
    String(Math.round(width / 2)),
    String(Math.round(height * 0.835)),
  ]);
}

async function captureDeviceScreenshot(adbPath, serial, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const { stdout } = await runAdb(adbPath, serial, ["exec-out", "screencap", "-p"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  await fs.writeFile(outputPath, stdout);
}

function filterRelevantLogcat(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => LOGCAT_MATCHERS.some((matcher) => matcher.test(line)));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const adbPath = resolveAdbPath();
  if (!adbPath) {
    throw new Error("Unable to resolve adb. Set ANDROID_ADB or ANDROID_SDK_ROOT.");
  }

  const serial = await resolveDeviceSerial(adbPath, options.serial);
  const previousStayAwakeSetting = await getStayAwakeSetting(adbPath, serial);
  await setStayAwakeSetting(adbPath, serial, "2");
  await wakeAndDismissKeyguard(adbPath, serial);
  await ensureAndroidDeviceUnlocked(adbPath, serial, "startup");
  await runAdb(adbPath, serial, ["logcat", "-c"], { allowFailure: true });
  await runAdb(adbPath, serial, ["shell", "am", "force-stop", APP_PACKAGE], { allowFailure: true });
  await clearNativeLiveUpdateState(adbPath, serial);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await launchInstafyApp(adbPath, serial);

  const pid = await waitForAppPid(adbPath, serial, APP_PACKAGE);

  await runAdb(adbPath, serial, ["forward", "--remove", `tcp:${DEVTOOLS_PORT}`], {
    allowFailure: true,
  });
  await runAdb(adbPath, serial, [
    "forward",
    `tcp:${DEVTOOLS_PORT}`,
    `localabstract:webview_devtools_remote_${pid}`,
  ]);

  const pages = await waitForWebViewList(DEVTOOLS_PORT);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEVTOOLS_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((entry) => entry.url().includes("/studio")) ?? context.pages()[0];
  if (!page) {
    throw new Error("Unable to find the Instafy Studio page in the Android WebView.");
  }

  const consoleMessages = [];
  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });

  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error instanceof Error ? error.message : String(error));
  });

  try {
    for (const port of ANDROID_REVERSE_PORTS) {
      await ensureAdbReverse(adbPath, serial, port);
    }
    await waitForStudioReady(page);
    await launchInstafyApp(adbPath, serial, 8_000);
    await waitForStudioReady(page);
    if (TARGET_PROJECT_ID) {
      await openStudioProjectPanelViaDeepLink(adbPath, serial, TARGET_PROJECT_ID, "extensions");
      await page.waitForTimeout(1500);
      await waitForStudioReady(page);
    }
    await openStudioPanelViaDeepLink(adbPath, serial, page, "extensions");
    const extensionResult = await runCameraExtensionsSmoke(page, adbPath, serial);

    await launchInstafyApp(adbPath, serial, 8_000);
    await waitForStudioReady(page);
    let chatRequest = await runCameraChatRequest(page);
    await ensureAndroidDeviceUnlocked(adbPath, serial, "camera request dispatch");
    try {
      await waitForCameraForeground(adbPath, serial, 12_000);
    } catch (error) {
      const bodyText = ((await page.locator("body").innerText().catch(() => "")) || "").trim();
      const isKnownReadinessRace =
        bodyText.includes("cannot verify whether Camera is allowed for this project right now") ||
        bodyText.includes("cannot use Camera in this project yet");
      if (!isKnownReadinessRace) {
        throw error;
      }

      await openPanel(page, "extensions");
      await ensureCameraAttached(page);
      await page.waitForTimeout(1500);
      await ensureAndroidDeviceUnlocked(adbPath, serial, "camera request retry");
      chatRequest = await runCameraChatRequest(page);
      await waitForCameraForeground(adbPath, serial, 20_000);
    }

    await maybeDismissLocationPrompt(adbPath, serial);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await triggerCameraShutter(adbPath, serial);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await maybeConfirmCapturedPhoto(adbPath, serial);
    await waitForResumedActivityMatch(
      adbPath,
      serial,
      (activity) => activity.packageName === APP_PACKAGE && activity.activity.includes("MainActivity"),
      30_000,
      "Instafy main activity",
    );
    await waitForStudioReady(page);

    await expect
      .poll(async () => {
        const status = await getNativeCameraStatus(page);
        return status?.lastCapture?.captureId ?? null;
      }, {
        timeout: 30_000,
        message: "Expected the native camera plugin to report a saved lastCapture after returning to Instafy.",
      })
      .not.toBeNull();

    await expect
      .poll(async () => await chatRequest.responseLocator.count().catch(() => 0), {
        timeout: 60_000,
        message: "Expected @octo take a photo to append a camera capture confirmation.",
      })
      .toBeGreaterThan(chatRequest.beforeCount);

    await expect(chatRequest.responseLocator.last()).toBeVisible({ timeout: 30_000 });

    await openPanel(page, "extensions");
    const providerRow = page.getByTestId(`project-provider-row-${extensionResult.providerId}`);
    await expect(providerRow).toContainText("Latest capture", { timeout: 30_000 });

    const finalStatus = await getNativeCameraStatus(page);
    await fs.mkdir(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    await captureDeviceScreenshot(adbPath, serial, DEVICE_SCREENSHOT_PATH);

    const { stdout: logcatOutput } = await runAdb(adbPath, serial, ["logcat", "-d", "-v", "time"], {
      allowFailure: true,
    });
    const relevantLogcat = filterRelevantLogcat(logcatOutput);
    const consoleIssues = consoleMessages.filter((entry) => entry.type === "error" || entry.type === "warning");

    console.log(`Android device: ${serial}`);
    console.log(`App pid: ${pid}`);
    console.log(`WebView pages: ${pages.length}`);
    console.log(`Extensions summary: ${extensionResult.summary}`);
    console.log(`Camera permission: ${extensionResult.permission}`);
    console.log(`Selected lens: ${extensionResult.selectedLens ?? "unknown"}`);
    console.log(`Attachment path: ${extensionResult.attachedViaApiFallback ? "controller-session fallback" : "Extensions UI"}`);
    console.log(
      `Latest capture: ${finalStatus?.lastCapture?.fileName ?? "missing"} · ${finalStatus?.lastCapture?.width ?? "?"}x${finalStatus?.lastCapture?.height ?? "?"}`,
    );
    console.log(`Studio screenshot: ${SCREENSHOT_PATH}`);
    console.log(`Device screenshot: ${DEVICE_SCREENSHOT_PATH}`);

    if (consoleIssues.length > 0 || pageErrors.length > 0) {
      console.log("Browser console issues:");
      for (const issue of consoleIssues) {
        console.log(`- [${issue.type}] ${issue.text}`);
      }
      for (const error of pageErrors) {
        console.log(`- [pageerror] ${error}`);
      }
    } else {
      console.log("Browser console issues: none");
    }

    if (relevantLogcat.length > 0) {
      console.log("Relevant adb logcat:");
      for (const line of relevantLogcat) {
        console.log(line);
      }
    } else {
      console.log("Relevant adb logcat: none");
    }
  } finally {
    await browser.close();
    for (const port of ANDROID_REVERSE_PORTS) {
      await clearAdbReverse(adbPath, serial, port);
    }
    await runAdb(adbPath, serial, ["forward", "--remove", `tcp:${DEVTOOLS_PORT}`], {
      allowFailure: true,
    });
    await setStayAwakeSetting(adbPath, serial, previousStayAwakeSetting);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
