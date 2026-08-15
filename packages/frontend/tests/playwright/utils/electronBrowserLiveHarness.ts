import { _electron as electron, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupElectronBrowserStudio,
  ElectronBrowserCleanupError,
  type ElectronBrowserCleanupConfig,
} from "./electronBrowserLiveCleanup.js";
import {
  checkpointElectronBrowserRecoveryProfileProcess,
  electronBrowserRecoveryOrgName,
  electronBrowserRecoveryOrgSlug,
  electronBrowserRecoveryProjectName,
  ElectronBrowserRecoveryJournalError,
  prepareElectronBrowserRecoveryProfile,
  recoverElectronBrowserLocalProfile,
  reconcileElectronBrowserRecoveryTarget,
} from "./electronBrowserLiveRecovery.js";
import { type AuthSessionSnapshot } from "./harness.js";
import { requireFreshCodexMachineAuth } from "../../../../../scripts/lib/codexMachineAuthExpiry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const DESKTOP_APP_DIR = path.join(REPO_ROOT, "packages", "desktop-app");
const DESKTOP_APP_DIST_MAIN = path.join(DESKTOP_APP_DIR, "dist", "main.js");
const DESKTOP_APP_REQUIRE = createRequire(path.join(DESKTOP_APP_DIR, "package.json"));

type BrowserSupabaseClient = {
  auth?: {
    setSession?: (session: {
      access_token: string;
      refresh_token: string;
    }) => Promise<unknown>;
  };
};

export type ElectronBrowserStudioConfig = ElectronBrowserCleanupConfig & {
  appBaseUrl: string;
  supabaseAnonKey: string;
};

export type ElectronBrowserLiveConfig = ElectronBrowserStudioConfig & {
  defaultCodexAuthJsonPath: string;
};

export type ProvisionedElectronBrowserStudio = {
  orgId: string;
  projectId: string;
  session: AuthSessionSnapshot;
  userId: string;
};

export type ElectronBrowserProvisioningRegistration = {
  orgId: string | null;
  projectId: string | null;
  session: AuthSessionSnapshot | null;
  userId: string | null;
};

export type ElectronBrowserProvisioningCheckpoint = Pick<
  ElectronBrowserProvisioningRegistration,
  "orgId" | "projectId" | "userId"
>;

export type ElectronBrowserProvisioningCheckpointHandler = (
  checkpoint: ElectronBrowserProvisioningCheckpoint,
) => void;

export type ElectronBrowserProvisioningIdentity = {
  disposableEmail: string;
  recoveryMarker: string;
  password: string;
};

export type ElectronStudioLaunch = {
  app: Awaited<ReturnType<typeof electron.launch>>;
  page: Page;
  userDataDir: string;
};

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;

export type ElectronStudioLaunchDependencies = {
  closeTimeoutMs?: number;
  desktopAppBuildExists?: () => boolean;
  executablePath?: string;
  launch?: typeof electron.launch;
  launchEnv?: NodeJS.ProcessEnv;
  recoveryDirectory?: string;
  recoveryMarker?: string;
};

export type CreditLedgerEntrySnapshot = {
  delta: number;
  reason: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type BrowserActionProofEvent = {
  type: string;
  url: string | null;
};

const ELECTRON_CLOSE_TIMEOUT_MS = 15_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ELECTRON_CHILD_ENV_ALLOWLIST = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
]);

function requiredEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Electron Shared Browser live smoke requires ${keys.join(" or ")}.`);
}

function normalizeBaseUrl(value: string, label: string): string {
  const normalized = value.trim().replace(/\/+$/g, "");
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be an http(s) URL.`);
  }
  return normalized;
}

function normalizeResourceId(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!UUID_PATTERN.test(normalized)) {
    throw new ElectronBrowserProvisioningError(`${label} was missing or invalid`);
  }
  return normalized;
}

class ElectronBrowserProvisioningError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ElectronBrowserProvisioningError";
  }
}

