import { BrowserWindow, Notification, app, dialog, ipcMain, net, shell } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startDesktopRuntime,
  stopDesktopRuntime,
  type DesktopRuntimeHandle,
  type StartDesktopRuntimeOptions,
} from "@instafy/desktop-runtime-agent";
import {
  SERIAL_HARDWARE_PROVIDER_DESCRIPTOR,
  SERIAL_HARDWARE_PROVIDER_ID,
  type LocalHardwareIoActionRunRequest,
  type LocalHardwareIoActionRunResult,
  type LocalHardwareIoOpportunityListResult,
  type SerialPortListResult,
  type SerialPortProbeResult,
} from "@instafy/sdk/hardware-provider";
import {
  listHardwareIoOpportunities,
  listHardwareSerialPorts,
  probeHardwareSerialPort,
  runHardwareIoAction,
} from "@instafy/sdk/hardware-node";
import { desktopLog, installDesktopLogging } from "./logging";
import {
  findInstafyDesktopDeepLinkArg,
  INSTAFY_DESKTOP_PROTOCOL,
  resolveDesktopDeepLinkTargetUrl,
} from "./deepLinks";
import {
  createBluetoothSelectionCoordinator,
  summarizeBluetoothDevices,
  type ElectronBluetoothDeviceDescriptor,
} from "./bluetoothSelection";
import {
  desktopUpdaterStatus,
  startDesktopUpdater,
  triggerDesktopUpdaterCheck,
  triggerDesktopUpdaterDownload,
  triggerDesktopUpdaterInstall,
} from "./updater";
import {
  CURRENT_DESKTOP_EXTENSION_REGISTRY,
} from "./currentDesktopFeatureComposition";
import { createDesktopVoiceHostSupervisor } from "./speechHostSupervisor";
import { createDesktopSpeechTunnelSupervisor } from "./speechTunnelSupervisor";
import {
  PersonalBrowserHost,
  type PersonalBrowserReleaseLease,
  type PersonalBrowserStatus,
} from "./personalBrowserHost";
import {
  isPersonalBrowserFeatureEnabled,
} from "./personalBrowserSecurity";
import {
  resolveSmokeParentWatchdogConfig,
  startSmokeParentWatchdog,
} from "./smokeParentWatchdog";
import {
  connectDefaultCodexCredential,
  getDefaultCodexAuthJsonStatus,
  type DesktopCodexCredentialConnectRequest,
  type DesktopCodexVisibleSession,
} from "./codexCredentialBridge";
import { resolveVerifiedBundledRuntimeAgent } from "./bundledRuntimeAgent";
import {
  attestPersonalBrowserIdentity,
  resolvePersonalBrowserRuntimeConnection,
} from "./personalBrowserIdentity";

type DesktopNotificationPayload = {
  title: string;
  body?: string;
};

type DesktopRuntimeStartRequest = {
  projectId: string;
  controllerUrl: string;
  controllerAccessToken: string;
  proxyBaseUrl?: string;
  displayName?: string;
  workspaceDir?: string;
  runtimeBinaryPath?: string;
  enablePersonalBrowser?: boolean;
  personalBrowserOwnerId?: string;
};

type DesktopRuntimeStartResponse = {
  pid: number;
  logFilePath?: string;
  runtimeId?: string;
};

type DesktopSpeechTunnelStartRequest = {
  projectId: string;
  controllerUrl: string;
  controllerAccessToken: string;
  forceRestart?: boolean;
  waitForReady?: boolean;
};

type DesktopVoiceHostBootstrapRequest = {
  action?: "check" | "install_transcription" | "remove_transcription";
  dryRun?: boolean;
};

type DesktopVoiceHostSetEnabledRequest = {
  enabled?: boolean;
};

type DesktopExtensionInvokeRequest = {
  extensionId?: unknown;
  method?: unknown;
  payload?: unknown;
};

const DEFAULT_PROD_URL = "https://prod.instafy.dev/studio";
const DEFAULT_DEV_URL = "http://127.0.0.1:5173/studio";

const READ_VISIBLE_SUPABASE_SESSION_SCRIPT = `
  (async () => {
    const client = globalThis.__INSTAFY_SUPABASE__;
    if (!client?.auth || typeof client.auth.getSession !== "function") {
      return null;
    }
    let result = await client.auth.getSession();
    let session = result?.data?.session ?? null;
    const expiresAt = Number(session?.expires_at ?? 0);
    if (
      session &&
      Number.isFinite(expiresAt) &&
      expiresAt * 1000 - Date.now() < 60000 &&
      typeof client.auth.refreshSession === "function"
    ) {
      result = await client.auth.refreshSession();
      session = result?.data?.session ?? null;
    }
    if (!session) {
      return null;
    }
    return {
      accessToken: typeof session.access_token === "string" ? session.access_token : "",
      userId: typeof session.user?.id === "string" ? session.user.id : "",
      expiresAt: Number(session.expires_at ?? 0),
    };
  })()
`;

async function resolveVisibleSupabaseSession(
  event: Electron.IpcMainInvokeEvent,
): Promise<DesktopCodexVisibleSession | null> {
  const callerFrame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (
    !callerFrame ||
    callerFrame.processId !== mainFrame.processId ||
    callerFrame.routingId !== mainFrame.routingId
  ) {
    throw new Error("Desktop credential requests must come from the active top-level app.");
  }
  const value = await mainFrame.executeJavaScript(
    READ_VISIBLE_SUPABASE_SESSION_SCRIPT,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    accessToken:
      typeof record.accessToken === "string" ? record.accessToken : undefined,
    userId: typeof record.userId === "string" ? record.userId : undefined,
    expiresAt:
      typeof record.expiresAt === "number" ? record.expiresAt : undefined,
  };
}

type DesktopAppConfig = {
  runtimeBinaryPath?: string;
  workspaceDir?: string;
  /** Per-space bring-your-own-folder bindings keyed by space/project id. */
  projectWorkspaceDirs?: Record<string, string>;
  desktopVoiceHostEnabled?: boolean;
  desktopHardwareHostId?: string;
};

type DesktopLocalHardwareHostStatus = {
  runtimeHostId: string;
  runtimeHostLabel: string;
  platform: string;
  providerIds: string[];
  supportedCapabilities: string[];
};

const CONFIG_FILENAME = "desktop-config.json";

installDesktopLogging();

function readArgValue(flagName: string): string | null {
  for (const rawArg of process.argv.slice(1)) {
    if (rawArg === flagName) {
      return "";
    }
    if (rawArg.startsWith(`${flagName}=`)) {
      const value = rawArg.slice(flagName.length + 1).trim();
      return value.length > 0 ? value : "";
    }
  }
  return null;
}

function parseBooleanOverride(value: string | null | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveDesktopUserDataDir(): string | null {
  const explicitEnv = process.env.INSTAFY_DESKTOP_USER_DATA_DIR?.trim();
  if (explicitEnv) {
    return path.resolve(explicitEnv);
  }
  const explicitArg = readArgValue("--instafy-user-data-dir");
  if (typeof explicitArg === "string" && explicitArg.trim().length > 0) {
    return path.resolve(explicitArg.trim());
  }
  return null;
}

function shouldAllowMultipleInstances(): boolean {
  if (parseBooleanOverride(process.env.INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES)) {
    return true;
  }
  return process.argv.includes("--allow-multiple-instances");
}

function shouldUseFakeMediaDevices(): boolean {
  if (parseBooleanOverride(process.env.INSTAFY_DESKTOP_FAKE_MEDIA)) {
    return true;
  }
  return process.argv.includes("--instafy-fake-media");
}

const desktopUserDataDir = resolveDesktopUserDataDir();
if (desktopUserDataDir) {
  fs.mkdirSync(desktopUserDataDir, { recursive: true });
  app.setPath("userData", desktopUserDataDir);
}

const smokeParentWatchdogConfig = resolveSmokeParentWatchdogConfig(
  process.env.INSTAFY_DESKTOP_SMOKE_PARENT_PID,
  process.env.INSTAFY_DESKTOP_SMOKE_RECOVERY_MARKER,
  readArgValue("--instafy-smoke-recovery-marker"),
  process.env.INSTAFY_DESKTOP_SMOKE_RECOVERY_ROOT,
  desktopUserDataDir,
);
const stopSmokeParentWatchdog = smokeParentWatchdogConfig
  ? startSmokeParentWatchdog(smokeParentWatchdogConfig, {
      onParentLost: () => {
        desktopLog("warn", "[instafy-desktop] smoke parent exited; closing disposable app");
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.destroy();
          }
        }
        app.exit(0);
      },
    })
  : () => {};

