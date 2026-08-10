import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureRatholeBinary } from "./rathole.js";
export { ensureRatholeBinary } from "./rathole.js";
export { startSpeechTunnel, type DesktopSpeechTunnelHandle, type StartSpeechTunnelOptions } from "./speechTunnel.js";
import {
  startLocalWorkspacePresence,
  type LocalWorkspacePresenceHandle,
} from "./localWorkspacePresence.js";
export { resolveDeviceId, startLocalWorkspacePresence } from "./localWorkspacePresence.js";

export interface StartDesktopRuntimeOptions {
  projectId: string;
  /**
   * Stable controller runtime id allocated by the desktop app. Supplying it
   * lets Studio target this exact runtime for device-local capabilities.
   */
  runtimeId?: string;
  controllerUrl?: string;
  controllerJwksUrl?: string;
  controllerAccessToken?: string;
  agentLoginKey?: string;
  runtimeBinaryPath?: string;
  workspaceDir?: string;
  /**
   * Explicit folder for this project's working copy (bring-your-own-folder).
   * When set, the runtime works directly in this folder instead of
   * `<workspaceDir>/<projectId>`.
   */
  workspaceProjectDir?: string;
  env?: Record<string, string | undefined>;
  displayName?: string;
  /**
   * Electron-only ownership contract. When true, the parent kills the complete
   * process tree and dispositions the controller runtime after that proof.
   * CLI callers must leave this false so the child handles Ctrl+C itself.
   */
  parentDispositionsRuntimeOnShutdown?: boolean;
  /**
   * Short-lived capability for the Personal Browser hosted by the desktop
   * app. These values are deliberately not discovered from process.env or the
   * generic env bag: only the Electron host may opt a runtime into controlling
   * its local browser.
   */
  personalBrowser?: DesktopPersonalBrowserControl;
  rathole?: {
    version?: string;
    cacheDir?: string;
    logger?: (message: string) => void;
  };
  origin?: {
    originId?: string;
    bindHost?: string;
    bindPort?: number;
    skipAuth?: boolean;
    internalToken?: string;
    internalTokenProvider?: () => Promise<string>;
    ratholeBin?: string;
    ratholeStateDir?: string;
  };
  logging?: {
    logFilePath?: string;
    teeToStdout?: boolean;
  };
}

export interface DesktopPersonalBrowserControl {
  controlUrl: string;
  token: string;
  projectId?: string;
}

export interface DesktopRuntimeHandle {
  pid: number;
  runtimeId?: string;
  process: ChildProcess;
  /**
   * Rotate the user credential used only for controller-side workspace
   * presence. The child runtime continues using its controller-minted scoped
   * token, so this does not interrupt active work.
   */
  updateControllerAccessToken: (accessToken: string) => void;
  stop: () => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const PERSONAL_BROWSER_CONTROL_ENV_KEYS = [
  "INSTAFY_PERSONAL_BROWSER_CONTROL_URL",
  "INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN",
  "INSTAFY_PERSONAL_BROWSER_PROJECT_ID",
] as const;
export const DESKTOP_RUNTIME_PARENT_DISPOSITION_ENV =
  "INSTAFY_RUNTIME_PARENT_DISPOSITION";
// Must remain below the controller's expired-drain recovery proof window.
// Electron-owned runtimes cannot inherit or override this safety cadence.
export const DESKTOP_PARENT_DISPOSITION_HEARTBEAT_SECONDS = 60;

export function desktopRuntimeUsesParentDisposition(
  options: Pick<StartDesktopRuntimeOptions, "parentDispositionsRuntimeOnShutdown">,
): boolean {
  return options.parentDispositionsRuntimeOnShutdown === true;
}

export function createRetryableDesktopRuntimeStop(
  operation: () => Promise<void>,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) {
      return inFlight;
    }
    const attempt = operation();
    const retryable = attempt.catch((error) => {
      if (inFlight === retryable) {
        inFlight = null;
      }
      throw error;
    });
    inFlight = retryable;
    return retryable;
  };
}

export async function runDesktopRuntimeExitFinalizer<T>(
  exited: Promise<T>,
  finalizer: () => Promise<void>,
): Promise<void> {
  try {
    await exited;
  } catch {
    // ChildProcess `error` rejects events.once(..., "exit"), but presence and
    // other runtime-scoped resources still require the same finalization.
  }
  await finalizer();
}

