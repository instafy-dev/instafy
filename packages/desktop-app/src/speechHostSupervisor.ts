import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDesktopSpeechLanAdvertiser } from "./speechLanAdvertiser";

export type DesktopVoiceHostServiceState =
  | "stopped"
  | "starting"
  | "running"
  | "external"
  | "error";

export type DesktopVoiceHostServiceStatus = {
  state: DesktopVoiceHostServiceState;
  managed: boolean;
  reachable: boolean;
  pid?: number;
  healthUrl: string;
  scriptPath: string;
  lastCheckedAt?: string;
  lastStartedAt?: string;
  lastError?: string;
  statusCode?: number;
};

export type DesktopVoiceHostBootstrapState = "idle" | "checking" | "installing" | "removing" | "error";

export type DesktopVoiceHostBootstrapStatus = {
  state: DesktopVoiceHostBootstrapState;
  automatic: boolean;
  action?: DesktopVoiceHostBootstrapAction;
  detail?: string;
  lastUpdatedAt?: string;
};

export type DesktopVoiceHostLanStatus = {
  state: "available" | "unavailable";
  bindHost: string;
  healthHost: string;
  port: number;
  healthUrl: string;
  publicHost?: string;
  baseUrl?: string;
  authRequired: boolean;
  authToken?: string;
  tokenHint?: string;
  reason?: string;
};

export type DesktopVoiceHostStatus = {
  enabled: boolean;
  hostMode: "desktop";
  scriptRoot: string;
  providerConfigPath: string;
  speechAuthToken?: string;
  bootstrap: DesktopVoiceHostBootstrapStatus;
  lan: DesktopVoiceHostLanStatus;
  speechService: DesktopVoiceHostServiceStatus;
  providerHost: DesktopVoiceHostServiceStatus;
};

export type DesktopVoiceHostBootstrapAction = "check" | "install_transcription" | "remove_transcription";

export type DesktopVoiceHostDependencyAction = {
  id: string;
  label: string;
  command: string;
  available?: boolean;
  required?: boolean;
  installed?: boolean;
  detail?: string | null;
};

export type DesktopVoiceHostDependencyStatus = {
  supported?: boolean;
  platform?: string;
  arch?: string;
  localService?: {
    command?: string | null;
    scriptPath?: string | null;
    scriptExists?: boolean;
    health?: {
      configured?: boolean;
      reachable?: boolean;
      url?: string | null;
      detail?: string | null;
      statusCode?: number;
      payload?: Record<string, unknown> | null;
    } | null;
  } | null;
  transcription?: {
    configured?: boolean;
    ready?: boolean;
    engine?: string | null;
    model?: string | null;
    deviceId?: string | null;
    installState?: string | null;
    url?: string | null;
  } | null;
  synthesis?: {
    configured?: boolean;
    ready?: boolean;
    engine?: string | null;
    defaultVoice?: string | null;
    installState?: string | null;
    url?: string | null;
  } | null;
  nextSteps?: string[];
  actions?: DesktopVoiceHostDependencyAction[];
};

export type DesktopVoiceHostBootstrapResult = {
  ok: boolean;
  action?: string;
  dryRun?: boolean;
  commandsRun?: string[];
  error?: string;
  status?: DesktopVoiceHostDependencyStatus | null;
  hostStatus: DesktopVoiceHostStatus;
};

type DesktopVoiceHostServiceName = "speechService" | "providerHost";
type DesktopVoiceHostLogLevel = "info" | "warn" | "error";
type FetchImpl = typeof fetch;
type SpawnImpl = typeof spawn;
type TimerHandle = ReturnType<typeof setTimeout>;

type DesktopVoiceHostLogger = (
  level: DesktopVoiceHostLogLevel,
  message: string,
  payload?: Record<string, unknown>,
) => void;

type DesktopVoiceHostServiceOverride = {
  scriptPath?: string;
  healthUrl?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
};