function safeProvisioningFailureDetail(error: unknown): string {
  if (error instanceof ElectronBrowserProvisioningError) {
    return error.message;
  }
  return `operation failed (${error instanceof Error ? error.name || "Error" : "unknown error"})`;
}

function safeElectronSetupFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown error";
  }
  const name = error.name || "Error";
  if (!(error instanceof TypeError)) {
    return name;
  }
  const propertyMatch = error.message.match(
    /^Cannot read properties of (?:undefined|null) \(reading '([A-Za-z0-9_$-]{1,64})'\)$/,
  );
  if (propertyMatch?.[1]) {
    return `${name}:reading-${propertyMatch[1]}`;
  }
  if (/\binvalid url\b/i.test(error.message)) {
    return `${name}:invalid-url`;
  }
  if (/\bmust be of type\b/i.test(error.message)) {
    return `${name}:invalid-argument`;
  }
  if (/\bis not a function\b/i.test(error.message)) {
    return `${name}:not-a-function`;
  }
  return `${name}:unclassified`;
}

export function createElectronBrowserProvisioningRegistration(): ElectronBrowserProvisioningRegistration {
  return {
    orgId: null,
    projectId: null,
    session: null,
    userId: null,
  };
}

export function createElectronBrowserProvisioningIdentity(): ElectronBrowserProvisioningIdentity {
  const recoveryMarker = randomUUID();
  return {
    disposableEmail: `electron-shared-browser-${recoveryMarker}@instafy.dev`,
    recoveryMarker,
    password: `Browser-${recoveryMarker}-Aa1!`,
  };
}

function checkpointElectronBrowserProvisioning(
  registration: ElectronBrowserProvisioningRegistration,
  onCheckpoint?: ElectronBrowserProvisioningCheckpointHandler,
): void {
  onCheckpoint?.({
    orgId: registration.orgId,
    projectId: registration.projectId,
    userId: registration.userId,
  });
}

export function buildElectronStudioChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (
      value !== undefined &&
      (ELECTRON_CHILD_ENV_ALLOWLIST.has(key) || key.startsWith("LC_"))
    ) {
      childEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  return childEnv;
}