function normalizeOptionalUuid(value: string | undefined, field: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!UUID_REGEX.test(trimmed)) {
    throw new Error(`${field} must be a valid UUID`);
  }
  return trimmed.toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function buildPersonalBrowserRuntimeEnv(options: {
  projectId: string;
  personalBrowser?: DesktopPersonalBrowserControl;
}): Partial<Record<(typeof PERSONAL_BROWSER_CONTROL_ENV_KEYS)[number], string>> {
  if (!options.personalBrowser) {
    return {};
  }

  const controlUrlRaw = options.personalBrowser.controlUrl.trim();
  const token = options.personalBrowser.token.trim();
  if (!controlUrlRaw) {
    throw new Error("personalBrowser.controlUrl is required");
  }
  if (!token) {
    throw new Error("personalBrowser.token is required");
  }

  let controlUrl: URL;
  try {
    controlUrl = new URL(controlUrlRaw);
  } catch {
    throw new Error("personalBrowser.controlUrl must be a valid URL");
  }
  if (
    !["http:", "https:"].includes(controlUrl.protocol) ||
    !isLoopbackHostname(controlUrl.hostname) ||
    controlUrl.username ||
    controlUrl.password ||
    controlUrl.search ||
    controlUrl.hash
  ) {
    throw new Error(
      "personalBrowser.controlUrl must be an HTTP(S) loopback URL without credentials, query, or fragment",
    );
  }

  const runtimeProjectId = normalizeOptionalUuid(options.projectId, "projectId");
  const projectId = normalizeOptionalUuid(
    options.personalBrowser.projectId ?? options.projectId,
    "personalBrowser.projectId",
  );
  if (!runtimeProjectId || !projectId || projectId !== runtimeProjectId) {
    throw new Error("personalBrowser.projectId must match the desktop runtime projectId");
  }

  return {
    INSTAFY_PERSONAL_BROWSER_CONTROL_URL: controlUrl.toString().replace(/\/$/, ""),
    INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN: token,
    INSTAFY_PERSONAL_BROWSER_PROJECT_ID: projectId,
  };
}

export function applyProtectedDesktopRuntimeEnv(
  env: NodeJS.ProcessEnv,
  options: {
    projectId: string;
    runtimeId?: string;
    runtimeBinaryPath?: string;
    personalBrowser?: DesktopPersonalBrowserControl;
    parentDispositionsRuntimeOnShutdown?: boolean;
  },
): NodeJS.ProcessEnv {
  delete env.RUNTIME_ID;
  delete env.INSTAFY_RUNTIME_AGENT_BIN;
  delete env[DESKTOP_RUNTIME_PARENT_DISPOSITION_ENV];
  for (const key of PERSONAL_BROWSER_CONTROL_ENV_KEYS) {
    delete env[key];
  }

  const runtimeId = normalizeOptionalUuid(options.runtimeId, "runtimeId");
  if (runtimeId) {
    env.RUNTIME_ID = runtimeId;
  }
  const runtimeBinaryPath = options.runtimeBinaryPath?.trim();
  if (runtimeBinaryPath) {
    env.INSTAFY_RUNTIME_AGENT_BIN = runtimeBinaryPath;
  }
  // Electron owns the complete process tree and is the only actor that can
  // prove descendants are dead. The child must not requeue its lease on
  // SIGINT before that proof exists.
  if (desktopRuntimeUsesParentDisposition(options)) {
    env[DESKTOP_RUNTIME_PARENT_DISPOSITION_ENV] = "1";
    env.RUNTIME_HEARTBEAT_SECONDS = String(
      DESKTOP_PARENT_DISPOSITION_HEARTBEAT_SECONDS,
    );
  }
  Object.assign(
    env,
    buildPersonalBrowserRuntimeEnv({
      projectId: options.projectId,
      personalBrowser: options.personalBrowser,
    }),
  );
  return env;
}

export function buildRuntimeTokenRequestBody(
  subject: string,
  runtimeId?: string,
  personalBrowser = false,
): {
  subject: string;
  runtimeId: string | null;
  leaseId: null;
  scopes: null;
  personalBrowser?: true;
} {
  return {
    subject,
    runtimeId: runtimeId ?? null,
    leaseId: null,
    scopes: null,
    ...(personalBrowser ? { personalBrowser: true as const } : {}),
  };
}

function runtimeIdFromScopedToken(token: string): string | undefined {
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) {
    return undefined;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const value =
      typeof payload.runtime_id === "string"
        ? payload.runtime_id
        : typeof payload.runtimeId === "string"
          ? payload.runtimeId
          : undefined;
    return normalizeOptionalUuid(value, "runtime token runtimeId");
  } catch {
    return undefined;
  }
}