type DesktopVoiceHostSupervisorOptions = {
  enabled?: boolean;
  isPackaged: boolean;
  appPath: string;
  currentDir?: string;
  userDataDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  spawnImpl?: SpawnImpl;
  logger?: DesktopVoiceHostLogger;
  runAsElectronNode?: boolean;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  restartDelayMs?: number;
  serviceOverrides?: Partial<Record<DesktopVoiceHostServiceName, DesktopVoiceHostServiceOverride>>;
  bootstrapImpl?: (options: {
    action: DesktopVoiceHostBootstrapAction;
    dryRun: boolean;
    scriptRoot: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<Omit<DesktopVoiceHostBootstrapResult, "hostStatus">>;
};

type ManagedServiceRecord = {
  name: DesktopVoiceHostServiceName;
  scriptPath: string;
  healthUrl: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  child: ChildProcessWithoutNullStreams | null;
  status: DesktopVoiceHostServiceStatus;
  restartTimer: TimerHandle | null;
};

const DEFAULT_PROVIDER_HOST = "127.0.0.1";
const DEFAULT_PROVIDER_PORT = 8797;
const DEFAULT_START_TIMEOUT_MS = 8_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const DEFAULT_RESTART_DELAY_MS = 1_500;
const AUTO_BOOTSTRAP_INSTALL_STATES = new Set([
  "needs_uv",
  "needs_python",
  "needs_install",
  "missing_ffmpeg",
  "needs_model_cache",
]);

const DESKTOP_PROVIDER_CONFIG = {
  defaultProviderId: "speech",
  providers: [
    {
      type: "speech",
      id: "speech",
      enabled: true,
      title: "Speech",
      description: "Speech provider managed by Instafy Desktop.",
    },
  ],
};

async function withProcessEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (typeof value === "undefined") {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (typeof value === "undefined") {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
  }
}

async function runDesktopVoiceHostBootstrap(options: {
  action: DesktopVoiceHostBootstrapAction;
  dryRun: boolean;
  scriptRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<Omit<DesktopVoiceHostBootstrapResult, "hostStatus">> {
  const scriptPath = path.join(options.scriptRoot, "speech-backend-bootstrap.mjs");
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      action: options.action,
      dryRun: options.dryRun,
      error: `Missing Desktop speech bootstrap script: ${scriptPath}`,
      status: null,
    };
  }
  const scriptUrl = `${pathToFileURL(scriptPath).href}?desktop_bootstrap=${Date.now()}`;
  return await withProcessEnv(options.env, async () => {
    const module = (await import(scriptUrl)) as {
      runSpeechBackendBootstrap?: (input?: {
        action?: DesktopVoiceHostBootstrapAction;
        dryRun?: boolean;
      }) => Promise<Omit<DesktopVoiceHostBootstrapResult, "hostStatus">>;
    };
    if (typeof module.runSpeechBackendBootstrap !== "function") {
      return {
        ok: false,
        action: options.action,
        dryRun: options.dryRun,
        error: `Desktop speech bootstrap module did not export runSpeechBackendBootstrap.`,
        status: null,
      };
    }
    return await module.runSpeechBackendBootstrap({
      action: options.action,
      dryRun: options.dryRun,
    });
  });
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseBooleanOverride(value: unknown) {
  const normalized = normalizeOptionalString(value)?.toLowerCase() ?? null;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isLoopbackHostname(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isPrivateIpv4Address(address: string) {
  if (address.startsWith("10.")) {
    return true;
  }
  if (address.startsWith("192.168.")) {
    return true;
  }
  const secondOctet = Number(address.split(".")[1] ?? "");
  return address.startsWith("172.") && Number.isFinite(secondOctet) && secondOctet >= 16 && secondOctet <= 31;
}

function resolveDesktopLanHost(env: NodeJS.ProcessEnv) {
  const explicit =
    normalizeOptionalString(env.INSTAFY_DESKTOP_LAN_HOST) ??
    normalizeOptionalString(env.LOCAL_SPEECH_PUBLIC_HOST);
  if (explicit && !isLoopbackHostname(explicit) && explicit !== "0.0.0.0") {
    return explicit;
  }

  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries?.length) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.family !== "IPv4" || entry.internal || !normalizeOptionalString(entry.address)) {
        continue;
      }
      candidates.push(entry.address);
    }
  }

  return candidates.find((address) => isPrivateIpv4Address(address)) ?? candidates[0] ?? null;
}

function ensureDesktopLanAuthToken(hostHome: string, env: NodeJS.ProcessEnv) {
  const explicit =
    normalizeOptionalString(env.LOCAL_SPEECH_AUTH_TOKEN) ??
    normalizeOptionalString(env.INSTAFY_DESKTOP_LAN_AUTH_TOKEN);
  if (explicit) {
    return explicit;
  }
  const tokenPath = path.join(hostHome, "auth", "desktop-lan-token.txt");
  const current = fs.existsSync(tokenPath) ? normalizeOptionalString(fs.readFileSync(tokenPath, "utf8")) : null;
  if (current) {
    return current;
  }
  const next = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${next}\n`, "utf8");
  return next;
}

function describeDesktopLanTokenHint(token: string | null) {
  if (!token || token.length < 8) {
    return null;
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function resolveProviderHostConfig(env: NodeJS.ProcessEnv) {
  const host =
    normalizeOptionalString(env.LOCAL_PROVIDER_HOST_HOST) ??
    normalizeOptionalString(env.ROBOT_BRIDGE_HOST) ??
    DEFAULT_PROVIDER_HOST;
  const portCandidate = Number(
    normalizeOptionalString(env.LOCAL_PROVIDER_HOST_PORT) ??
      normalizeOptionalString(env.ROBOT_BRIDGE_PORT) ??
      DEFAULT_PROVIDER_PORT,
  );
  const port = Number.isFinite(portCandidate) && portCandidate > 0 ? portCandidate : DEFAULT_PROVIDER_PORT;
  const baseUrl = `http://${host}:${port}`;
  return {
    host,
    port,
    healthUrl: `${baseUrl}/health`,
  };
}

function describeBootstrapProgress(action: DesktopVoiceHostBootstrapAction, automatic: boolean) {
  const actor = automatic ? "Instafy Desktop" : "Desktop repair";
  if (action === "install_transcription") {
    return `${actor} is installing the managed transcription runtime.`;
  }
  if (action === "remove_transcription") {
    return `${actor} is removing the managed transcription runtime.`;
  }
  return `${actor} is checking the managed transcription runtime.`;
}

function describeBootstrapResultDetail(
  result: Omit<DesktopVoiceHostBootstrapResult, "hostStatus"> | null | undefined,
  action: DesktopVoiceHostBootstrapAction,
  automatic: boolean,
) {
  if (!result) {
    return automatic
      ? "Instafy Desktop could not read the speech bootstrap result."
      : "Desktop repair did not return a speech bootstrap result.";
  }
  if (!result.ok) {
    return normalizeOptionalString(result.error) ?? "Desktop speech bootstrap failed.";
  }
  const nextStep = result.status?.nextSteps?.find((step) => normalizeOptionalString(step));
  if (nextStep) {
    return nextStep;
  }
  if (action === "install_transcription") {
    return automatic
      ? "Instafy Desktop installed the managed transcription runtime."
      : "Desktop repair installed the managed transcription runtime.";
  }
  if (action === "remove_transcription") {
    return automatic
      ? "Instafy Desktop removed the managed transcription runtime."
      : "Desktop repair removed the managed transcription runtime.";
  }
  if (result.status?.transcription?.ready) {
    return automatic
      ? "Instafy Desktop verified the managed transcription runtime."
      : "Desktop repair verified the managed transcription runtime.";
  }
  return automatic
    ? "Instafy Desktop checked the managed transcription runtime."
    : "Desktop repair checked the managed transcription runtime.";
}

function shouldAutoInstallManagedTranscription(status: DesktopVoiceHostDependencyStatus | null | undefined) {
  if (!status || status.transcription?.ready) {
    return false;
  }
  const installState = normalizeOptionalString(status.transcription?.installState);
  return installState ? AUTO_BOOTSTRAP_INSTALL_STATES.has(installState) : false;
}

export function resolveDesktopVoiceHostScriptRoot({
  isPackaged,
  appPath,
  currentDir = __dirname,
}: Pick<DesktopVoiceHostSupervisorOptions, "isPackaged" | "appPath" | "currentDir">) {
  if (isPackaged) {
    return path.join(appPath, "dist", "frontend-scripts");
  }
  return path.resolve(currentDir, "../../frontend/scripts");
}

export function ensureDesktopProviderConfig(userDataDir: string) {
  const configPath = path.join(userDataDir, "desktop-local-provider-host.config.json");
  const nextRaw = `${JSON.stringify(DESKTOP_PROVIDER_CONFIG, null, 2)}\n`;
  const currentRaw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
  if (currentRaw !== nextRaw) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, nextRaw, "utf8");
  }
  return configPath;
}