export async function closeElectronApplication(
  app: ElectronApplication,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Electron close timed out")),
          timeoutMs,
        );
      }),
    ]);
    return;
  } catch {
    const child = app.process();
    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    if (!alreadyExited) {
      let signalSent = false;
      try {
        signalSent = child.kill("SIGKILL");
      } catch {
        signalSent = false;
      }
      if (!signalSent) {
        throw new Error("Electron forced termination failed");
      }
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function resolveElectronBrowserLiveCleanupConfig(): ElectronBrowserCleanupConfig {
  const controllerUrl = normalizeBaseUrl(
    process.env.PLAYWRIGHT_CONTROLLER_URL?.trim() ||
      process.env.VITE_CONTROLLER_URL?.trim() ||
      "https://controller.instafy.dev",
    "Electron Shared Browser controller URL",
  );
  return {
    controllerUrl,
    supabaseUrl: normalizeBaseUrl(
      requiredEnv("VITE_SUPABASE_URL", "SUPABASE_URL"),
      "Supabase URL",
    ),
    supabaseServiceRoleKey: requiredEnv(
      "SUPABASE_SERVICE_ROLE_KEY",
      "SERVICE_ROLE_KEY",
    ),
  };
}

export function resolveElectronBrowserStudioConfig(
  cleanupConfig: ElectronBrowserCleanupConfig =
    resolveElectronBrowserLiveCleanupConfig(),
): ElectronBrowserStudioConfig {
  const supabaseServiceRoleKey = cleanupConfig.supabaseServiceRoleKey.trim();
  if (!supabaseServiceRoleKey) {
    throw new Error("Electron Shared Browser Supabase service role key is required.");
  }
  return {
    appBaseUrl: normalizeBaseUrl(
      process.env.PLAYWRIGHT_ELECTRON_SHARED_BROWSER_BASE_URL?.trim() ||
        process.env.PLAYWRIGHT_EXTERNAL_BASE_URL?.trim() ||
        process.env.PLAYWRIGHT_BASE_URL?.trim() ||
        "https://prod.instafy.dev",
      "Electron Shared Browser app URL",
    ),
    controllerUrl: normalizeBaseUrl(
      cleanupConfig.controllerUrl,
      "Electron Shared Browser controller URL",
    ),
    supabaseAnonKey: requiredEnv("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey,
    supabaseUrl: normalizeBaseUrl(cleanupConfig.supabaseUrl, "Supabase URL"),
  };
}

export function resolveElectronBrowserLiveConfig(
  cleanupConfig: ElectronBrowserCleanupConfig =
    resolveElectronBrowserLiveCleanupConfig(),
): ElectronBrowserLiveConfig {
  if (process.platform === "win32") {
    throw new Error(
      "Electron Shared Browser live smoke currently requires macOS or Linux for verified orphan-process recovery.",
    );
  }
  const studioConfig = resolveElectronBrowserStudioConfig(cleanupConfig);
  const defaultCodexAuthJsonPath = path.join(os.homedir(), ".codex", "auth.json");

  const packagedExecutablePath =
    process.env.PLAYWRIGHT_ELECTRON_PACKAGED_EXECUTABLE_PATH?.trim() || null;
  const desktopLaunchPath = packagedExecutablePath ?? DESKTOP_APP_DIST_MAIN;
  const launchStats = fs.lstatSync(desktopLaunchPath, { throwIfNoEntry: false });
  if (!launchStats?.isFile() || launchStats.isSymbolicLink()) {
    throw new Error(
      packagedExecutablePath
        ? "Electron Browser live smoke requires a regular, non-symlink packaged executable."
        : "Electron Browser live smoke requires a built desktop app. " +
            "Run pnpm --filter @instafy/desktop-app build.",
    );
  }
  if (packagedExecutablePath && !path.isAbsolute(packagedExecutablePath)) {
    throw new Error(
      "PLAYWRIGHT_ELECTRON_PACKAGED_EXECUTABLE_PATH must be an absolute path.",
    );
  }
  if (!fs.existsSync(defaultCodexAuthJsonPath)) {
    throw new Error(
      "Electron Shared Browser live smoke requires the current machine's ~/.codex/auth.json.",
    );
  }
  requireFreshCodexMachineAuth({ authPath: defaultCodexAuthJsonPath });

  return {
    ...studioConfig,
    defaultCodexAuthJsonPath,
  };
}

export async function provisionElectronBrowserStudio(
  request: APIRequestContext,
  config: ElectronBrowserStudioConfig,
  registration: ElectronBrowserProvisioningRegistration =
    createElectronBrowserProvisioningRegistration(),
  onCheckpoint?: ElectronBrowserProvisioningCheckpointHandler,
  identity: ElectronBrowserProvisioningIdentity =
    createElectronBrowserProvisioningIdentity(),
): Promise<ProvisionedElectronBrowserStudio> {
  const { disposableEmail, password, recoveryMarker } = identity;
  let userCreateAttempted = false;
  let orgCreateAttempted = false;
  let projectCreateAttempted = false;
  const adminHeaders = {
    apikey: config.supabaseServiceRoleKey,
    authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    "content-type": "application/json",
  };
  try {
    userCreateAttempted = true;
    const createUserResponse = await request.post(
      `${config.supabaseUrl}/auth/v1/admin/users`,
      {
        headers: adminHeaders,
        data: {
          email: disposableEmail,
          password,
          email_confirm: true,
          user_metadata: {
            e2e: "electron-shared-browser-agent-turn",
            electronSharedBrowserRecoveryMarker: recoveryMarker,
          },
        },
      },
    );
    if (!createUserResponse.ok()) {
      // Identify WHICH credential and host actually failed without exposing
      // key material: the gateway's error body plus a shape fingerprint
      // (prefix + length) distinguishes a stale legacy JWT ("eyJ…", ~200
      // chars) from a current secret key ("sb_secret_…", ~41 chars) — the
      // difference three release canaries died without reporting.
      const body = (await createUserResponse.text().catch(() => "")).slice(0, 300);
      const key = config.supabaseServiceRoleKey;
      throw new ElectronBrowserProvisioningError(
        `Supabase user creation returned HTTP ${createUserResponse.status()} ` +
          `(host ${new URL(config.supabaseUrl).hostname}, ` +
          `service key ${key.slice(0, 10)}… ${key.length} chars): ${body}`,
      );
    }
    const userPayload = (await createUserResponse.json()) as { id?: unknown };
    const userId = normalizeResourceId(userPayload.id, "Supabase user id");
    registration.userId = userId;
    checkpointElectronBrowserProvisioning(registration, onCheckpoint);

    const tokenResponse = await request.post(
      `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        headers: {
          apikey: config.supabaseAnonKey,
          "content-type": "application/json",
        },
        data: { email: disposableEmail, password },
      },
    );
    if (!tokenResponse.ok()) {
      throw new ElectronBrowserProvisioningError(
        `Supabase login returned HTTP ${tokenResponse.status()}`,
      );
    }
    const tokenPayload = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!tokenPayload.access_token || !tokenPayload.refresh_token) {
      throw new ElectronBrowserProvisioningError(
        "Supabase login returned an incomplete session",
      );
    }
    const session: AuthSessionSnapshot = {
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token,
      userId,
    };
    registration.session = session;

    orgCreateAttempted = true;
    const orgResponse = await request.post(`${config.controllerUrl}/orgs`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "content-type": "application/json",
      },
      data: {
        orgName: electronBrowserRecoveryOrgName(recoveryMarker),
        orgSlug: electronBrowserRecoveryOrgSlug(recoveryMarker),
        ownerUserId: userId,
      },
    });
    if (!orgResponse.ok()) {
      throw new ElectronBrowserProvisioningError(
        `Controller organization creation returned HTTP ${orgResponse.status()}`,
      );
    }
    const orgPayload = (await orgResponse.json()) as { orgId?: unknown };
    const orgId = normalizeResourceId(orgPayload.orgId, "Controller organization id");
    registration.orgId = orgId;
    checkpointElectronBrowserProvisioning(registration, onCheckpoint);

    projectCreateAttempted = true;
    const projectResponse = await request.post(
      `${config.controllerUrl}/orgs/${encodeURIComponent(orgId)}/projects`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        data: {
          ownerUserId: userId,
          projectName: electronBrowserRecoveryProjectName(recoveryMarker),
          projectType: "customer",
        },
      },
    );
    if (!projectResponse.ok()) {
      throw new ElectronBrowserProvisioningError(
        `Controller project creation returned HTTP ${projectResponse.status()}`,
      );
    }
    const projectPayload = (await projectResponse.json()) as { projectId?: unknown };
    const projectId = normalizeResourceId(projectPayload.projectId, "Controller project id");
    registration.projectId = projectId;
    checkpointElectronBrowserProvisioning(registration, onCheckpoint);

    return {
      orgId,
      projectId,
      session,
      userId,
    };
  } catch (error) {
    const provisioningFailure = safeProvisioningFailureDetail(error);
    const uncertainCreate =
      (userCreateAttempted && !registration.userId) ||
      (orgCreateAttempted && !registration.orgId) ||
      (projectCreateAttempted && !registration.projectId);
    if (uncertainCreate) {
      try {
        const reconciled = await reconcileElectronBrowserRecoveryTarget(
          request,
          config,
          identity,
          registration,
        );
        registration.userId = reconciled.userId;
        registration.orgId = reconciled.orgId;
        registration.projectId = reconciled.projectId;
        checkpointElectronBrowserProvisioning(registration, onCheckpoint);
      } catch (reconciliationError) {
        const reconciliationFailure =
          reconciliationError instanceof ElectronBrowserRecoveryJournalError
            ? reconciliationError.message
            : `resource reconciliation failed (${reconciliationError instanceof Error ? reconciliationError.name : "unknown error"})`;
        throw new Error(
          `Disposable Studio provisioning failed: ${provisioningFailure}. ${reconciliationFailure} Cleanup was not attempted because resource ownership could not be proven.`,
        );
      }
    }
    let rollbackFailure: string | null = null;
    if (registration.userId || registration.orgId || registration.projectId) {
      try {
        await cleanupElectronBrowserStudio(request, config, registration);
      } catch (cleanupError) {
        rollbackFailure =
          cleanupError instanceof ElectronBrowserCleanupError
            ? cleanupError.message
            : `partial cleanup failed (${cleanupError instanceof Error ? cleanupError.name : "unknown error"})`;
      }
    }
    throw new Error(
      rollbackFailure
        ? `Disposable Studio provisioning failed: ${provisioningFailure}.\n${rollbackFailure}`
        : `Disposable Studio provisioning failed: ${provisioningFailure}. Partial cleanup was verified.`,
    );
  }
}

export async function launchElectronStudio(
  config: ElectronBrowserStudioConfig,
  projectId: string,
  dependencies: ElectronStudioLaunchDependencies = {},
): Promise<ElectronStudioLaunch> {
  const packagedExecutablePath = dependencies.executablePath?.trim() || null;
  const desktopAppBuildExists =
    dependencies.desktopAppBuildExists ??
    (() => {
      const launchPath = packagedExecutablePath ?? DESKTOP_APP_DIST_MAIN;
      const stats = fs.lstatSync(launchPath, { throwIfNoEntry: false });
      return Boolean(stats?.isFile() && !stats.isSymbolicLink());
    });
  if (!desktopAppBuildExists()) {
    throw new Error(
      packagedExecutablePath
        ? "Electron Browser live smoke requires a regular, non-symlink packaged executable."
        : "Electron Browser live smoke requires a built desktop app. " +
            "Run pnpm --filter @instafy/desktop-app build.",
    );
  }
  if (packagedExecutablePath && !path.isAbsolute(packagedExecutablePath)) {
    throw new Error("The packaged Electron executable path must be absolute.");
  }
  const recoveryMarker = dependencies.recoveryMarker?.trim() || null;
  const userDataDir = recoveryMarker
    ? prepareElectronBrowserRecoveryProfile(
        recoveryMarker,
        dependencies.recoveryDirectory,
      )
    : fs.mkdtempSync(
        path.join(os.tmpdir(), "instafy-electron-shared-browser-"),
      );
  const desktopStartUrl = new URL("/studio", config.appBaseUrl);
  desktopStartUrl.searchParams.set("projectId", projectId);
  // A Personal Browser canary must never let the packaged local runtime fall
  // back to the signed-in runner's real ~/.instafy/workspace. The entire
  // workspace and runtime log now live under the disposable recovery profile.
  const disposableWorkspaceDir = path.join(userDataDir, "workspace");
  fs.mkdirSync(disposableWorkspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "desktop-config.json"),
    `${JSON.stringify({ workspaceDir: disposableWorkspaceDir }, null, 2)}\n`,
    { mode: 0o600 },
  );
  let app: ElectronApplication | null = null;
  try {
    const recoveryArgs = recoveryMarker
      ? [
          "--allow-multiple-instances",
          `--instafy-smoke-recovery-marker=${recoveryMarker}`,
        ]
      : [];
    const launchOptions = {
      executablePath:
        packagedExecutablePath ?? String(DESKTOP_APP_REQUIRE("electron")),
      args: packagedExecutablePath
        ? recoveryArgs
        : [DESKTOP_APP_DIR, ...recoveryArgs],
      cwd: packagedExecutablePath
        ? path.dirname(packagedExecutablePath)
        : REPO_ROOT,
      env: buildElectronStudioChildEnv(process.env, {
        ...dependencies.launchEnv,
        INSTAFY_APP_URL: desktopStartUrl.toString(),
        INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
        INSTAFY_DESKTOP_DISABLE_LOCAL_VOICE_HOST: "1",
        INSTAFY_DESKTOP_USER_DATA_DIR: userDataDir,
        ...(recoveryMarker
          ? {
              INSTAFY_DESKTOP_SMOKE_PARENT_PID: String(process.pid),
              INSTAFY_DESKTOP_SMOKE_RECOVERY_ROOT: path.dirname(
                path.dirname(userDataDir),
              ),
              INSTAFY_DESKTOP_SMOKE_RECOVERY_MARKER: recoveryMarker,
            }
          : {}),
      }),
    };
    // Playwright's Electron launcher reads private state from its receiver.
    // Calling an extracted `electron.launch` function loses that receiver and
    // fails before Electron starts (`this._playwright` is undefined).
    app = dependencies.launch
      ? await dependencies.launch(launchOptions)
      : await electron.launch(launchOptions);
    if (recoveryMarker) {
      const electronPid = app.process().pid;
      if (!electronPid) {
        throw new Error("Electron process id is unavailable for recovery.");
      }
      checkpointElectronBrowserRecoveryProfileProcess(
        recoveryMarker,
        electronPid,
        dependencies.recoveryDirectory,
      );
    }
    return { app, page: await app.firstWindow(), userDataDir };
  } catch (error) {
    let cleanupFailure: string | null = null;
    if (app) {
      try {
        await closeElectronApplication(
          app,
          dependencies.closeTimeoutMs ?? ELECTRON_CLOSE_TIMEOUT_MS,
        );
      } catch (closeError) {
        cleanupFailure = `app termination failed (${closeError instanceof Error ? closeError.name : "unknown error"})`;
      }
    }
    if (recoveryMarker) {
      try {
        await recoverElectronBrowserLocalProfile(recoveryMarker, {
          recoveryDirectory: dependencies.recoveryDirectory,
        });
      } catch (profileError) {
        // Preserve the verified owner marker and profile when the Electron
        // process may still be alive. The next run can recover it after this
        // parent exits; deleting it here would destroy that proof.
        cleanupFailure ??=
          `profile recovery deferred (${profileError instanceof Error ? profileError.name : "unknown error"})`;
      }
    } else {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch (profileError) {
        cleanupFailure ??=
          `profile cleanup failed (${profileError instanceof Error ? profileError.name : "unknown error"})`;
      }
    }
    const launchFailure = `Electron Studio setup failed (${safeElectronSetupFailureDetail(error)})`;
    throw new Error(
      cleanupFailure ? `${launchFailure}; ${cleanupFailure}.` : `${launchFailure}; cleanup completed.`,
    );
  }
}

export async function restoreSessionIntoElectronStudio(
  page: Page,
  config: ElectronBrowserStudioConfig,
  session: AuthSessionSnapshot,
  projectId: string,
): Promise<void> {
  await page.goto(`${config.appBaseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_SUPABASE__?: BrowserSupabaseClient;
        instafyDesktop?: {
          codexAuthJsonStatus?: unknown;
          connectDefaultCodexAuthJson?: unknown;
        };
      };
      return (
        typeof runtimeWindow.__INSTAFY_SUPABASE__?.auth?.setSession === "function" &&
        typeof runtimeWindow.instafyDesktop?.codexAuthJsonStatus === "function" &&
        typeof runtimeWindow.instafyDesktop?.connectDefaultCodexAuthJson === "function"
      );
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(async ({ accessToken, refreshToken }) => {
    const client = (window as typeof window & {
      __INSTAFY_SUPABASE__?: BrowserSupabaseClient;
    }).__INSTAFY_SUPABASE__;
    if (!client?.auth?.setSession) {
      throw new Error("Supabase client is unavailable in Electron.");
    }
    await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  }, session);

  const studioUrl = new URL("/studio", config.appBaseUrl);
  studioUrl.searchParams.set("projectId", projectId);
  await page.goto(studioUrl.toString(), { waitUntil: "domcontentloaded" });
}

export async function fetchCreditLedger(
  request: APIRequestContext,
  config: ElectronBrowserLiveConfig,
  session: AuthSessionSnapshot,
  projectId: string,
): Promise<CreditLedgerEntrySnapshot[]> {
  let response;
  try {
    response = await request.get(
      `${config.controllerUrl}/credits/ledger?projectId=${encodeURIComponent(projectId)}&limit=100`,
      {
        headers: { authorization: `Bearer ${session.accessToken}` },
      },
    );
  } catch (error) {
    // Playwright transport errors may include a request call log. Keep bearer
    // tokens out of terminal output and retained CI logs.
    throw new Error(
      `Unable to load credit ledger (${error instanceof Error ? error.name : "unknown error"}).`,
    );
  }
  if (!response.ok()) {
    throw new Error(`Unable to load credit ledger (${response.status()}).`);
  }
  const payload = (await response.json()) as {
    entries?: Array<Record<string, unknown>>;
  };
  return (payload.entries ?? []).map((entry) => ({
    delta: typeof entry.delta === "number" ? entry.delta : 0,
    reason: typeof entry.reason === "string" ? entry.reason : "",
    metadata:
      entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
        ? (entry.metadata as Record<string, unknown>)
        : null,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
  }));
}

export async function fetchRunMetadata(
  request: APIRequestContext,
  config: ElectronBrowserLiveConfig,
  session: AuthSessionSnapshot,
  runId: string,
): Promise<Record<string, unknown> | null> {
  let response;
  try {
    response = await request.get(
      `${config.controllerUrl}/runs?runId=${encodeURIComponent(runId)}&limit=1`,
      {
        headers: { authorization: `Bearer ${session.accessToken}` },
      },
    );
  } catch (error) {
    throw new Error(
      `Unable to load run metadata (${error instanceof Error ? error.name : "unknown error"}).`,
    );
  }
  if (!response.ok()) {
    return null;
  }
  const payload = (await response.json()) as Array<{
    metadata?: unknown;
  }>;
  const metadata = payload[0]?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

export async function remoteSurfaceHasRenderedFrame(surface: Locator): Promise<boolean> {
  return surface.evaluate((element) => {
    if (
      !(element instanceof HTMLCanvasElement) &&
      !(element instanceof HTMLVideoElement)
    ) {
      return false;
    }
    const sourceWidth =
      element instanceof HTMLVideoElement ? element.videoWidth : element.width;
    const sourceHeight =
      element instanceof HTMLVideoElement ? element.videoHeight : element.height;
    if (sourceWidth < 2 || sourceHeight < 2) {
      return false;
    }
    if (
      element instanceof HTMLVideoElement &&
      element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return false;
    }
    const sample = document.createElement("canvas");
    sample.width = 64;
    sample.height = 40;
    const context = sample.getContext("2d", { alpha: false });
    if (!context) {
      return false;
    }
    try {
      // Electron/Chromium may otherwise use a nearest-neighbour path for this
      // extreme downscale. Sparse pages (for example, Example Domain) then
      // retain only a handful of dark pixels and look falsely uniform to the
      // proof heuristic even though the full canvas is correct.
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(element, 0, 0, sample.width, sample.height);
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      let minimum = 255;
      let maximum = 0;
      let total = 0;
      let totalSquared = 0;
      let nonBlackPixels = 0;
      const luminances: number[] = [];
      for (let index = 0; index < pixels.length; index += 4) {
        const luminance =
          pixels[index] * 0.2126 +
          pixels[index + 1] * 0.7152 +
          pixels[index + 2] * 0.0722;
        luminances.push(luminance);
        minimum = Math.min(minimum, luminance);
        maximum = Math.max(maximum, luminance);
        total += luminance;
        totalSquared += luminance * luminance;
        if (luminance >= 12) {
          nonBlackPixels += 1;
        }
      }
      const sampleCount = luminances.length;
      const average = total / sampleCount;
      const variance = Math.max(0, totalSquared / sampleCount - average * average);
      const deviatingPixels = luminances.filter(
        (luminance) => Math.abs(luminance - average) >= 6,
      ).length;

      // A newly mounted canvas and a failed screencast both commonly present as
      // a uniform black frame. Likewise, a cleared white frame is not proof of
      // page rendering. Require real spatial detail, not merely a non-white
      // average, before the production smoke advances.
      return (
        maximum - minimum >= 12 &&
        Math.sqrt(variance) >= 2 &&
        deviatingPixels >= Math.max(4, Math.ceil(sampleCount * 0.005)) &&
        nonBlackPixels >= Math.ceil(sampleCount * 0.35)
      );
    } catch {
      return false;
    }
  });
}

export type RemoteSurfaceScreenshotPaint = {
  averageLuminance: number;
  brightPixelRatio: number;
  darkPixelRatio: number;
  luminanceRange: number;
};

/**
 * Inspect the pixels produced by Chromium's compositor, rather than the
 * canvas backing store. Electron can retain valid canvas pixels while
 * presenting a mostly-black composited surface, which is still a real user
 * failure and must not pass the desktop proof.
 */
export async function remoteSurfaceScreenshotPaint(
  surface: Locator,
  screenshot?: Buffer,
): Promise<RemoteSurfaceScreenshotPaint> {
  const png =
    screenshot ?? (await surface.screenshot({ animations: "disabled" }));
  return surface.evaluate(async (_element, base64) => {
    const response = await fetch(`data:image/png;base64,${base64}`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const sample = document.createElement("canvas");
      sample.width = 64;
      sample.height = 48;
      const context = sample.getContext("2d", { alpha: false });
      if (!context) {
        throw new Error("Screenshot paint analysis requires a 2D canvas context.");
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, sample.width, sample.height);
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      let minimum = 255;
      let maximum = 0;
      let total = 0;
      let bright = 0;
      let dark = 0;
      const sampleCount = pixels.length / 4;
      for (let index = 0; index < pixels.length; index += 4) {
        const luminance =
          pixels[index] * 0.2126 +
          pixels[index + 1] * 0.7152 +
          pixels[index + 2] * 0.0722;
        minimum = Math.min(minimum, luminance);
        maximum = Math.max(maximum, luminance);
        total += luminance;
        if (luminance >= 160) {
          bright += 1;
        }
        if (luminance <= 12) {
          dark += 1;
        }
      }
      return {
        averageLuminance: total / sampleCount,
        brightPixelRatio: bright / sampleCount,
        darkPixelRatio: dark / sampleCount,
        luminanceRange: maximum - minimum,
      };
    } finally {
      bitmap.close();
    }
  }, png.toString("base64"));
}

export function browserActionsShowClickThenNavigationToHost(
  actions: readonly BrowserActionProofEvent[],
  expectedHostname: string,
): boolean {
  const normalizedHostname = expectedHostname
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!normalizedHostname) {
    return false;
  }

  let clickSeen = false;
  for (const action of actions) {
    if (action.type === "click") {
      clickSeen = true;
      continue;
    }
    if (!clickSeen || action.type !== "nav_result" || !action.url) {
      continue;
    }
    try {
      const destination = new URL(action.url);
      const hostname = destination.hostname.toLowerCase();
      if (
        (destination.protocol === "https:" || destination.protocol === "http:") &&
        (hostname === normalizedHostname || hostname.endsWith(`.${normalizedHostname}`))
      ) {
        return true;
      }
    } catch {
      // Ignore malformed telemetry and keep looking for a later valid result.
    }
  }
  return false;
}