export function resolveAuthoritativeRuntimeId(
  requestedRuntimeId: string | undefined,
  tokenRuntimeId: string | undefined,
): string | undefined {
  const requested = normalizeOptionalUuid(requestedRuntimeId, "runtimeId");
  const signed = normalizeOptionalUuid(tokenRuntimeId, "runtime token runtimeId");
  if (requested && signed && requested !== signed) {
    throw new Error("Controller runtime token identity does not match the requested runtimeId");
  }
  return signed ?? requested;
}

function resolveRuntimeBinary(explicit?: string): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    process.env.INSTAFY_RUNTIME_AGENT_BIN,
    path.resolve(moduleDir, "../../runtime-agent/target/debug/runtime-agent"),
    path.resolve(moduleDir, "../../runtime-agent/target/release/runtime-agent"),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const absolute = path.resolve(candidate);
    if (fs.existsSync(absolute)) {
      return absolute;
    }
  }

  throw new Error(
    "Unable to locate runtime-agent binary. Provide --runtime-binary or set INSTAFY_RUNTIME_AGENT_BIN.",
  );
}

function ensureWorkspace(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

const NON_PROJECT_WORKSPACE_ENTRIES = new Set([
  ".DS_Store",
  ".instafy",
  "Thumbs.db",
]);

const DEFAULT_PROJECT_WORKSPACE_CONTENT_WAIT_MS = 120_000;
const DEFAULT_PROJECT_WORKSPACE_CONTENT_POLL_MS = 1_000;
const DESKTOP_RUNTIME_SIGINT_GRACE_MS = 5_000;
const DESKTOP_RUNTIME_SIGTERM_GRACE_MS = 2_000;
const DESKTOP_RUNTIME_SIGKILL_GRACE_MS = 2_000;
const DESKTOP_RUNTIME_PRESENCE_STOP_GRACE_MS = 1_000;

export type DesktopRuntimeChildStopTarget = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal: NodeJS.Signals) => boolean;
};

type DesktopRuntimeChildStopOptions = {
  sigintGraceMs?: number;
  sigtermGraceMs?: number;
  sigkillGraceMs?: number;
  /** The real runtime owns a process group so Codex descendants cannot survive it. */
  killProcessTree?: boolean;
  platform?: NodeJS.Platform;
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  isProcessGroupAlive?: (pid: number) => boolean;
  terminateWindowsProcessTree?: (pid: number) => Promise<void>;
};

export function resolveWindowsTaskkillPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configuredRoot = environment.SystemRoot?.trim() || environment.windir?.trim();
  const windowsRoot = configuredRoot && path.win32.isAbsolute(configuredRoot)
    ? configuredRoot
    : "C:\\Windows";
  return path.win32.join(windowsRoot, "System32", "taskkill.exe");
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const taskkill = spawn(resolveWindowsTaskkillPath(), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    timeout = setTimeout(() => {
      try {
        taskkill.kill("SIGKILL");
      } catch {
        // The command may have exited while its timeout fired.
      }
      finish(new Error("taskkill timed out while terminating the desktop runtime tree"));
    }, DESKTOP_RUNTIME_SIGKILL_GRACE_MS);
    timeout.unref();
    taskkill.once("error", (error) => finish(error));
    taskkill.once("exit", (code) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`taskkill exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function promiseSettlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function childExitsWithin(
  child: DesktopRuntimeChildStopTarget,
  exited: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve(value);
    };
    const poll = setInterval(() => {
      if (hasExited()) {
        finish(true);
      }
    }, Math.min(25, Math.max(1, timeoutMs)));
    const timeout = setTimeout(() => finish(hasExited()), timeoutMs);
    poll.unref();
    timeout.unref();
    // ChildProcess `error` rejects events.once(..., "exit"). Ignore that
    // rejection and keep polling the authoritative process state for the full
    // grace period instead of escalating all signals back-to-back.
    void exited.then(
      () => {
        if (hasExited()) {
          finish(true);
        }
      },
      () => undefined,
    );
  });
}

function unixProcessGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

async function processGroupExitsWithin(
  pid: number,
  exited: Promise<unknown>,
  timeoutMs: number,
  isProcessGroupAlive: (pid: number) => boolean,
): Promise<boolean> {
  if (!isProcessGroupAlive(pid)) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve(value);
    };
    const poll = setInterval(() => {
      if (!isProcessGroupAlive(pid)) {
        finish(true);
      }
    }, Math.min(25, Math.max(1, timeoutMs)));
    const timeout = setTimeout(() => finish(!isProcessGroupAlive(pid)), timeoutMs);
    poll.unref();
    timeout.unref();
    // Root exit is only a hint. A descendant can keep the process group alive,
    // so never resolve until the independent group probe says it is gone.
    void exited.then(
      () => {
        if (!isProcessGroupAlive(pid)) {
          finish(true);
        }
      },
      () => undefined,
    );
  });
}

export async function stopDesktopRuntimeChildWithEscalation(
  child: DesktopRuntimeChildStopTarget,
  exited: Promise<unknown>,
  options: DesktopRuntimeChildStopOptions = {},
): Promise<void> {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  const platform = options.platform ?? process.platform;
  const pid = child.pid;
  const unixProcessTree = Boolean(
    options.killProcessTree && platform !== "win32" && pid && pid > 0,
  );
  const isProcessGroupAlive = options.isProcessGroupAlive ?? unixProcessGroupIsAlive;
  const targetHasExited = () =>
    unixProcessTree && pid ? !isProcessGroupAlive(pid) : hasExited();
  const targetExitsWithin = (timeoutMs: number) =>
    unixProcessTree && pid
      ? processGroupExitsWithin(pid, exited, timeoutMs, isProcessGroupAlive)
      : childExitsWithin(child, exited, timeoutMs);

  if (options.killProcessTree && platform === "win32" && pid && pid > 0) {
    if (hasExited()) {
      // Electron-owned Windows runtimes install themselves into a fail-closed
      // KILL_ON_JOB_CLOSE Job Object before they can spawn model processes.
      // Root exit therefore proves that every descendant has been terminated.
      return;
    }
    await (options.terminateWindowsProcessTree ?? terminateWindowsProcessTree)(pid);
    if (!(await childExitsWithin(
      child,
      exited,
      options.sigkillGraceMs ?? DESKTOP_RUNTIME_SIGKILL_GRACE_MS,
    ))) {
      throw new Error(`Desktop runtime ${pid} did not exit after terminating its process tree.`);
    }
    return;
  }

  const signal = (value: NodeJS.Signals) => {
    if (targetHasExited()) {
      return;
    }
    try {
      if (options.killProcessTree && pid && pid > 0) {
        (options.signalProcessGroup ?? ((groupPid, groupSignal) => {
          process.kill(-groupPid, groupSignal);
        }))(pid, value);
        return;
      }
      child.kill(value);
    } catch {
      // A just-exited process group can disappear before the child exit state
      // updates. Fall back to the direct child signal; the bounded wait below
      // remains authoritative.
      try {
        child.kill(value);
      } catch {
        // The exit event may be racing this signal.
      }
    }
  };

  if (targetHasExited()) {
    return;
  }
  signal("SIGINT");
  if (await targetExitsWithin(options.sigintGraceMs ?? DESKTOP_RUNTIME_SIGINT_GRACE_MS)) {
    return;
  }
  signal("SIGTERM");
  if (await targetExitsWithin(options.sigtermGraceMs ?? DESKTOP_RUNTIME_SIGTERM_GRACE_MS)) {
    return;
  }
  signal("SIGKILL");
  if (!(await targetExitsWithin(options.sigkillGraceMs ?? DESKTOP_RUNTIME_SIGKILL_GRACE_MS))) {
    throw new Error(`Desktop runtime ${child.pid ?? "process"} did not exit after SIGKILL.`);
  }
}

export function hasProjectWorkspaceContent(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((entry) => !NON_PROJECT_WORKSPACE_ENTRIES.has(entry.name));
  } catch {
    return false;
  }
}

export function shouldEnableProjectOrigin(options: {
  projectWorkspaceHasContent: boolean;
  gitRemoteUrl: string | null;
}): boolean {
  return options.projectWorkspaceHasContent || Boolean(options.gitRemoteUrl);
}

export async function waitForProjectWorkspaceContent(
  dir: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROJECT_WORKSPACE_CONTENT_WAIT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_PROJECT_WORKSPACE_CONTENT_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (hasProjectWorkspaceContent(dir)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return hasProjectWorkspaceContent(dir);
}

export async function startDesktopRuntime(
  options: StartDesktopRuntimeOptions,
): Promise<DesktopRuntimeHandle> {
  if (!options.projectId || !UUID_REGEX.test(options.projectId)) {
    throw new Error("startDesktopRuntime requires a valid space ID (UUID format)");
  }
  const requestedRuntimeId = normalizeOptionalUuid(options.runtimeId, "runtimeId");

  const runtimeBinary = resolveRuntimeBinary(options.runtimeBinaryPath);
  const workspaceDir = path.resolve(
    options.workspaceDir ?? path.join(process.cwd(), ".instafy", "workspace"),
  );
  ensureWorkspace(workspaceDir);
  const workspaceProjectDir = options.workspaceProjectDir
    ? path.resolve(options.workspaceProjectDir)
    : null;
  if (workspaceProjectDir) {
    ensureWorkspace(workspaceProjectDir);
  }
  const projectWorkspacePath =
    workspaceProjectDir ?? path.join(workspaceDir, options.projectId);
  const projectWorkspaceHasContent = hasProjectWorkspaceContent(projectWorkspacePath);
  const runtimeDisplayName =
    options.displayName ??
    process.env.RUNTIME_DISPLAY_NAME ??
    "Instafy Desktop Runtime";

  const controllerUrl =
    options.controllerUrl ?? process.env.CONTROLLER_BASE_URL ?? "http://127.0.0.1:8788";
  await ensureControllerReachable(controllerUrl);
  const controllerAccessToken =
    options.controllerAccessToken ??
    process.env.CONTROLLER_ACCESS_TOKEN ??
    options.env?.CONTROLLER_ACCESS_TOKEN;

  const runtimeTokenResult = await resolveRuntimeAccessToken({
    explicitToken: options.origin?.internalToken ?? process.env.ORIGIN_INTERNAL_TOKEN,
    tokenProvider: options.origin?.internalTokenProvider,
    controllerAccessToken,
    controllerUrl,
    projectId: options.projectId,
    displayName: runtimeDisplayName,
    runtimeId: requestedRuntimeId,
    personalBrowser: Boolean(options.personalBrowser),
  });
  const runtimeId = resolveAuthoritativeRuntimeId(
    requestedRuntimeId,
    runtimeTokenResult.runtimeId ?? undefined,
  );
  if (!runtimeId) {
    throw new Error(
      "Runtime token response is missing the controller-assigned runtimeId.",
    );
  }
  const requestedOriginId = normalizeOptionalUuid(
    options.origin?.originId,
    "origin.originId",
  );
  if (requestedOriginId && requestedOriginId !== runtimeId) {
    throw new Error(
      "A private desktop originId must match its controller-assigned runtimeId.",
    );
  }
  const originId = requestedOriginId ?? runtimeId;
  const bindHost = options.origin?.bindHost ?? "127.0.0.1";
  const bindPort = options.origin?.bindPort ?? 54332;
  const originInternalToken = runtimeTokenResult.token;
  // Wire the canonical git remote so the desktop working copy syncs with
  // Instafy storage like hosted runtimes do. Explicit env always wins; the
  // controller only advertises a remote it considers reachable from outside
  // the cluster (GIT_REMOTE_PUBLIC_BASE_URL).
  const gitRemoteUrl =
    options.env?.ORIGIN_GIT_REMOTE_URL ??
    process.env.ORIGIN_GIT_REMOTE_URL ??
    runtimeTokenResult.gitRemoteUrl ??
    null;
  const projectOriginEnabled = shouldEnableProjectOrigin({
    projectWorkspaceHasContent,
    gitRemoteUrl,
  });

  const explicitRatholeBin =
    options.origin?.ratholeBin ?? options.env?.RATHOLE_BIN ?? process.env.RATHOLE_BIN;
  let ratholeBin =
    explicitRatholeBin && explicitRatholeBin.trim().length > 0
      ? path.resolve(explicitRatholeBin)
      : null;
  if (ratholeBin && !fs.existsSync(ratholeBin)) {
    throw new Error(
      `rathole binary not found at ${ratholeBin}. Set RATHOLE_BIN or install rathole on PATH.`,
    );
  }
  if (!ratholeBin) {
    const fromPath = findRatholeOnPath();
    if (fromPath) {
      ratholeBin = fromPath;
    }
  }
  if (!ratholeBin) {
    ratholeBin = await ensureRatholeBinary({
      version: options.rathole?.version,
      cacheDir: options.rathole?.cacheDir,
      logger:
        options.rathole?.logger ?? ((message) => console.log(`[instafy-desktop] ${message}`)),
    });
  }

  const baseEnv: Record<string, string> = {
    CONTROLLER_BASE_URL: controllerUrl,
    CONTROLLER_JWKS_URL:
      options.controllerJwksUrl ??
      process.env.CONTROLLER_JWKS_URL ??
      `${controllerUrl.replace(/\/$/, "")}/.well-known/jwks.json`,
    SPACE_ID: options.projectId,
    AGENT_LOGIN_KEY:
      options.agentLoginKey ?? process.env.AGENT_LOGIN_KEY ?? "instafy-desktop-development",
    WORKSPACE_DIR: workspaceDir,
    RUNTIME_TYPE: "codex-desktop",
    RUNTIME_PROVIDER: process.env.RUNTIME_PROVIDER ?? "self-hosted",
    RUNTIME_VERSION: process.env.RUNTIME_VERSION ?? "desktop-agent-dev",
    RUNTIME_DISPLAY_NAME:
      runtimeDisplayName,
    ORIGIN_ID: originId,
    ORIGIN_ENABLED: projectOriginEnabled ? "1" : "0",
    ORIGIN_BIND_HOST: bindHost,
    ORIGIN_BIND_PORT: String(bindPort),
    ORIGIN_SKIP_AUTH: (options.origin?.skipAuth ?? false) ? "1" : "0",
    ORIGIN_PROTOCOLS: "http",
    ORIGIN_INTERNAL_TOKEN: originInternalToken,
    RUNTIME_ACCESS_TOKEN: originInternalToken,
    RUNTIME_HEARTBEAT_SECONDS: process.env.RUNTIME_HEARTBEAT_SECONDS ?? "60",
    RUNTIME_POLL_INTERVAL_MS: process.env.RUNTIME_POLL_INTERVAL_MS ?? "2000",
    RUNTIME_LEASE_SECONDS: process.env.RUNTIME_LEASE_SECONDS ?? "300",
    RUNTIME_STRICT_MODE: process.env.RUNTIME_STRICT_MODE ?? "0",
    RUNTIME_DEV_ISOLATION: process.env.RUNTIME_DEV_ISOLATION ?? "0",
  };

  if (workspaceProjectDir) {
    baseEnv.WORKSPACE_PROJECT_DIR = workspaceProjectDir;
  }

  if (!projectWorkspaceHasContent) {
    console.warn(
      gitRemoteUrl
        ? `[instafy-desktop] project workspace ${projectWorkspacePath} has no project files yet; waiting for git hydration before announcing local copy`
        : `[instafy-desktop] project workspace ${projectWorkspacePath} has no project files yet; starting runtime without local file origin`,
    );
  }

  if (gitRemoteUrl) {
    baseEnv.ORIGIN_GIT_REMOTE_URL = gitRemoteUrl;
  }

  if (ratholeBin) {
    baseEnv.RATHOLE_BIN = ratholeBin;
  }
  const explicitRatholeState =
    options.origin?.ratholeStateDir ?? process.env.RATHOLE_STATE_DIR;
  const defaultRatholeState = path.join(workspaceDir, ".instafy", "rathole");
  const resolvedRatholeState =
    explicitRatholeState && explicitRatholeState.trim().length > 0
      ? path.resolve(explicitRatholeState)
      : defaultRatholeState;
  fs.mkdirSync(resolvedRatholeState, { recursive: true });
  baseEnv.RATHOLE_STATE_DIR = resolvedRatholeState;

  const childEnv = {
    ...process.env,
    ...baseEnv,
    ...(options.env ?? {}),
  } as NodeJS.ProcessEnv;
  // Runtime identity and device-local capabilities must never be inherited
  // from a parent shell or passed through the generic env bag. They are
  // granted explicitly by Electron for the active project.
  applyProtectedDesktopRuntimeEnv(
    childEnv,
    {
      projectId: options.projectId,
      runtimeId,
      runtimeBinaryPath: runtimeBinary,
      personalBrowser: options.personalBrowser,
      parentDispositionsRuntimeOnShutdown:
        desktopRuntimeUsesParentDisposition(options),
    },
  );

  const logFilePath =
    options.logging?.logFilePath && options.logging.logFilePath.trim().length > 0
      ? path.resolve(options.logging.logFilePath)
      : null;
  if (logFilePath) {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  }

  const captureLogs = Boolean(logFilePath);
  const child = spawn(runtimeBinary, {
    env: childEnv,
    // On Unix this creates a dedicated process group. Shutdown can therefore
    // terminate both the Rust runtime and any local Codex descendants without
    // risking orphaned work being requeued while it is still executing.
    detached:
      desktopRuntimeUsesParentDisposition(options) &&
      process.platform !== "win32",
    stdio: captureLogs ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (captureLogs) {
    const teeStdout = options.logging?.teeToStdout !== false;
    const logStream = fs.createWriteStream(logFilePath!, { flags: "a" });
    let closed = false;
    const closeLog = () => {
      if (closed) {
        return;
      }
      closed = true;
      logStream.end();
    };
    child.on("exit", closeLog);
    child.on("error", closeLog);
    const forwardChunk = (chunk: Buffer, destination: NodeJS.WritableStream | null) => {
      if (destination) {
        destination.write(chunk);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      if (teeStdout) {
        forwardChunk(chunk, process.stdout);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      if (teeStdout) {
        forwardChunk(chunk, process.stderr);
      }
    });
  }

  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));

  // Announce this machine's working copy so Studio surfaces (Connections,
  // runtime menu) can show where the project's files live. Failures are
  // non-fatal: the runtime works without presence, and the controller
  // TTL-prunes stale entries on its own.
  let presence: LocalWorkspacePresenceHandle | null = null;
  let stopPresenceRegistration = false;
  let presenceToken = controllerAccessToken?.trim() || originInternalToken;
  const registerPresence = async () => {
    if (stopPresenceRegistration || presence || !presenceToken) {
      return;
    }
    if (!hasProjectWorkspaceContent(projectWorkspacePath)) {
      return;
    }
    try {
      const registrationToken = presenceToken;
      const handle = await startLocalWorkspacePresence({
        controllerUrl,
        projectId: options.projectId,
        accessToken: registrationToken,
        workspacePath: projectWorkspacePath,
        log: (message) => console.log(`[instafy-desktop] ${message}`),
      });
      if (stopPresenceRegistration) {
        // stop()/child exit happened during the registration round trip;
        // don't leak a heartbeat for a runtime that is already gone.
        await handle.stop().catch(() => {});
        return;
      }
      // A deferred registration can overlap a renderer-driven session
      // refresh. Move the newly created heartbeat handle to the latest token
      // before publishing it as the active presence registration.
      if (registrationToken !== presenceToken) {
        handle.updateAccessToken(presenceToken);
      }
      presence = handle;
    } catch (error) {
      console.warn(
        `[instafy-desktop] local workspace presence registration failed: ${String(error)}`,
      );
    }
  };
  if (presenceToken && projectWorkspaceHasContent) {
    await registerPresence();
  } else if (presenceToken && gitRemoteUrl) {
    // Watch until the working copy hydrates — however long the clone takes,
    // and even when the remote starts empty and files only appear after the
    // first agent write. The watcher dies with the runtime, so there is no
    // arbitrary deadline after which presence silently never registers.
    void (async () => {
      let intervalMs = DEFAULT_PROJECT_WORKSPACE_CONTENT_POLL_MS;
      while (!stopPresenceRegistration && !presence && child.exitCode === null) {
        if (hasProjectWorkspaceContent(projectWorkspacePath)) {
          await registerPresence();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        intervalMs = Math.min(intervalMs * 2, 15_000);
      }
    })();
  }
  void runDesktopRuntimeExitFinalizer(exited, async () => {
    stopPresenceRegistration = true;
    const presenceStop = presence?.stop().catch(() => {}) ?? Promise.resolve();
    presence = null;
    await promiseSettlesWithin(presenceStop, DESKTOP_RUNTIME_PRESENCE_STOP_GRACE_MS);
  }).catch((error) => {
    console.warn(`[instafy-desktop] runtime exit finalization failed: ${String(error)}`);
  });

  const stop = createRetryableDesktopRuntimeStop(async () => {
      stopPresenceRegistration = true;
      const presenceStop = presence?.stop().catch(() => {}) ?? Promise.resolve();
      presence = null;
      await stopDesktopRuntimeChildWithEscalation(child, exited, {
        killProcessTree: desktopRuntimeUsesParentDisposition(options),
      });
      await promiseSettlesWithin(presenceStop, DESKTOP_RUNTIME_PRESENCE_STOP_GRACE_MS);
  });

  return {
    pid: child.pid ?? -1,
    runtimeId,
    process: child,
    updateControllerAccessToken(accessToken: string) {
      const nextAccessToken = accessToken.trim();
      if (!nextAccessToken) {
        throw new Error("Desktop runtime controller access is unavailable.");
      }
      presenceToken = nextAccessToken;
      presence?.updateAccessToken(nextAccessToken);
    },
    stop,
    exited,
  };
}

export async function stopDesktopRuntime(handle: DesktopRuntimeHandle): Promise<void> {
  await handle.stop();
}

async function ensureControllerReachable(baseUrl: string) {
  const url = baseUrl.replace(/\/$/, "");
  const healthEndpoints = ["/healthz", "/health", "/status", "/version"];
  const timeout = 3_000;

  for (const endpoint of healthEndpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(`${url}${endpoint}`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        return;
      }
    } catch {
      // ignore and try next endpoint
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      return;
    }
  } catch {
    // final fallback fails -> throw below
  }

  throw new Error(
    `Unable to reach controller at ${url}. Ensure it is running and accessible from this machine.`,
  );
}

interface OriginTokenResolutionOptions {
  explicitToken?: string | null;
  tokenProvider?: (() => Promise<string | undefined>) | undefined;
  controllerAccessToken?: string | undefined;
  controllerUrl: string;
  projectId: string;
  displayName: string;
  runtimeId?: string;
  personalBrowser: boolean;
}

interface RuntimeTokenResult {
  token: string;
  gitRemoteUrl: string | null;
  runtimeId: string | null;
}

async function resolveRuntimeAccessToken(
  options: OriginTokenResolutionOptions,
): Promise<RuntimeTokenResult> {
  if (options.tokenProvider) {
    const provided = (await options.tokenProvider())?.trim();
    if (provided) {
      return {
        token: provided,
        gitRemoteUrl: null,
        runtimeId: runtimeIdFromScopedToken(provided) ?? null,
      };
    }
  }

  const direct = options.explicitToken?.trim();
  if (direct) {
    return {
      token: direct,
      gitRemoteUrl: null,
      runtimeId: runtimeIdFromScopedToken(direct) ?? null,
    };
  }

  const controllerToken = options.controllerAccessToken?.trim();
  if (controllerToken) {
    return fetchRuntimeAccessToken({
      controllerUrl: options.controllerUrl,
      projectId: options.projectId,
      controllerAccessToken: controllerToken,
      issuedFor: options.displayName,
      runtimeId: options.runtimeId,
      personalBrowser: options.personalBrowser,
    });
  }

  throw new Error(
    "Unable to resolve runtime access token. Provide --origin-token, set RUNTIME_ACCESS_TOKEN/ORIGIN_INTERNAL_TOKEN, or configure a controller access token.",
  );
}

async function fetchRuntimeAccessToken(options: {
  controllerUrl: string;
  projectId: string;
  controllerAccessToken: string;
  issuedFor: string;
  runtimeId?: string;
  personalBrowser: boolean;
}): Promise<RuntimeTokenResult> {
  const base = options.controllerUrl.replace(/\/$/, "");
  const target = `${base}/projects/${encodeURIComponent(options.projectId)}/runtime/token`;
  const response = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.controllerAccessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      buildRuntimeTokenRequestBody(
        options.issuedFor,
        options.runtimeId,
        options.personalBrowser,
      ),
    ),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Controller rejected runtime token request (${response.status} ${response.statusText}): ${text}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!token) {
    throw new Error("Controller response missing token field.");
  }
  const gitRemoteUrl =
    typeof payload.gitRemoteUrl === "string" && payload.gitRemoteUrl.trim().length > 0
      ? payload.gitRemoteUrl.trim()
      : null;
  const runtimeIdRaw =
    typeof payload.runtimeId === "string"
      ? payload.runtimeId
      : typeof payload.runtime_id === "string"
        ? payload.runtime_id
        : undefined;
  const runtimeId = normalizeOptionalUuid(
    runtimeIdRaw,
    "controller runtime token response runtimeId",
  );
  if (!runtimeId) {
    throw new Error("Controller response missing runtimeId field.");
  }
  const signedRuntimeId = runtimeIdFromScopedToken(token);
  if (!signedRuntimeId) {
    throw new Error("Controller runtime token is missing its signed runtimeId claim.");
  }
  if (signedRuntimeId !== runtimeId) {
    throw new Error(
      "Controller runtime token identity does not match its response runtimeId.",
    );
  }
  return { token, gitRemoteUrl, runtimeId: signedRuntimeId };
}

function findRatholeOnPath(): string | null {
  const searchNames =
    process.platform === "win32"
      ? ["rathole.exe", "rathole"]
      : ["rathole"];
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of pathEntries) {
    for (const name of searchNames) {
      const candidate = path.join(entry, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