export function resolveDesktopProviderConfig(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const configuredPath = normalizeOptionalString(env.LOCAL_PROVIDER_HOST_CONFIG);
  if (!configuredPath) {
    return ensureDesktopProviderConfig(userDataDir);
  }
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(
      "LOCAL_PROVIDER_HOST_CONFIG must be an absolute path when supplied to Desktop.",
    );
  }
  let metadata;
  try {
    metadata = fs.lstatSync(configuredPath);
  } catch {
    throw new Error(
      "LOCAL_PROVIDER_HOST_CONFIG must point to an existing regular file.",
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      "LOCAL_PROVIDER_HOST_CONFIG must point to a regular non-symlink file.",
    );
  }
  return configuredPath;
}

async function probeHealth(fetchImpl: FetchImpl, healthUrl: string) {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET",
      headers: {
        "cache-control": "no-store",
      },
    });
    return {
      reachable: response.ok,
      statusCode: response.status,
      checkedAt,
      lastError: response.ok ? null : `Health probe failed (${response.status}).`,
    };
  } catch (error) {
    return {
      reachable: false,
      statusCode: undefined,
      checkedAt,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function attachChildLogging(
  child: ChildProcessWithoutNullStreams,
  serviceName: DesktopVoiceHostServiceName,
  logger: DesktopVoiceHostLogger,
) {
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (!text) {
      return;
    }
    logger("info", `[instafy-desktop] ${serviceName}:stdout`, { text });
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (!text) {
      return;
    }
    logger("warn", `[instafy-desktop] ${serviceName}:stderr`, { text });
  });
}