if (shouldUseFakeMediaDevices()) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
}

registerDesktopDeepLinkProtocol();

function normalizeStartUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/studio";
    }
    return parsed.toString();
  } catch (_error) {
    return value;
  }
}

function getStartUrl() {
  const explicitUrl = process.env.INSTAFY_APP_URL?.trim();
  if (explicitUrl) {
    return normalizeStartUrl(explicitUrl);
  }

  const explicitArg = readArgValue("--instafy-app-url");
  if (typeof explicitArg === "string" && explicitArg.trim().length > 0) {
    return normalizeStartUrl(explicitArg.trim());
  }

  if (app.isPackaged) {
    return DEFAULT_PROD_URL;
  }

  return DEFAULT_DEV_URL;
}

function registerDesktopDeepLinkProtocol() {
  try {
    const defaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true;
    if (defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(INSTAFY_DESKTOP_PROTOCOL, process.execPath, [
        path.resolve(process.argv[1] ?? ""),
      ]);
      return;
    }
    app.setAsDefaultProtocolClient(INSTAFY_DESKTOP_PROTOCOL);
  } catch (error) {
    desktopLog("warn", "[instafy-desktop] deep-link-protocol-registration-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function getAllowedOrigin(): string {
  return new URL(getStartUrl()).origin;
}

function assertAllowedCaller(event: Electron.IpcMainInvokeEvent): string {
  const callerUrl = event.senderFrame?.url ?? event.sender?.getURL?.() ?? "";
  if (!callerUrl) {
    throw new Error("Missing caller URL for desktop IPC request.");
  }
  const callerOrigin = new URL(callerUrl).origin;
  const allowedOrigin = getAllowedOrigin();
  if (callerOrigin !== allowedOrigin) {
    throw new Error(`Blocked desktop IPC request from origin ${callerOrigin}.`);
  }
  return callerUrl;
}

type StudioRendererGenerationLease = {
  webContentsId: number;
  generation: number;
  frameProcessId: number;
  frameRoutingId: number;
};

type StudioRendererGenerationState = {
  generation: number;
  acceptsIpc: boolean;
};

const studioRendererGenerations = new Map<number, StudioRendererGenerationState>();

function advanceStudioRendererGeneration(webContentsId: number) {
  const current = studioRendererGenerations.get(webContentsId);
  studioRendererGenerations.set(
    webContentsId,
    { generation: (current?.generation ?? 0) + 1, acceptsIpc: false },
  );
}

function acceptStudioRendererGeneration(webContentsId: number) {
  const current = studioRendererGenerations.get(webContentsId);
  if (!current) {
    return;
  }
  studioRendererGenerations.set(webContentsId, { ...current, acceptsIpc: true });
}

function captureStudioRendererGeneration(
  event: Electron.IpcMainInvokeEvent,
): StudioRendererGenerationLease {
  const webContentsId = event.sender.id;
  const senderFrame = event.senderFrame;
  const state = studioRendererGenerations.get(webContentsId);
  if (!senderFrame || !state?.acceptsIpc) {
    throw new Error("Studio renderer is no longer active.");
  }
  return {
    webContentsId,
    generation: state.generation,
    frameProcessId: senderFrame.processId,
    frameRoutingId: senderFrame.routingId,
  };
}

function studioRendererGenerationIsCurrent(lease: StudioRendererGenerationLease): boolean {
  const window = BrowserWindow.getAllWindows().find(
    (candidate) => candidate.webContents.id === lease.webContentsId,
  );
  const state = studioRendererGenerations.get(lease.webContentsId);
  if (!window || !state?.acceptsIpc || state.generation !== lease.generation) {
    return false;
  }
  const frame = window.webContents.mainFrame;
  return (
    frame.processId === lease.frameProcessId &&
    frame.routingId === lease.frameRoutingId
  );
}

function assertStudioRendererGenerationCurrent(lease: StudioRendererGenerationLease) {
  if (!studioRendererGenerationIsCurrent(lease)) {
    throw new Error("Studio renderer changed while Personal Browser work was queued.");
  }
}

function resolveDefaultWorkspaceDir(): string {
  return path.join(os.homedir(), ".instafy", "workspace");
}

function resolveLogFilePath(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(app.getPath("logs"), `runtime-agent-${safe}.log`);
}

function readConfig(): DesktopAppConfig {
  try {
    const raw = fs.readFileSync(path.join(app.getPath("userData"), CONFIG_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as DesktopAppConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(next: DesktopAppConfig) {
  const filePath = path.join(app.getPath("userData"), CONFIG_FILENAME);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
}

function getShortHostname(): string {
  return os.hostname().split(".")[0]?.trim() || os.hostname();
}

function isMachineGeneratedHostname(value: string): boolean {
  const normalized = value.trim();
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      normalized,
    ) ||
    /^[0-9a-f-]{20,}$/i.test(normalized)
  );
}

function getDesktopHardwareHostLabel(platform = os.platform()): string {
  const hostname = getShortHostname();
  if (!hostname || isMachineGeneratedHostname(hostname)) {
    if (platform === "darwin") {
      return "This Mac";
    }
    if (platform === "win32") {
      return "This PC";
    }
    return "This computer";
  }
  return `Desktop on ${hostname}`;
}

function resolveDesktopHardwareHostId(config: DesktopAppConfig = readConfig()): string {
  const existing = config.desktopHardwareHostId?.trim();
  if (existing) {
    return existing;
  }
  const nextId = `desktop-${randomUUID()}`;
  writeConfig({ ...config, desktopHardwareHostId: nextId });
  return nextId;
}

function getDesktopLocalHardwareHostStatus(): DesktopLocalHardwareHostStatus {
  const platform = os.platform();
  return {
    runtimeHostId: resolveDesktopHardwareHostId(),
    runtimeHostLabel: getDesktopHardwareHostLabel(platform),
    platform,
    providerIds: [SERIAL_HARDWARE_PROVIDER_ID],
    supportedCapabilities: SERIAL_HARDWARE_PROVIDER_DESCRIPTOR.requestedCapabilities,
  };
}

function resolveDesktopVoiceHostOptIn(config: DesktopAppConfig = readConfig()) {
  return config.desktopVoiceHostEnabled === true;
}

function appendBluetoothDebugLog(event: string, payload: Record<string, unknown>) {
  try {
    const logPath = path.join(app.getPath("userData"), "bluetooth-debug.ndjson");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        event,
        ...payload,
      })}\n`,
      "utf8",
    );
  } catch (error) {
    desktopLog("warn", "[instafy-desktop] bluetooth-debug-log-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

let pendingDesktopDeepLinkTargetUrl: string | null = null;

function focusMainWindow(mainWindow: BrowserWindow) {
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

function openUrlInMainWindow(targetUrl: string) {
  const existingWindow = BrowserWindow.getAllWindows().at(0);
  if (!existingWindow) {
    createMainWindow(targetUrl);
    return;
  }
  void existingWindow.loadURL(targetUrl);
  focusMainWindow(existingWindow);
}

function handleDesktopDeepLink(rawUrl: string | null | undefined): boolean {
  if (typeof rawUrl !== "string") {
    return false;
  }
  const targetUrl = resolveDesktopDeepLinkTargetUrl(rawUrl, getStartUrl());
  if (!targetUrl) {
    return false;
  }
  if (!app.isReady()) {
    pendingDesktopDeepLinkTargetUrl = targetUrl;
    return true;
  }
  openUrlInMainWindow(targetUrl);
  return true;
}

function createMainWindow(initialUrl?: string) {
  const startUrl = initialUrl ?? getStartUrl();
  const bluetoothSelectionCoordinator = createBluetoothSelectionCoordinator({
    onLog(event, payload) {
      appendBluetoothDebugLog(event, payload);
      desktopLog("info", `[instafy-desktop] ${event}`, payload);
    },
  });
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 780,
    backgroundColor: "#0b0b0d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const mainWebContentsId = mainWindow.webContents.id;
  studioRendererGenerations.set(mainWebContentsId, { generation: 0, acceptsIpc: false });
  personalBrowserHost?.attachWindow(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl) => {
      desktopLog("error", "[instafy-desktop] did-fail-load", {
        errorCode,
        errorDescription,
        url: validatedUrl,
      });
    },
  );

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    advanceStudioRendererGeneration(mainWebContentsId);
    releasePersonalBrowserForOwnerNavigation(mainWindow);
    desktopLog("error", "[instafy-desktop] render-process-gone", details);
  });

  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      advanceStudioRendererGeneration(mainWebContentsId);
      releasePersonalBrowserForOwnerNavigation(mainWindow);
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    desktopLog("info", "[instafy-desktop] did-finish-load", {
      url: mainWindow.webContents.getURL(),
    });
  });

  mainWindow.webContents.on("did-navigate", () => {
    acceptStudioRendererGeneration(mainWebContentsId);
  });

  mainWindow.webContents.on(
    "select-bluetooth-device",
    (event, deviceList: ElectronBluetoothDeviceDescriptor[], callback) => {
      event.preventDefault();
      appendBluetoothDebugLog("select-bluetooth-device.raw", {
        deviceCount: deviceList.length,
        devices: summarizeBluetoothDevices(deviceList),
      });
      bluetoothSelectionCoordinator.handleDeviceUpdate(deviceList, callback);
    },
  );

  mainWindow.on("closed", () => {
    studioRendererGenerations.delete(mainWebContentsId);
    bluetoothSelectionCoordinator.dispose();
    personalBrowserHost?.detachWindow(mainWindow);
  });

  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    const allowedOrigin = new URL(startUrl).origin;
    const targetOrigin = new URL(navigationUrl).origin;
    if (allowedOrigin !== targetOrigin) {
      event.preventDefault();
      void shell.openExternal(navigationUrl);
    }
  });

  void mainWindow.loadURL(startUrl);
  return mainWindow;
}

type DesktopPersonalBrowserCredentials = {
  controlUrl: string;
  token: string;
  projectId: string;
};

type DesktopRuntimeRestartOptions = Omit<
  StartDesktopRuntimeOptions,
  "runtimeId" | "personalBrowser"
>;

type DesktopRuntimeRecord = {
  handle: DesktopRuntimeHandle;
  projectId: string;
  controllerUrl: string;
  logFilePath?: string;
  runtimeId?: string;
  personalBrowser?: DesktopPersonalBrowserCredentials;
  restartOptions: DesktopRuntimeRestartOptions;
};

let desktopRuntime: DesktopRuntimeRecord | null = null;
let pausedPersonalBrowserRuntime: {
  projectId: string;
  restartOptions: DesktopRuntimeRestartOptions;
} | null = null;
let desktopRuntimeMutationTail: Promise<void> = Promise.resolve();
let personalBrowserMutationTail: Promise<void> = Promise.resolve();
let desktopVoiceHostSupervisor: ReturnType<typeof createDesktopVoiceHostSupervisor> | null = null;
let desktopSpeechTunnelSupervisor: ReturnType<typeof createDesktopSpeechTunnelSupervisor> | null = null;
let personalBrowserHost: PersonalBrowserHost | null = null;
let personalBrowserProfileUserId: string | null = null;

async function serializeDesktopRuntimeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = desktopRuntimeMutationTail;
  let release!: () => void;
  desktopRuntimeMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function serializePersonalBrowserMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = personalBrowserMutationTail;
  let release!: () => void;
  personalBrowserMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function requirePersonalBrowserOwnerId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Personal Browser requires ownerId.");
  }
  const ownerId = value.trim();
  if (!ownerId || ownerId.length > 256) {
    throw new Error("Personal Browser ownerId is empty or too long.");
  }
  return ownerId;
}

function revokePersonalBrowserRuntimeBinding(record: DesktopRuntimeRecord) {
  if (!record.personalBrowser) {
    return;
  }
  const host = personalBrowserHost;
  if (!host || host.getStatus().projectId !== record.projectId) {
    return;
  }
  // A Personal Browser capability is scoped to one runtime process. Any
  // process exit, replacement, or explicit stop revokes it synchronously.
  host.pauseAgentControl();
  host.setRuntimeId(record.projectId, null);
}

function registerDesktopRuntime(
  handle: DesktopRuntimeHandle,
  options: {
    projectId: string;
    controllerUrl: string;
    logFilePath?: string;
    runtimeId?: string;
    personalBrowser?: DesktopPersonalBrowserCredentials;
    restartOptions: DesktopRuntimeRestartOptions;
  },
): DesktopRuntimeRecord {
  const record: DesktopRuntimeRecord = { handle, ...options };
  desktopRuntime = record;
  if (record.runtimeId) {
    personalBrowserHost?.setRuntimeId(record.projectId, record.runtimeId);
  }
  void handle.exited.finally(() => {
    if (desktopRuntime?.handle === handle) {
      desktopRuntime = null;
      revokePersonalBrowserRuntimeBinding(record);
      if (!record.personalBrowser && record.runtimeId) {
        personalBrowserHost?.setRuntimeId(record.projectId, null);
      }
    }
  });
  return record;
}

async function suspendPersonalBrowserRuntime(projectId: string) {
  const runtime = desktopRuntime;
  if (!runtime?.personalBrowser || runtime.projectId !== projectId) {
    return;
  }
  pausedPersonalBrowserRuntime = {
    projectId,
    restartOptions: runtime.restartOptions,
  };
  desktopRuntime = null;
  personalBrowserHost?.setRuntimeId(projectId, null);
  await stopDesktopRuntime(runtime.handle).catch(() => undefined);
}

async function resumePersonalBrowserRuntime(projectId: string) {
  const paused = pausedPersonalBrowserRuntime;
  if (!paused || paused.projectId !== projectId) {
    return;
  }
  const personalBrowser = personalBrowserHost?.getControlCredentials(projectId);
  if (!personalBrowser) {
    throw new Error("Personal Browser control credentials are unavailable after resume.");
  }
  const handle = await startDesktopRuntime({
    ...paused.restartOptions,
    personalBrowser,
  });
  const runtimeId = handle.runtimeId;
  if (!runtimeId) {
    await stopDesktopRuntime(handle).catch(() => undefined);
    throw new Error("Controller did not assign a Personal Browser runtime id.");
  }
  registerDesktopRuntime(handle, {
    projectId,
    controllerUrl: paused.restartOptions.controllerUrl ?? "",
    logFilePath: paused.restartOptions.logging?.logFilePath,
    runtimeId,
    personalBrowser,
    restartOptions: paused.restartOptions,
  });
  pausedPersonalBrowserRuntime = null;
}

async function discardPersonalBrowserRuntime(projectId: string) {
  forgetPausedPersonalBrowserRuntime(projectId);
  const runtime = desktopRuntime;
  if (!runtime?.personalBrowser || runtime.projectId !== projectId) {
    return;
  }
  desktopRuntime = null;
  personalBrowserHost?.setRuntimeId(projectId, null);
  await stopDesktopRuntime(runtime.handle).catch(() => undefined);
}

function forgetPausedPersonalBrowserRuntime(projectId: string) {
  if (pausedPersonalBrowserRuntime?.projectId === projectId) {
    pausedPersonalBrowserRuntime = null;
  }
}

function expirePersonalBrowserRelease(lease: PersonalBrowserReleaseLease) {
  void serializePersonalBrowserMutation(async () => {
    const expiredProjectId = await personalBrowserHost?.expireRelease(lease);
    if (!expiredProjectId) {
      return;
    }
    personalBrowserProfileUserId = null;
    // Release enqueues suspension before its grace timer starts. Enqueue
    // credential cleanup on that same FIFO, but do not hold the browser lane
    // while a child process shuts down. A later Resume queues behind cleanup.
    void serializeDesktopRuntimeMutation(async () => {
      forgetPausedPersonalBrowserRuntime(expiredProjectId);
    }).catch((error) => {
      desktopLog("warn", "[instafy-desktop] personal-browser-paused-runtime-cleanup-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }).catch((error) => {
    desktopLog("warn", "[instafy-desktop] personal-browser-release-expiry-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

function releasePersonalBrowserForOwnerNavigation(window: BrowserWindow) {
  const host = personalBrowserHost;
  if (!host) {
    return;
  }
  const before = host.getStatus();
  const released = host.releaseForOwnerNavigation(window);
  const projectId = before.projectId;
  if (!before.ownerId || !projectId || released.ownerId) {
    return;
  }
  void serializeDesktopRuntimeMutation(() =>
    suspendPersonalBrowserRuntime(projectId),
  );
}

async function rebuildDesktopVoiceInfrastructure() {
  const voiceHostEnabled = resolveDesktopVoiceHostOptIn();

  const existingTunnelSupervisor = desktopSpeechTunnelSupervisor;
  desktopSpeechTunnelSupervisor = null;
  if (existingTunnelSupervisor) {
    await existingTunnelSupervisor.stop().catch(() => undefined);
  }

  const existingVoiceHostSupervisor = desktopVoiceHostSupervisor;
  desktopVoiceHostSupervisor = null;
  if (existingVoiceHostSupervisor) {
    await existingVoiceHostSupervisor.stop().catch(() => undefined);
  }

  desktopVoiceHostSupervisor = createDesktopVoiceHostSupervisor({
    enabled: voiceHostEnabled,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    currentDir: __dirname,
    userDataDir: app.getPath("userData"),
    logger(level, message, payload) {
      desktopLog(level, message, payload ?? {});
    },
  });
  desktopSpeechTunnelSupervisor = createDesktopSpeechTunnelSupervisor({
    enabled: voiceHostEnabled,
    logger(level, message, payload) {
      desktopLog(level, message, payload ?? {});
    },
    ensureVoiceHostRunning: async () => {
      if (!desktopVoiceHostSupervisor) {
        return;
      }
      const status = desktopVoiceHostSupervisor.peekStatus();
      if (status.speechService.reachable && status.providerHost.reachable) {
        return;
      }
      await desktopVoiceHostSupervisor.ensureRunning();
    },
  });

  if (voiceHostEnabled) {
    void desktopVoiceHostSupervisor.ensureRunning().catch((error) => {
      desktopLog("warn", "[instafy-desktop] desktop voice host startup failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

async function promptForRuntimeBinary(window: BrowserWindow | null): Promise<string | null> {
  const result = await dialog.showOpenDialog(window ?? undefined, {
    title: "Select runtime-agent binary",
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0] ?? null;
}

async function promptForWorkspaceDir(window: BrowserWindow | null): Promise<string | null> {
  const result = await dialog.showOpenDialog(window ?? undefined, {
    title: "Select workspace directory",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0] ?? null;
}

// Mirrors the origin server's workspace_dir_empty rules: these entries do not
// count as content when deciding whether a folder can be bound to a space.
const WORKSPACE_BINDING_IGNORED_ENTRIES = new Set([".instafy", ".git", ".DS_Store"]);

type ProjectWorkspaceFolderValidation =
  | { ok: true; state: "empty" | "linked" }
  | { ok: false; reason: string };

function readSpaceManifestId(folder: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(folder, ".instafy", "space.json"), "utf8");
    const parsed = JSON.parse(raw) as { spaceId?: unknown };
    return typeof parsed?.spaceId === "string" && parsed.spaceId.trim().length > 0
      ? parsed.spaceId.trim()
      : null;
  } catch {
    return null;
  }
}

function validateProjectWorkspaceFolder(
  folder: string,
  projectId: string,
): ProjectWorkspaceFolderValidation {
  const manifestSpaceId = readSpaceManifestId(folder);
  if (manifestSpaceId === projectId) {
    return { ok: true, state: "linked" };
  }
  if (manifestSpaceId) {
    return {
      ok: false,
      reason: "This folder is already linked to a different space. Choose another folder.",
    };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return { ok: false, reason: "This folder could not be read." };
  }
  const meaningful = entries.filter((name) => !WORKSPACE_BINDING_IGNORED_ENTRIES.has(name));
  if (meaningful.length > 0) {
    return {
      ok: false,
      reason:
        "This folder already has files in it. Choose an empty folder, or a folder previously linked to this space, so nothing gets mixed or overwritten.",
    };
  }
  return { ok: true, state: "empty" };
}

function writeSpaceManifest(folder: string, projectId: string, controllerUrl?: string) {
  const manifestDir = path.join(folder, ".instafy");
  const manifestPath = path.join(manifestDir, "space.json");
  if (fs.existsSync(manifestPath)) {
    return;
  }
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifest: Record<string, string> = {
    spaceId: projectId,
    createdAt: new Date().toISOString(),
  };
  if (controllerUrl && controllerUrl.trim().length > 0) {
    manifest.controllerUrl = controllerUrl.trim();
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const allowMultipleInstances = shouldAllowMultipleInstances();
if (!allowMultipleInstances) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", (_event, commandLine) => {
      const deepLinkArg = findInstafyDesktopDeepLinkArg(commandLine);
      if (deepLinkArg && handleDesktopDeepLink(deepLinkArg)) {
        return;
      }
      const existingWindow = BrowserWindow.getAllWindows().at(0);
      if (!existingWindow) {
        return;
      }
      focusMainWindow(existingWindow);
    });
  }
}

const initialDesktopDeepLinkArg = findInstafyDesktopDeepLinkArg(process.argv);
if (initialDesktopDeepLinkArg) {
  handleDesktopDeepLink(initialDesktopDeepLinkArg);
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDesktopDeepLink(url);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

function broadcastPersonalBrowserStatus(status: PersonalBrowserStatus) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("instafy:personalBrowserStatus", status);
    }
  }
}

app.whenReady().then(() => {
  personalBrowserHost = new PersonalBrowserHost({
    enabled: isPersonalBrowserFeatureEnabled(process.env.INSTAFY_DESKTOP_PERSONAL_BROWSER),
    onReleaseExpiry: expirePersonalBrowserRelease,
    onEmergencyPause: (projectId) => {
      void serializeDesktopRuntimeMutation(() => suspendPersonalBrowserRuntime(projectId)).catch(
        (error) => {
          desktopLog("warn", "[instafy-desktop] personal-browser-emergency-pause-failed", {
            projectId,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
    onStatus: broadcastPersonalBrowserStatus,
    logger(level, message, payload) {
      desktopLog(level, message, payload ?? {});
    },
  });

  void rebuildDesktopVoiceInfrastructure().catch((error) => {
    desktopLog("warn", "[instafy-desktop] desktop voice infrastructure startup failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  const initialWindowUrl = pendingDesktopDeepLinkTargetUrl ?? getStartUrl();
  pendingDesktopDeepLinkTargetUrl = null;
  createMainWindow(initialWindowUrl);
  startDesktopUpdater();

  ipcMain.handle("instafy:personalBrowserStatus", async (event) => {
    assertAllowedCaller(event);
    return personalBrowserHost?.getStatus() ?? {
      supported: false,
      enabled: false,
      state: "closed",
      visible: false,
      url: "about:blank",
      canGoBack: false,
      canGoForward: false,
      agentControlEnabled: false,
    };
  });

  ipcMain.handle("instafy:personalBrowserOpen", async (event, payload) => {
    const callerUrl = assertAllowedCaller(event);
    const rendererLease = captureStudioRendererGeneration(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
    const nextProjectId = typeof payload?.projectId === "string" ? payload.projectId.trim() : "";
    const currentStatus = personalBrowserHost.getStatus();
    // Identity attestation performs a network request. Revoke agent control
    // before it starts so an auth change cannot leave the previous user's
    // partition controllable while a replacement open is queued.
    if (currentStatus.projectId && currentStatus.ownerId) {
      personalBrowserHost.pauseAgentControl();
    }
    return serializePersonalBrowserMutation(async () => {
      assertStudioRendererGenerationCurrent(rendererLease);
      let profileUserId: string;
      try {
        profileUserId = await attestPersonalBrowserIdentity(
          { controllerUrl: payload?.controllerUrl },
          {
            appUrl: getStartUrl(),
            callerUrl,
            fetch: (url, init) => net.fetch(url, init),
            resolveCurrentSession: () => resolveVisibleSupabaseSession(event),
          },
        );
      } catch (error) {
        // Without a fresh server attestation the main process cannot prove
        // that the mounted partition still belongs to the visible account.
        // Destroy the view (but retain its on-disk profile) instead of leaking
        // the previous user's signed-in page into a changed/offline session.
        const revokedProjectId = personalBrowserHost!.getStatus().projectId;
        await personalBrowserHost!.close();
        personalBrowserProfileUserId = null;
        if (revokedProjectId) {
          await serializeDesktopRuntimeMutation(() =>
            discardPersonalBrowserRuntime(revokedProjectId),
          );
        }
        throw error;
      }
      assertStudioRendererGenerationCurrent(rendererLease);
      const previousStatus = personalBrowserHost!.getStatus();
      const previousProjectId = previousStatus.projectId;
      const previousOwnerWasAssigned = previousStatus.ownerId !== undefined;
      const authenticatedIdentityChanged = Boolean(
        previousProjectId &&
          personalBrowserProfileUserId !== null &&
          personalBrowserProfileUserId !== profileUserId,
      );
      const bindingChanged = Boolean(
        previousProjectId &&
          nextProjectId &&
          (previousProjectId !== nextProjectId ||
            (previousStatus.ownerId !== undefined && previousStatus.ownerId !== ownerId) ||
            (personalBrowserProfileUserId !== null &&
              personalBrowserProfileUserId !== profileUserId)),
      );
      if (authenticatedIdentityChanged && previousProjectId) {
        await serializeDesktopRuntimeMutation(() =>
          discardPersonalBrowserRuntime(previousProjectId),
        );
        await personalBrowserHost!.close();
        personalBrowserProfileUserId = null;
      } else if (bindingChanged && previousProjectId && previousOwnerWasAssigned) {
        personalBrowserHost!.pauseAgentControl();
        await serializeDesktopRuntimeMutation(() =>
          discardPersonalBrowserRuntime(previousProjectId),
        );
      }
      assertStudioRendererGenerationCurrent(rendererLease);
      const status = await personalBrowserHost!.open({
        projectId: payload?.projectId,
        profileKey: `instafy-user:${profileUserId}`,
        ownerId,
        url: payload?.url,
      });
      if (
        bindingChanged &&
        !authenticatedIdentityChanged &&
        previousProjectId &&
        !previousOwnerWasAssigned
      ) {
        // A released view still has a live expiry lease. Validate and switch
        // the host first so a malformed replacement cannot strand that lease,
        // then clear the old paused runtime on the desktop FIFO.
        void serializeDesktopRuntimeMutation(() =>
          discardPersonalBrowserRuntime(previousProjectId),
        ).catch((error) => {
          desktopLog("warn", "[instafy-desktop] personal-browser-replaced-runtime-cleanup-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
      if (!studioRendererGenerationIsCurrent(rendererLease)) {
        personalBrowserHost!.release(ownerId);
        throw new Error("Studio renderer changed while Personal Browser was opening.");
      }
      personalBrowserProfileUserId = profileUserId;
      return status;
    });
  });

  ipcMain.handle("instafy:personalBrowserSetBounds", async (event, payload) => {
    assertAllowedCaller(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
    if (!personalBrowserHost.isOwnedBy(ownerId)) {
      return personalBrowserHost.getStatus();
    }
    return personalBrowserHost.setBounds(payload);
  });

  ipcMain.handle("instafy:personalBrowserRelease", async (event, payload) => {
    assertAllowedCaller(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
    if (!personalBrowserHost.isOwnedBy(ownerId)) {
      return personalBrowserHost.getStatus();
    }
    const projectId = personalBrowserHost.getStatus().projectId;
    // Release is an ownership and control-revocation boundary. Revoke the
    // broker synchronously, while retaining the hidden view for a short
    // same-identity remount grace period.
    const released = personalBrowserHost.release(ownerId);
    if (projectId) {
      void serializeDesktopRuntimeMutation(() =>
        suspendPersonalBrowserRuntime(projectId),
      );
    }
    return released;
  });

  ipcMain.handle("instafy:personalBrowserShow", async (event, payload) => {
    assertAllowedCaller(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
    if (!personalBrowserHost.isOwnedBy(ownerId)) {
      return personalBrowserHost.getStatus();
    }
    return personalBrowserHost.show(payload?.visible);
  });

  ipcMain.handle("instafy:personalBrowserNavigate", async (event, payload) => {
    assertAllowedCaller(event);
    const rendererLease = captureStudioRendererGeneration(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    return serializePersonalBrowserMutation(async () => {
      assertStudioRendererGenerationCurrent(rendererLease);
      const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
      if (!personalBrowserHost!.isOwnedBy(ownerId)) {
        return personalBrowserHost!.getStatus();
      }
      return personalBrowserHost!.navigate(payload?.url);
    });
  });

  ipcMain.handle("instafy:personalBrowserGoBack", async (event, payload) => {
    assertAllowedCaller(event);
    const rendererLease = captureStudioRendererGeneration(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    return serializePersonalBrowserMutation(async () => {
      assertStudioRendererGenerationCurrent(rendererLease);
      const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
      if (!personalBrowserHost!.isOwnedBy(ownerId)) {
        return personalBrowserHost!.getStatus();
      }
      return personalBrowserHost!.goBack();
    });
  });

  ipcMain.handle("instafy:personalBrowserGoForward", async (event, payload) => {
    assertAllowedCaller(event);
    const rendererLease = captureStudioRendererGeneration(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    return serializePersonalBrowserMutation(async () => {
      assertStudioRendererGenerationCurrent(rendererLease);
      const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
      if (!personalBrowserHost!.isOwnedBy(ownerId)) {
        return personalBrowserHost!.getStatus();
      }
      return personalBrowserHost!.goForward();
    });
  });

  ipcMain.handle("instafy:personalBrowserReload", async (event, payload) => {
    assertAllowedCaller(event);
    const rendererLease = captureStudioRendererGeneration(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    return serializePersonalBrowserMutation(async () => {
      assertStudioRendererGenerationCurrent(rendererLease);
      const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
      if (!personalBrowserHost!.isOwnedBy(ownerId)) {
        return personalBrowserHost!.getStatus();
      }
      return personalBrowserHost!.reload();
    });
  });

  ipcMain.handle("instafy:personalBrowserSetAgentControlEnabled", async (event, payload) => {
    assertAllowedCaller(event);
    const rendererLease = captureStudioRendererGeneration(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
    const enabled = payload?.enabled;
    if (typeof enabled !== "boolean") {
      throw new Error("Personal Browser agent control setting must be a boolean.");
    }
    if (!personalBrowserHost.isOwnedBy(ownerId)) {
      return personalBrowserHost.getStatus();
    }
    // Pause is a revocation boundary. Clear the broker synchronously before
    // waiting for any queued navigation/runtime work to finish.
    if (!enabled) {
      personalBrowserHost.pauseAgentControl();
    }
    return serializePersonalBrowserMutation(async () => {
      assertStudioRendererGenerationCurrent(rendererLease);
      if (!personalBrowserHost!.isOwnedBy(ownerId)) {
        return personalBrowserHost!.getStatus();
      }
      const projectId = personalBrowserHost!.getStatus().projectId;
      if (!projectId) {
        throw new Error("Personal Browser has no active project.");
      }
      if (!enabled) {
        return serializeDesktopRuntimeMutation(async () => {
          await suspendPersonalBrowserRuntime(projectId);
          return personalBrowserHost!.getStatus();
        });
      }
      return serializeDesktopRuntimeMutation(async () => {
        if (!personalBrowserHost!.isOwnedBy(ownerId)) {
          return personalBrowserHost!.getStatus();
        }
        const preparedEpoch = await personalBrowserHost!.prepareAgentControl();
        try {
          await resumePersonalBrowserRuntime(projectId);
        } catch (error) {
          if (personalBrowserHost!.isOwnedBy(ownerId)) {
            personalBrowserHost!.pauseAgentControl();
          }
          throw error;
        }
        if (
          !studioRendererGenerationIsCurrent(rendererLease) ||
          !personalBrowserHost!.isOwnedBy(ownerId) ||
          !personalBrowserHost!.isControlEpoch(preparedEpoch)
        ) {
          await discardPersonalBrowserRuntime(projectId);
          return personalBrowserHost!.getStatus();
        }
        return personalBrowserHost!.enablePreparedAgentControl(preparedEpoch);
      });
    });
  });

  ipcMain.handle("instafy:personalBrowserClearData", async (event, payload) => {
    assertAllowedCaller(event);
    const rendererLease = captureStudioRendererGeneration(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
    if (!personalBrowserHost.isOwnedBy(ownerId)) {
      return personalBrowserHost.getStatus();
    }
    personalBrowserHost.pauseAgentControl();
    return serializePersonalBrowserMutation(async () => {
      assertStudioRendererGenerationCurrent(rendererLease);
      if (!personalBrowserHost!.isOwnedBy(ownerId)) {
        return personalBrowserHost!.getStatus();
      }
      const projectId = personalBrowserHost!.getStatus().projectId;
      await personalBrowserHost!.clearData();
      return serializeDesktopRuntimeMutation(async () => {
        if (projectId) {
          await suspendPersonalBrowserRuntime(projectId);
        }
        return personalBrowserHost!.getStatus();
      });
    });
  });

  ipcMain.handle("instafy:personalBrowserClose", async (event, payload) => {
    assertAllowedCaller(event);
    const rendererLease = captureStudioRendererGeneration(event);
    if (!personalBrowserHost) {
      throw new Error("Personal Browser host is unavailable.");
    }
    const ownerId = requirePersonalBrowserOwnerId(payload?.ownerId);
    if (!personalBrowserHost.isOwnedBy(ownerId)) {
      return personalBrowserHost.getStatus();
    }
    personalBrowserHost.pauseAgentControl();
    return serializePersonalBrowserMutation(async () => {
      assertStudioRendererGenerationCurrent(rendererLease);
      if (!personalBrowserHost!.isOwnedBy(ownerId)) {
        return personalBrowserHost!.getStatus();
      }
      const projectId = personalBrowserHost!.getStatus().projectId;
      const status = await personalBrowserHost!.close(ownerId);
      personalBrowserProfileUserId = null;
      return serializeDesktopRuntimeMutation(async () => {
        if (projectId) {
          await discardPersonalBrowserRuntime(projectId);
        }
        return status;
      });
    });
  });

  ipcMain.handle(
    "instafy:notify",
    async (_event, payload: DesktopNotificationPayload) => {
      if (BrowserWindow.getAllWindows().some((window) => window.isFocused())) {
        return;
      }
      new Notification({ title: payload.title, body: payload.body }).show();
    }
  );

  ipcMain.handle("instafy:codexAuthJsonStatus", async (event) => {
    assertAllowedCaller(event);
    return getDefaultCodexAuthJsonStatus();
  });

  ipcMain.handle(
    "instafy:connectDefaultCodexAuthJson",
    async (event, payload: DesktopCodexCredentialConnectRequest) => {
      const callerUrl = assertAllowedCaller(event);
      const rendererLease = captureStudioRendererGeneration(event);
      const result = await connectDefaultCodexCredential(payload ?? {}, {
        appUrl: getStartUrl(),
        callerUrl,
        fetch: (url, init) => net.fetch(url, init),
        resolveCurrentSession: () => resolveVisibleSupabaseSession(event),
      });
      assertStudioRendererGenerationCurrent(rendererLease);
      return result;
    },
  );

  ipcMain.handle("instafy:selectWorkspaceDir", async (event) => {
    assertAllowedCaller(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const selected = await promptForWorkspaceDir(window);
    if (!selected) {
      return null;
    }
    const config = readConfig();
    const next: DesktopAppConfig = { ...config, workspaceDir: selected };
    writeConfig(next);
    return { workspaceDir: selected };
  });

  ipcMain.handle(
    "instafy:selectProjectWorkspaceFolder",
    async (event, payload: { projectId?: string; controllerUrl?: string }) => {
      assertAllowedCaller(event);
      const projectId = typeof payload?.projectId === "string" ? payload.projectId.trim() : "";
      if (!projectId) {
        throw new Error("selectProjectWorkspaceFolder requires projectId.");
      }
      const window = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = {
        title: "Choose a folder for this space",
        buttonLabel: "Use this folder",
        properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
      };
      const result = window
        ? await dialog.showOpenDialog(window, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const selected = result.filePaths[0]!;
      const validation = validateProjectWorkspaceFolder(selected, projectId);
      if (!validation.ok) {
        return { ok: false as const, path: selected, reason: validation.reason };
      }
      const config = readConfig();
      const next: DesktopAppConfig = {
        ...config,
        projectWorkspaceDirs: {
          ...(config.projectWorkspaceDirs ?? {}),
          [projectId]: selected,
        },
      };
      writeConfig(next);
      try {
        writeSpaceManifest(
          selected,
          projectId,
          typeof payload?.controllerUrl === "string" ? payload.controllerUrl : undefined,
        );
      } catch (error) {
        console.warn(`[desktop] failed to write space manifest: ${String(error)}`);
      }
      const runtimeForProject =
        desktopRuntime && desktopRuntime.projectId === projectId ? desktopRuntime : null;
      return {
        ok: true as const,
        path: selected,
        state: validation.state,
        runtimeRestartRequired: Boolean(runtimeForProject),
      };
    },
  );

  ipcMain.handle(
    "instafy:getProjectWorkspaceBinding",
    async (event, payload: { projectId?: string }) => {
      assertAllowedCaller(event);
      const projectId = typeof payload?.projectId === "string" ? payload.projectId.trim() : "";
      if (!projectId) {
        throw new Error("getProjectWorkspaceBinding requires projectId.");
      }
      const config = readConfig();
      const bound = config.projectWorkspaceDirs?.[projectId]?.trim() || null;
      const root = config.workspaceDir?.trim() || resolveDefaultWorkspaceDir();
      return {
        path: bound,
        defaultPath: path.join(root, projectId),
      };
    },
  );

  ipcMain.handle(
    "instafy:clearProjectWorkspaceBinding",
    async (event, payload: { projectId?: string }) => {
      assertAllowedCaller(event);
      const projectId = typeof payload?.projectId === "string" ? payload.projectId.trim() : "";
      if (!projectId) {
        throw new Error("clearProjectWorkspaceBinding requires projectId.");
      }
      const config = readConfig();
      if (!config.projectWorkspaceDirs?.[projectId]) {
        return { ok: true as const };
      }
      const nextDirs = { ...config.projectWorkspaceDirs };
      delete nextDirs[projectId];
      writeConfig({ ...config, projectWorkspaceDirs: nextDirs });
      return { ok: true as const };
    },
  );

  ipcMain.handle("instafy:selectRuntimeBinary", async (event) => {
    assertAllowedCaller(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const selected = await promptForRuntimeBinary(window);
    if (!selected) {
      return null;
    }
    const config = readConfig();
    const next: DesktopAppConfig = { ...config, runtimeBinaryPath: selected };
    writeConfig(next);
    return { runtimeBinaryPath: selected };
  });

  ipcMain.handle("instafy:desktopRuntimeStatus", async (event) => {
    assertAllowedCaller(event);
    if (!desktopRuntime) {
      return { running: false };
    }
    return {
      running: true,
      pid: desktopRuntime.handle.pid,
      runtimeId: desktopRuntime.runtimeId,
      projectId: desktopRuntime.projectId,
      controllerUrl: desktopRuntime.controllerUrl,
      logFilePath: desktopRuntime.logFilePath,
    };
  });

  ipcMain.handle("instafy:localHardwareHostStatus", async (event): Promise<DesktopLocalHardwareHostStatus> => {
    assertAllowedCaller(event);
    return getDesktopLocalHardwareHostStatus();
  });

  ipcMain.handle("instafy:localHardwareSerialList", async (event): Promise<SerialPortListResult> => {
    assertAllowedCaller(event);
    return listHardwareSerialPorts();
  });

  ipcMain.handle(
    "instafy:localHardwareIoOpportunities",
    async (event): Promise<LocalHardwareIoOpportunityListResult> => {
      assertAllowedCaller(event);
      return listHardwareIoOpportunities();
    },
  );

  ipcMain.handle(
    "instafy:localHardwareIoRunAction",
    async (
      event,
      payload: LocalHardwareIoActionRunRequest,
    ): Promise<LocalHardwareIoActionRunResult> => {
      assertAllowedCaller(event);
      return runHardwareIoAction(payload);
    },
  );

  ipcMain.handle(
    "instafy:localHardwareSerialProbe",
    async (event, payload: { path?: string } | null): Promise<SerialPortProbeResult> => {
      assertAllowedCaller(event);
      const devicePath = typeof payload?.path === "string" ? payload.path : "";
      return probeHardwareSerialPort(devicePath);
    },
  );

  ipcMain.handle("instafy:desktopUpdaterStatus", async (event) => {
    assertAllowedCaller(event);
    return desktopUpdaterStatus;
  });

  ipcMain.handle("instafy:desktopUpdaterCheck", async (event) => {
    assertAllowedCaller(event);
    return await triggerDesktopUpdaterCheck();
  });

  ipcMain.handle("instafy:desktopUpdaterDownload", async (event) => {
    assertAllowedCaller(event);
    return await triggerDesktopUpdaterDownload();
  });

  ipcMain.handle("instafy:desktopUpdaterInstall", async (event) => {
    assertAllowedCaller(event);
    return triggerDesktopUpdaterInstall();
  });

  ipcMain.handle("instafy:desktopVoiceHostStatus", async (event) => {
    assertAllowedCaller(event);
    if (!desktopVoiceHostSupervisor) {
      return { enabled: false };
    }
    return await desktopVoiceHostSupervisor.getStatus();
  });

  ipcMain.handle("instafy:desktopVoiceHostRestart", async (event) => {
    assertAllowedCaller(event);
    if (!desktopVoiceHostSupervisor) {
      return { enabled: false };
    }
    return await desktopVoiceHostSupervisor.restart();
  });

  ipcMain.handle("instafy:desktopVoiceHostBootstrap", async (event, payload: DesktopVoiceHostBootstrapRequest) => {
    assertAllowedCaller(event);
    if (!desktopVoiceHostSupervisor) {
      return {
        ok: false,
        action: payload?.action ?? "check",
        dryRun: payload?.dryRun === true,
        error: "Desktop voice host supervisor is unavailable.",
        status: null,
        hostStatus: { enabled: false },
      };
    }
    return await desktopVoiceHostSupervisor.bootstrap(
      payload?.action === "install_transcription"
        ? "install_transcription"
        : payload?.action === "remove_transcription"
          ? "remove_transcription"
          : "check",
      payload?.dryRun === true,
    );
  });

  ipcMain.handle("instafy:desktopVoiceHostSetEnabled", async (event, payload: DesktopVoiceHostSetEnabledRequest) => {
    assertAllowedCaller(event);
    const enabled = payload?.enabled === true;
    const config = readConfig();
    writeConfig({
      ...config,
      desktopVoiceHostEnabled: enabled,
    });
    await rebuildDesktopVoiceInfrastructure();
    if (!desktopVoiceHostSupervisor) {
      return { enabled: false };
    }
    return await desktopVoiceHostSupervisor.getStatus();
  });

  ipcMain.handle("instafy:desktopSpeechTunnelStatus", async (event) => {
    assertAllowedCaller(event);
    if (!desktopSpeechTunnelSupervisor) {
      return { enabled: false, state: "idle", managed: false, localPort: 8796, readyPath: "/health" };
    }
    return await desktopSpeechTunnelSupervisor.getStatus();
  });

  ipcMain.handle("instafy:desktopSpeechTunnelStart", async (event, payload: DesktopSpeechTunnelStartRequest) => {
    assertAllowedCaller(event);
    if (!desktopSpeechTunnelSupervisor) {
      return { enabled: false, state: "idle", managed: false, localPort: 8796, readyPath: "/health" };
    }
    const options = {
      projectId: typeof payload?.projectId === "string" ? payload.projectId.trim() : "",
      controllerUrl: typeof payload?.controllerUrl === "string" ? payload.controllerUrl.trim() : "",
      controllerAccessToken:
        typeof payload?.controllerAccessToken === "string" ? payload.controllerAccessToken.trim() : "",
      forceRestart: payload?.forceRestart === true,
    };
    if (payload?.waitForReady === false) {
      return desktopSpeechTunnelSupervisor.startInBackground(options);
    }
    return await desktopSpeechTunnelSupervisor.ensureRunning(options);
  });

  ipcMain.handle("instafy:desktopSpeechTunnelStop", async (event) => {
    assertAllowedCaller(event);
    if (!desktopSpeechTunnelSupervisor) {
      return { enabled: false, state: "idle", managed: false, localPort: 8796, readyPath: "/health" };
    }
    await desktopSpeechTunnelSupervisor.stop();
    return await desktopSpeechTunnelSupervisor.getStatus();
  });

  ipcMain.handle(
    "instafy:desktopExtensionInvoke",
    async (event, request: DesktopExtensionInvokeRequest) => {
      assertAllowedCaller(event);
      return await CURRENT_DESKTOP_EXTENSION_REGISTRY.invoke(
        typeof request?.extensionId === "string" ? request.extensionId : "",
        typeof request?.method === "string" ? request.method : "",
        request?.payload,
      );
    },
  );

  ipcMain.handle(
    "instafy:startDesktopRuntime",
    async (event, payload: DesktopRuntimeStartRequest): Promise<DesktopRuntimeStartResponse> => {
      const callerUrl = assertAllowedCaller(event);
      const personalBrowserRendererLease = payload?.enablePersonalBrowser === true
        ? captureStudioRendererGeneration(event)
        : null;
      const launchRuntime = () => serializeDesktopRuntimeMutation(async () => {
        if (personalBrowserRendererLease) {
          assertStudioRendererGenerationCurrent(personalBrowserRendererLease);
        }
        const window = BrowserWindow.fromWebContents(event.sender);

      const requestedProjectId =
        typeof payload?.projectId === "string" ? payload.projectId.trim() : "";
      if (!requestedProjectId) {
        throw new Error("startDesktopRuntime requires projectId.");
      }
      const enablePersonalBrowser = payload?.enablePersonalBrowser === true;
      const personalBrowserOwnerId = enablePersonalBrowser
        ? requirePersonalBrowserOwnerId(payload?.personalBrowserOwnerId)
        : null;
      if (
        personalBrowserOwnerId &&
        !personalBrowserHost?.isOwnedBy(personalBrowserOwnerId)
      ) {
        throw new Error("Personal Browser ownership changed before its desktop runtime started.");
      }
      const personalBrowserCredentials = enablePersonalBrowser
        ? personalBrowserHost?.getControlCredentials(requestedProjectId) ?? null
        : null;
      if (enablePersonalBrowser && !personalBrowserCredentials) {
        throw new Error(
          "Personal Browser must be open for this project before starting its desktop runtime.",
        );
      }
      let personalBrowserRuntimeConnection: Awaited<
        ReturnType<typeof resolvePersonalBrowserRuntimeConnection>
      > | null = null;
      if (enablePersonalBrowser) {
        try {
          personalBrowserRuntimeConnection = await resolvePersonalBrowserRuntimeConnection(
            {
              controllerUrl: payload?.controllerUrl,
              proxyBaseUrl: payload?.proxyBaseUrl,
              ambientProxyBaseUrl: process.env.PROXY_BASE_URL,
            },
            {
              appUrl: getStartUrl(),
              callerUrl,
              packaged: app.isPackaged,
              attestedProfileUserId: personalBrowserProfileUserId,
              resolveCurrentSession: () => resolveVisibleSupabaseSession(event),
            },
          );
          if (personalBrowserRendererLease) {
            assertStudioRendererGenerationCurrent(personalBrowserRendererLease);
          }
        } catch (error) {
          const activeRuntime = desktopRuntime;
          personalBrowserHost?.pauseAgentControl();
          personalBrowserHost?.setRuntimeId(requestedProjectId, null);
          pausedPersonalBrowserRuntime = null;
          if (
            activeRuntime?.personalBrowser &&
            activeRuntime.projectId === requestedProjectId
          ) {
            desktopRuntime = null;
            await activeRuntime.handle.stop().catch(() => undefined);
          }
          throw error;
        }
      }
      if (desktopRuntime) {
        const sameProject = desktopRuntime.projectId === requestedProjectId;
        const samePersonalBrowser = personalBrowserCredentials
          ? desktopRuntime.personalBrowser?.controlUrl === personalBrowserCredentials.controlUrl &&
            desktopRuntime.personalBrowser.token === personalBrowserCredentials.token &&
            desktopRuntime.personalBrowser.projectId === personalBrowserCredentials.projectId
          : !desktopRuntime.personalBrowser;
        if (sameProject && samePersonalBrowser) {
          return {
            pid: desktopRuntime.handle.pid,
            logFilePath: desktopRuntime.logFilePath,
            runtimeId: desktopRuntime.runtimeId,
          };
        }
        // One desktop runtime at a time: switching projects replaces the
        // running runtime instead of silently handing back the wrong one.
        const previous = desktopRuntime;
        desktopRuntime = null;
        revokePersonalBrowserRuntimeBinding(previous);
        if (!previous.personalBrowser && previous.runtimeId) {
          personalBrowserHost?.setRuntimeId(previous.projectId, null);
        }
        await previous.handle.stop().catch(() => {});
      }

      const projectId = requestedProjectId;
      const controllerUrl =
        personalBrowserRuntimeConnection?.controllerUrl ??
        (typeof payload?.controllerUrl === "string" ? payload.controllerUrl.trim() : "");
      const controllerAccessToken =
        personalBrowserRuntimeConnection?.controllerAccessToken ??
        (typeof payload?.controllerAccessToken === "string"
          ? payload.controllerAccessToken.trim()
          : "");

      if (!controllerUrl) {
        throw new Error("startDesktopRuntime requires controllerUrl.");
      }
      if (!controllerAccessToken) {
        throw new Error("startDesktopRuntime requires controllerAccessToken.");
      }

      const config = readConfig();
      const workspaceDir =
        (typeof payload.workspaceDir === "string" && payload.workspaceDir.trim().length > 0
          ? payload.workspaceDir.trim()
          : config.workspaceDir?.trim()) ?? resolveDefaultWorkspaceDir();
      fs.mkdirSync(workspaceDir, { recursive: true });
      const workspaceProjectDir = config.projectWorkspaceDirs?.[projectId]?.trim() || undefined;

      const logFilePath = resolveLogFilePath(projectId);
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true });

      const controllerHost = (() => {
        try {
          return new URL(controllerUrl).hostname;
        } catch {
          return "";
        }
      })();
      const computedProxyOverride =
        controllerHost === "127.0.0.1" ||
        controllerHost === "localhost" ||
        controllerHost === "::1" ||
        controllerHost === ""
          ? "http://127.0.0.1:8789"
          : "";
      const requestedProxy =
        typeof payload.proxyBaseUrl === "string" ? payload.proxyBaseUrl.trim() : "";
      const effectiveProxy =
        personalBrowserRuntimeConnection?.proxyBaseUrl ??
        (enablePersonalBrowser
          ? ""
          : requestedProxy ||
            (typeof process.env.PROXY_BASE_URL === "string"
              ? process.env.PROXY_BASE_URL.trim()
              : "") ||
            computedProxyOverride);

      let runtimeBinaryPath = "";
      if (app.isPackaged) {
        // A packaged runtime can receive the short-lived Personal Browser
        // capability. Never hand that capability to an executable selected by
        // renderer payload, mutable config, or process environment.
        runtimeBinaryPath = await resolveVerifiedBundledRuntimeAgent({
          resourcesPath: process.resourcesPath,
        });
      } else {
        runtimeBinaryPath =
          (typeof payload.runtimeBinaryPath === "string"
            ? payload.runtimeBinaryPath.trim()
            : "") ||
          (config.runtimeBinaryPath?.trim() ?? "") ||
          (typeof process.env.INSTAFY_RUNTIME_AGENT_BIN === "string"
            ? process.env.INSTAFY_RUNTIME_AGENT_BIN.trim()
            : "");
      }

      const displayName =
        (typeof payload.displayName === "string" && payload.displayName.trim().length > 0
          ? payload.displayName.trim()
          : null) ?? os.hostname();
      // An explicit start supersedes any suspended Personal Browser launch.
      pausedPersonalBrowserRuntime = null;

      const startAttempt = async (binaryPathOverride?: string) => {
        const restartOptions: DesktopRuntimeRestartOptions = {
          projectId,
          controllerUrl,
          controllerAccessToken,
          runtimeBinaryPath: binaryPathOverride ?? (runtimeBinaryPath || undefined),
          workspaceDir,
          workspaceProjectDir,
          displayName,
          env: effectiveProxy ? { PROXY_BASE_URL: effectiveProxy } : undefined,
          logging: { logFilePath, teeToStdout: false },
        };
        const handle = await startDesktopRuntime({
          ...restartOptions,
          personalBrowser: personalBrowserCredentials ?? undefined,
        });
        const runtimeId = handle.runtimeId;
        if (!runtimeId) {
          await stopDesktopRuntime(handle).catch(() => undefined);
          throw new Error("Controller did not assign a desktop runtime id.");
        }
        if (personalBrowserCredentials && personalBrowserOwnerId) {
          const currentStatus = personalBrowserHost?.getStatus();
          const currentCredentials = personalBrowserHost?.getControlCredentials(projectId);
          const bindingStillCurrent = Boolean(
            (!personalBrowserRendererLease ||
              studioRendererGenerationIsCurrent(personalBrowserRendererLease)) &&
            personalBrowserHost?.isOwnedBy(personalBrowserOwnerId) &&
              currentStatus?.agentControlEnabled &&
              currentCredentials?.controlUrl === personalBrowserCredentials.controlUrl &&
              currentCredentials?.token === personalBrowserCredentials.token &&
              currentCredentials?.projectId === personalBrowserCredentials.projectId,
          );
          if (!bindingStillCurrent) {
            await stopDesktopRuntime(handle).catch(() => undefined);
            throw new Error(
              "Personal Browser control changed before its desktop runtime finished starting.",
            );
          }
        }
        registerDesktopRuntime(handle, {
          projectId,
          controllerUrl,
          logFilePath,
          runtimeId,
          personalBrowser: personalBrowserCredentials ?? undefined,
          restartOptions,
        });
        return handle;
      };

      try {
        const handle = await startAttempt();
        return { pid: handle.pid, logFilePath, runtimeId: handle.runtimeId };
      } catch (error) {
        let finalError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!app.isPackaged && message.includes("Unable to locate runtime-agent binary")) {
          const selected = await promptForRuntimeBinary(window);
          if (selected) {
            const nextConfig: DesktopAppConfig = { ...config, runtimeBinaryPath: selected };
            writeConfig(nextConfig);
            try {
              const handle = await startAttempt(selected);
              return { pid: handle.pid, logFilePath, runtimeId: handle.runtimeId };
            } catch (selectedError) {
              finalError = selectedError;
            }
          }
        }
        if (personalBrowserCredentials) {
          const currentStatus = personalBrowserHost?.getStatus();
          if (currentStatus?.projectId === projectId) {
            personalBrowserHost?.pauseAgentControl();
            personalBrowserHost?.setRuntimeId(projectId, null);
          }
        }
        throw finalError;
      }
      });
      if (payload?.enablePersonalBrowser === true) {
        return serializePersonalBrowserMutation(launchRuntime);
      }
      return launchRuntime();
    },
  );

  ipcMain.handle("instafy:stopDesktopRuntime", async (event) => {
    assertAllowedCaller(event);
    await serializeDesktopRuntimeMutation(async () => {
      const runtime = desktopRuntime;
      pausedPersonalBrowserRuntime = null;
      if (!runtime) {
        return;
      }
      desktopRuntime = null;
      revokePersonalBrowserRuntimeBinding(runtime);
      if (!runtime.personalBrowser && runtime.runtimeId) {
        personalBrowserHost?.setRuntimeId(runtime.projectId, null);
      }
      await stopDesktopRuntime(runtime.handle).catch(() => undefined);
    });
  });
});

app.on("before-quit", () => {
  stopSmokeParentWatchdog();
  const runtime = desktopRuntime;
  desktopRuntime = null;
  pausedPersonalBrowserRuntime = null;
  if (runtime) {
    void stopDesktopRuntime(runtime.handle).catch(() => undefined);
  }
  const browserHost = personalBrowserHost;
  personalBrowserHost = null;
  if (browserHost) {
    void browserHost.stop().catch(() => undefined);
  }
  const supervisor = desktopVoiceHostSupervisor;
  desktopVoiceHostSupervisor = null;
  if (supervisor) {
    void supervisor.stop().catch(() => undefined);
  }
  const speechTunnelSupervisor = desktopSpeechTunnelSupervisor;
  desktopSpeechTunnelSupervisor = null;
  if (speechTunnelSupervisor) {
    void speechTunnelSupervisor.stop().catch(() => undefined);
  }
  void CURRENT_DESKTOP_EXTENSION_REGISTRY.shutdownAll().catch(() => undefined);
});