export class DesktopVoiceHostSupervisor {
  private readonly fetchImpl: FetchImpl;
  private readonly spawnImpl: SpawnImpl;
  private readonly logger: DesktopVoiceHostLogger;
  private readonly runAsElectronNode: boolean;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly restartDelayMs: number;
  private readonly scriptRoot: string;
  private readonly providerConfigPath: string;
  private readonly desiredEnv: NodeJS.ProcessEnv;
  private readonly bootstrapEnv: NodeJS.ProcessEnv;
  private readonly lanStatus: DesktopVoiceHostLanStatus;
  private readonly speechAuthToken: string | null;
  private readonly bootstrapImpl: DesktopVoiceHostSupervisorOptions["bootstrapImpl"];
  private readonly lanAdvertiser: ReturnType<typeof createDesktopSpeechLanAdvertiser>;
  private readonly services: Record<DesktopVoiceHostServiceName, ManagedServiceRecord>;
  private readonly enabled: boolean;
  private ensurePromise: Promise<DesktopVoiceHostStatus> | null = null;
  private restarting = false;
  private shuttingDown = false;
  private autoBootstrapPromise: Promise<void> | null = null;
  private autoBootstrapAttempted = false;
  private bootstrapStatus: DesktopVoiceHostBootstrapStatus = {
    state: "idle",
    automatic: false,
  };

  constructor(options: DesktopVoiceHostSupervisorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.logger =
      options.logger ??
      ((level, message, payload) => {
        const logArgs = payload ? [message, payload] : [message];
        if (level === "error") {
          console.error(...logArgs);
          return;
        }
        if (level === "warn") {
          console.warn(...logArgs);
          return;
        }
        console.log(...logArgs);
      });
    this.runAsElectronNode = options.runAsElectronNode ?? true;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.scriptRoot = resolveDesktopVoiceHostScriptRoot(options);
    this.desiredEnv = { ...process.env, ...(options.env ?? {}) };
    this.providerConfigPath = resolveDesktopProviderConfig(
      options.userDataDir,
      this.desiredEnv,
    );
    this.bootstrapImpl = options.bootstrapImpl ?? runDesktopVoiceHostBootstrap;
    this.enabled =
      (options.enabled ?? true) &&
      !parseBooleanOverride(this.desiredEnv.INSTAFY_DESKTOP_DISABLE_LOCAL_VOICE_HOST);

    const legacySpeechHost = normalizeOptionalString(this.desiredEnv.LOCAL_SPEECH_HOST);
    const detectedLanHost = resolveDesktopLanHost(this.desiredEnv);
    const speechBindHost =
      normalizeOptionalString(this.desiredEnv.LOCAL_SPEECH_BIND_HOST) ??
      legacySpeechHost ??
      (detectedLanHost ? "0.0.0.0" : "127.0.0.1");
    const speechHealthHost =
      normalizeOptionalString(this.desiredEnv.LOCAL_SPEECH_HEALTH_HOST) ??
      (speechBindHost === "0.0.0.0" ? "127.0.0.1" : speechBindHost);
    const speechPublicHost =
      normalizeOptionalString(this.desiredEnv.LOCAL_SPEECH_PUBLIC_HOST) ??
      (legacySpeechHost && legacySpeechHost !== "0.0.0.0" ? legacySpeechHost : null) ??
      detectedLanHost ??
      (speechBindHost === "0.0.0.0" ? speechHealthHost : speechBindHost);
    const speechPortCandidate = Number(
      normalizeOptionalString(this.desiredEnv.LOCAL_SPEECH_PORT) ?? "8796",
    );
    const speechPort = Number.isFinite(speechPortCandidate) && speechPortCandidate > 0 ? speechPortCandidate : 8796;
    const speechHealthUrl = `http://${speechHealthHost}:${speechPort}/health`;
    const providerHost = resolveProviderHostConfig(this.desiredEnv);
    const managedSpeechHome =
      normalizeOptionalString(this.desiredEnv.INSTAFY_SPEECH_HOST_HOME) ??
      path.join(options.userDataDir, "voice-host");
    const lanAuthToken = ensureDesktopLanAuthToken(managedSpeechHome, this.desiredEnv);
    this.speechAuthToken = lanAuthToken;
    this.lanStatus =
      speechPublicHost && !isLoopbackHostname(speechPublicHost) && speechPublicHost !== "0.0.0.0"
        ? {
            state: "available",
            bindHost: speechBindHost,
            healthHost: speechHealthHost,
            publicHost: speechPublicHost,
            port: speechPort,
            baseUrl: `http://${speechPublicHost}:${speechPort}`,
            healthUrl: speechHealthUrl,
            authRequired: true,
            authToken: lanAuthToken,
            tokenHint: describeDesktopLanTokenHint(lanAuthToken) ?? undefined,
          }
        : {
            state: "unavailable",
            bindHost: speechBindHost,
            healthHost: speechHealthHost,
            port: speechPort,
            healthUrl: speechHealthUrl,
            authRequired: false,
            reason: "Instafy Desktop could not detect a LAN address for this machine yet.",
          };
    const sharedManagedEnv: NodeJS.ProcessEnv = {
      ...this.desiredEnv,
      INSTAFY_SPEECH_HOST_MODE: "desktop",
      INSTAFY_SPEECH_HOST_HOME: managedSpeechHome,
      LOCAL_SPEECH_MANAGED_RUNTIME_ONLY: "1",
      LOCAL_SPEECH_HOST: speechPublicHost,
      LOCAL_SPEECH_BIND_HOST: speechBindHost,
      LOCAL_SPEECH_HEALTH_HOST: speechHealthHost,
      LOCAL_SPEECH_PUBLIC_HOST: speechPublicHost,
      LOCAL_SPEECH_AUTH_TOKEN: lanAuthToken,
      LOCAL_SPEECH_PORT: String(speechPort),
      INSTAFY_SPEECH_TRANSCRIPTION_TOKEN: lanAuthToken,
      INSTAFY_SPEECH_SYNTHESIS_TOKEN: lanAuthToken,
      LOCAL_PROVIDER_HOST_HOST: providerHost.host,
      LOCAL_PROVIDER_HOST_PORT: String(providerHost.port),
    };
    this.bootstrapEnv = { ...sharedManagedEnv };

    const speechOverride = options.serviceOverrides?.speechService;
    const providerOverride = options.serviceOverrides?.providerHost;
    this.lanAdvertiser = createDesktopSpeechLanAdvertiser({
      spawnImpl: this.spawnImpl,
      logger: this.logger,
      dnsSdBinary: normalizeOptionalString(this.desiredEnv.INSTAFY_DESKTOP_LAN_ADVERTISER_BIN) ?? undefined,
    });

    this.services = {
      speechService: {
        name: "speechService",
        scriptPath:
          speechOverride?.scriptPath ?? path.join(this.scriptRoot, "local-speech-service.mjs"),
        healthUrl: speechOverride?.healthUrl ?? speechHealthUrl,
        args: speechOverride?.args ?? [],
        env: { ...sharedManagedEnv, ...(speechOverride?.env ?? {}) },
        child: null,
        restartTimer: null,
        status: {
          state: "stopped",
          managed: false,
          reachable: false,
          healthUrl: speechOverride?.healthUrl ?? speechHealthUrl,
          scriptPath:
            speechOverride?.scriptPath ?? path.join(this.scriptRoot, "local-speech-service.mjs"),
          lastError: undefined,
        },
      },
      providerHost: {
        name: "providerHost",
        scriptPath:
          providerOverride?.scriptPath ?? path.join(this.scriptRoot, "local-provider-host.mjs"),
        healthUrl: providerOverride?.healthUrl ?? providerHost.healthUrl,
        args: providerOverride?.args ?? [],
        env: {
          ...sharedManagedEnv,
          LOCAL_PROVIDER_HOST_CONFIG: this.providerConfigPath,
          ...(providerOverride?.env ?? {}),
        },
        child: null,
        restartTimer: null,
        status: {
          state: "stopped",
          managed: false,
          reachable: false,
          healthUrl: providerOverride?.healthUrl ?? providerHost.healthUrl,
          scriptPath:
            providerOverride?.scriptPath ?? path.join(this.scriptRoot, "local-provider-host.mjs"),
          lastError: undefined,
        },
      },
    };
  }

  async getStatus() {
    await this.refreshHealth();
    return this.snapshot();
  }

  peekStatus() {
    return this.snapshot();
  }

  async ensureRunning() {
    if (!this.enabled) {
      return this.snapshot();
    }
    if (this.ensurePromise) {
      return this.ensurePromise;
    }
    this.ensurePromise = this.doEnsureRunning().finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  async restart() {
    this.restarting = true;
    await this.stop();
    this.shuttingDown = false;
    this.restarting = false;
    return this.ensureRunning();
  }

  async bootstrap(action: DesktopVoiceHostBootstrapAction = "check", dryRun = false): Promise<DesktopVoiceHostBootstrapResult> {
    const result = await this.runBootstrapAction(action, dryRun, false);
    const hostStatus = await this.getStatus();
    return {
      ok: result.ok,
      action: result.action ?? action,
      dryRun: result.dryRun ?? dryRun,
      commandsRun: result.commandsRun ?? [],
      error: result.error,
      status: result.status ?? null,
      hostStatus,
    };
  }

  async stop() {
    this.shuttingDown = true;
    for (const service of Object.values(this.services)) {
      if (service.restartTimer) {
        clearTimeout(service.restartTimer);
        service.restartTimer = null;
      }
    }
    await Promise.all(Object.values(this.services).map((service) => this.stopManagedService(service)));
    await this.refreshHealth();
    await this.lanAdvertiser.stop().catch(() => undefined);
  }

  private snapshot(): DesktopVoiceHostStatus {
    return {
      enabled: this.enabled,
      hostMode: "desktop",
      scriptRoot: this.scriptRoot,
      providerConfigPath: this.providerConfigPath,
      speechAuthToken: this.speechAuthToken ?? undefined,
      bootstrap: { ...this.bootstrapStatus },
      lan: { ...this.lanStatus },
      speechService: { ...this.services.speechService.status },
      providerHost: { ...this.services.providerHost.status },
    };
  }

  private async doEnsureRunning() {
    this.shuttingDown = false;
    const speechHealth = await this.refreshServiceHealth(this.services.speechService);
    if (!speechHealth.reachable) {
      await this.maybeAutoBootstrap();
    }
    await this.ensureService(this.services.speechService);
    await this.ensureService(this.services.providerHost);
    await this.refreshHealth();
    await this.syncLanAdvertiser();
    return this.snapshot();
  }

  private async maybeAutoBootstrap() {
    if (this.autoBootstrapAttempted || this.autoBootstrapPromise) {
      return await this.autoBootstrapPromise;
    }
    this.autoBootstrapAttempted = true;
    this.autoBootstrapPromise = (async () => {
      const checkResult = await this.runBootstrapAction("check", false, true);
      if (!shouldAutoInstallManagedTranscription(checkResult.status ?? null)) {
        return;
      }
      const installResult = await this.runBootstrapAction("install_transcription", false, true);
      if (!installResult.ok) {
        this.logger("warn", "[instafy-desktop] automatic voice bootstrap failed", {
          error: installResult.error ?? "unknown",
        });
      }
    })().finally(() => {
      this.autoBootstrapPromise = null;
    });
    return await this.autoBootstrapPromise;
  }

  private async ensureService(service: ManagedServiceRecord) {
    const health = await this.refreshServiceHealth(service);
    if (health.reachable) {
      service.status.state = service.child ? "running" : "external";
      service.status.managed = service.child !== null;
      service.status.lastError = undefined;
      return;
    }

    if (service.child) {
      const becameHealthy = await this.waitForHealthy(service);
      if (becameHealthy) {
        return;
      }
      if (service.child) {
        await this.stopManagedService(service);
      }
    }

    if (!fs.existsSync(service.scriptPath)) {
      service.status.state = "error";
      service.status.lastError = `Missing desktop voice host script: ${service.scriptPath}`;
      this.logger("error", "[instafy-desktop] voice-host script missing", {
        service: service.name,
        scriptPath: service.scriptPath,
      });
      return;
    }

    service.status.state = "starting";
    service.status.managed = true;
    service.status.lastError = undefined;
    service.status.lastStartedAt = new Date().toISOString();

    const env: NodeJS.ProcessEnv = {
      ...service.env,
      ...(this.runAsElectronNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };

    const child = this.spawnImpl(process.execPath, [service.scriptPath, ...service.args], {
      cwd: path.dirname(service.scriptPath),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    service.child = child;
    service.status.pid = child.pid ?? undefined;
    attachChildLogging(child, service.name, this.logger);

    child.once("error", (error) => {
      service.status.state = "error";
      service.status.lastError = error instanceof Error ? error.message : String(error);
      this.logger("error", "[instafy-desktop] voice-host process failed", {
        service: service.name,
        message: service.status.lastError,
      });
    });

    child.once("exit", (code, signal) => {
      if (service.child !== child) {
        return;
      }
      service.child = null;
      service.status.pid = undefined;
      if (this.shuttingDown) {
        service.status.state = "stopped";
        service.status.managed = false;
        return;
      }
      service.status.state = "error";
      service.status.managed = false;
      service.status.lastError = `Exited unexpectedly (${signal ?? code ?? "unknown"}).`;
      this.logger("warn", "[instafy-desktop] voice-host process exited", {
        service: service.name,
        code,
        signal,
      });
      this.scheduleRestart(service);
    });

    const becameHealthy = await this.waitForHealthy(service);
    if (becameHealthy) {
      return;
    }

    await this.refreshServiceHealth(service);
    if (service.status.reachable) {
      service.status.state = service.child ? "running" : "external";
      service.status.lastError = undefined;
      return;
    }

    service.status.state = "error";
    service.status.lastError = service.status.lastError ?? `Timed out waiting for ${service.name} health.`;
    if (service.child) {
      await this.stopManagedService(service);
    }
    this.scheduleRestart(service);
  }

  private async runBootstrapAction(
    action: DesktopVoiceHostBootstrapAction,
    dryRun: boolean,
    automatic: boolean,
  ): Promise<Omit<DesktopVoiceHostBootstrapResult, "hostStatus">> {
    this.updateBootstrapStatus({
      state:
        action === "install_transcription"
          ? "installing"
          : action === "remove_transcription"
            ? "removing"
            : "checking",
      automatic,
      action,
      detail: describeBootstrapProgress(action, automatic),
    });

    const rawResult = await this.bootstrapImpl?.({
      action,
      dryRun,
      scriptRoot: this.scriptRoot,
      env: this.bootstrapEnv,
    });

    const result: Omit<DesktopVoiceHostBootstrapResult, "hostStatus"> = {
      ok: rawResult?.ok === true,
      action: rawResult?.action ?? action,
      dryRun: rawResult?.dryRun ?? dryRun,
      commandsRun: rawResult?.commandsRun ?? [],
      error: rawResult?.error,
      status: rawResult?.status ?? null,
    };

    if (result.ok && !dryRun && action === "install_transcription") {
      try {
        await this.restartManagedServicesAfterBootstrap();
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Desktop could not restart the local voice host after repair.";
        this.updateBootstrapStatus({
          state: "error",
          automatic,
          action,
          detail,
        });
        return {
          ...result,
          ok: false,
          error: detail,
        };
      }
    }

    if (result.ok && !dryRun && action === "remove_transcription") {
      try {
        await this.stop();
        this.shuttingDown = false;
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : "Desktop could not stop the local voice host after removing the runtime.";
        this.updateBootstrapStatus({
          state: "error",
          automatic,
          action,
          detail,
        });
        return {
          ...result,
          ok: false,
          error: detail,
        };
      }
    }

    this.updateBootstrapStatus({
      state: result.ok ? "idle" : "error",
      automatic,
      action,
      detail: describeBootstrapResultDetail(result, action, automatic),
    });
    return result;
  }

  private updateBootstrapStatus(
    next: Pick<DesktopVoiceHostBootstrapStatus, "state" | "automatic"> &
      Partial<Pick<DesktopVoiceHostBootstrapStatus, "action" | "detail">>,
  ) {
    this.bootstrapStatus = {
      state: next.state,
      automatic: next.automatic,
      action: next.action,
      detail: normalizeOptionalString(next.detail) ?? undefined,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  private async restartManagedServicesAfterBootstrap() {
    this.restarting = true;
    try {
      await this.stop();
      this.shuttingDown = false;
      await this.ensureService(this.services.speechService);
      await this.ensureService(this.services.providerHost);
    } finally {
      this.shuttingDown = false;
      this.restarting = false;
    }
  }

  private async waitForHealthy(service: ManagedServiceRecord) {
    const becameHealthy = await waitFor(async () => {
      const result = await this.refreshServiceHealth(service);
      if (result.reachable) {
        service.status.state = service.child ? "running" : "external";
        service.status.managed = service.child !== null;
        service.status.lastError = undefined;
        return true;
      }
      return false;
    }, this.startTimeoutMs);
    return becameHealthy;
  }

  private async refreshHealth() {
    await Promise.all(Object.values(this.services).map((service) => this.refreshServiceHealth(service)));
    await this.syncLanAdvertiser();
  }

  private async syncLanAdvertiser() {
    if (
      !this.enabled ||
      this.lanStatus.state !== "available" ||
      this.services.speechService.status.reachable !== true ||
      this.services.providerHost.status.reachable !== true
    ) {
      await this.lanAdvertiser.stop().catch(() => undefined);
      return;
    }
    await this.lanAdvertiser
      .ensureRunning({
        serviceName:
          normalizeOptionalString(this.desiredEnv.INSTAFY_DESKTOP_LAN_SERVICE_NAME) ??
          `Instafy ${normalizeOptionalString(os.hostname()) ?? "desktop"}`,
        port: this.lanStatus.port,
        tokenHint: this.lanStatus.tokenHint ?? null,
        authRequired: this.lanStatus.authRequired,
      })
      .catch((error) => {
        this.logger("warn", "[instafy-desktop] speech-lan-advertiser failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async refreshServiceHealth(service: ManagedServiceRecord) {
    const result = await probeHealth(this.fetchImpl, service.healthUrl);
    service.status.reachable = result.reachable;
    service.status.statusCode = result.statusCode;
    service.status.lastCheckedAt = result.checkedAt;
    if (result.reachable) {
      service.status.lastError = undefined;
      if (service.child) {
        service.status.state = "running";
        service.status.managed = true;
      } else if (service.status.state !== "starting") {
        service.status.state = "external";
        service.status.managed = false;
      }
    } else if (!service.child && service.status.state !== "starting") {
      service.status.state = service.status.lastError ? "error" : "stopped";
      service.status.managed = false;
      if (result.lastError) {
        service.status.lastError = result.lastError;
      }
    } else if (result.lastError) {
      service.status.lastError = result.lastError;
    }
    return result;
  }

  private scheduleRestart(service: ManagedServiceRecord) {
    if (this.shuttingDown || this.restarting || service.restartTimer) {
      return;
    }
    service.restartTimer = setTimeout(() => {
      service.restartTimer = null;
      if (this.shuttingDown || this.restarting) {
        return;
      }
      void this.ensureService(service);
    }, this.restartDelayMs);
  }

  private async stopManagedService(service: ManagedServiceRecord) {
    const child = service.child;
    service.child = null;
    service.status.pid = undefined;
    service.status.managed = false;
    if (!child) {
      service.status.state = "stopped";
      return;
    }

    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, this.stopTimeoutMs);

      child.once("exit", () => {
        clearTimeout(timeoutId);
        resolve();
      });

      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        return;
      }

      clearTimeout(timeoutId);
      resolve();
    });

    service.status.state = "stopped";
  }
}

export function createDesktopVoiceHostSupervisor(options: DesktopVoiceHostSupervisorOptions) {
  return new DesktopVoiceHostSupervisor(options);
}
