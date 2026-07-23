import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import kleur from "kleur";
import { findProjectManifest, resolveRatholeBinaryForCli, type ProjectManifest } from "./runtime.js";
import {
  resolveConfiguredControllerUrl,
  resolveControllerUrl as resolveDefaultControllerUrl,
  resolveUserAccessTokenWithSource,
  type AccessTokenSource,
} from "./config.js";
import { formatAuthRejectedError, formatAuthRequiredError } from "./errors.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";

type TunnelResponse = {
  tunnelId: string;
  hostname: string;
  url?: string;
  credentials?: Record<string, unknown>;
};

type TunnelCliOptions = {
  project?: string;
  controllerUrl?: string;
  controllerToken?: string;
  name?: string;
  rotate?: boolean;
  port?: number;
  cwd?: string;
  ratholeBin?: string;
};

export type TunnelStartOptions = TunnelCliOptions & {
  detach?: boolean;
  logFile?: string;
  json?: boolean;
};

export type TunnelListOptions = {
  json?: boolean;
  all?: boolean;
};

export type TunnelStopOptions = TunnelCliOptions & {
  tunnelId?: string;
  json?: boolean;
};

export type TunnelLogsOptions = {
  tunnelId?: string;
  lines?: number;
  follow?: boolean;
  json?: boolean;
};

type TunnelStateEntry = {
  tunnelId: string;
  projectId: string;
  hostname: string;
  url: string;
  localPort: number;
  controllerUrl: string;
  pid: number;
  logFile: string;
  workdir: string;
  startedAt: string;
};

type TunnelStateFile = {
  version: 1;
  tunnels: TunnelStateEntry[];
};

const INSTAFY_DIR = path.join(os.homedir(), ".instafy");
const TUNNEL_STATE_FILE = path.join(INSTAFY_DIR, "cli-tunnel-state.json");
const TUNNEL_LOG_DIR = path.join(INSTAFY_DIR, "cli-tunnel-logs");
const TUNNEL_WORKDIR_DIR = path.join(INSTAFY_DIR, "cli-tunnel-workdirs");

// Rathole is a persistent helper, so inheriting the CLI/model environment
// would retain controller, provider, and project credentials after the job
// that started it has finished. Keep only the process-launch basics it needs.
const RATHOLE_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "USER",
  "USERNAME",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  // Windows needs these to launch native executables and .cmd test helpers.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export function buildRatholeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const sourceEntries = Object.entries(source);
  for (const key of RATHOLE_ENVIRONMENT_KEYS) {
    const value =
      source[key] ??
      sourceEntries.find(([candidate]) => candidate.toUpperCase() === key)?.[1];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

function cleanUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function normalizeTunnelPurpose(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let normalized = "";
  for (const ch of trimmed) {
    if (normalized.length >= 48) break;
    const lower = ch.toLowerCase();
    if ((lower >= "a" && lower <= "z") || (lower >= "0" && lower <= "9") || lower === "_" || lower === "-") {
      normalized += lower;
    } else {
      normalized += "_";
    }
  }

  normalized = normalized.replace(/^_+/, "").replace(/_+$/, "");
  return normalized ? normalized : null;
}

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  if (value && value.trim()) return value.trim();
  return undefined;
}

function resolveWorkingDir(opts: TunnelCliOptions): string {
  const value = opts.cwd?.trim() ?? "";
  return value.length > 0 ? value : process.cwd();
}

function resolveProject(opts: TunnelCliOptions): string {
  const explicit =
    opts.project?.trim() ||
    readEnv("SPACE_ID") ||
    readEnv("CONTROLLER_SPACE_ID") ||
    null;
  if (explicit) {
    return explicit;
  }
  const manifest = findProjectManifest(resolveWorkingDir(opts)).manifest;
  if (manifest?.spaceId) {
    return manifest.spaceId;
  }
  throw new Error(
    "No space configured for this folder.\n\nNext:\n- instafy space init\n\nOr pass --space <uuid> / set SPACE_ID.",
  );
}

type TunnelAliasConfig = {
  name: string;
  purpose: string;
  manifestPath: string | null;
};

function writeProjectManifest(manifestPath: string, manifest: ProjectManifest) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function resolveTunnelAlias(opts: TunnelCliOptions, projectId: string): TunnelAliasConfig {
  const name = normalizeTunnelPurpose(opts.name?.trim() ?? "") ?? "web";
  const rotate = Boolean(opts.rotate);

  const found = findProjectManifest(resolveWorkingDir(opts));
  const manifest = found.manifest;
  const manifestPath = found.path;
  const canPersist = Boolean(manifest && manifestPath && manifest.spaceId === projectId);

  if (!canPersist) {
    if (rotate) {
      throw new Error("`--rotate` requires a space manifest (.instafy/space.json) so Instafy can remember the new tunnel URL.");
    }
    return { name, purpose: name, manifestPath: null };
  }

  const tunnels = (manifest!.tunnels && typeof manifest!.tunnels === "object" ? manifest!.tunnels : {}) as NonNullable<
    ProjectManifest["tunnels"]
  >;
  const existing = tunnels[name];
  const existingPurpose = typeof existing?.purpose === "string" ? normalizeTunnelPurpose(existing.purpose) : null;

  const purpose = rotate || !existingPurpose ? `${name}_${randomUUID().slice(0, 8)}` : existingPurpose;
  const normalizedPurpose = normalizeTunnelPurpose(purpose) ?? `${name}_${randomUUID().slice(0, 8)}`;

  const now = new Date().toISOString();
  const nextEntry = {
    purpose: normalizedPurpose,
    hostname: rotate ? null : existing?.hostname ?? null,
    url: rotate ? null : existing?.url ?? null,
    createdAt: rotate ? now : existing?.createdAt ?? now,
    updatedAt: now,
  };

  const nextManifest: ProjectManifest = {
    ...manifest!,
    tunnels: {
      ...tunnels,
      [name]: nextEntry,
    },
  };
  writeProjectManifest(manifestPath!, nextManifest);

  return { name, purpose: normalizedPurpose, manifestPath: manifestPath! };
}

function persistTunnelAliasResult(config: TunnelAliasConfig, hostname: string, url: string) {
  if (!config.manifestPath) return;
  try {
    const raw = fs.readFileSync(config.manifestPath, "utf8");
    const parsed = JSON.parse(raw) as ProjectManifest;
    if (!parsed?.tunnels || typeof parsed.tunnels !== "object") {
      return;
    }
    const existing = parsed.tunnels[config.name];
    if (!existing || typeof existing !== "object") {
      return;
    }
    parsed.tunnels[config.name] = {
      ...existing,
      hostname,
      url,
      updatedAt: new Date().toISOString(),
    };
    writeProjectManifest(config.manifestPath, parsed);
  } catch {
    // ignore persistence failures (tunnel still works)
  }
}

function resolveTunnelControllerUrl(opts: TunnelCliOptions): string {
  const explicit = opts.controllerUrl?.trim();
  if (explicit) {
    return explicit;
  }

  const envUrl =
    readEnv("INSTAFY_SERVER_URL") ||
    readEnv("INSTAFY_URL") ||
    readEnv("CONTROLLER_URL") ||
    readEnv("CONTROLLER_BASE_URL") ||
    null;
  if (envUrl) {
    return envUrl;
  }

  const manifestControllerUrl =
    findProjectManifest(resolveWorkingDir(opts)).manifest?.controllerUrl?.trim() ?? null;
  if (manifestControllerUrl) {
    return manifestControllerUrl;
  }

  return resolveConfiguredControllerUrl() ?? resolveDefaultControllerUrl();
}

function resolveControllerToken(
  opts: TunnelCliOptions,
  retryCommand = "instafy tunnel start",
): { token: string; source: AccessTokenSource; profile: string | null } {
  const explicit = opts.controllerToken?.trim();
  if (explicit) {
    return { token: explicit, source: "explicit", profile: null };
  }

  const resolved = resolveUserAccessTokenWithSource();
  if (resolved.token) {
    return { token: resolved.token, source: resolved.source, profile: resolved.profile };
  }

  const serviceToken =
    readEnv("INSTAFY_SERVICE_TOKEN") ||
    readEnv("CONTROLLER_BEARER") ||
    readEnv("CONTROLLER_TOKEN") ||
    readEnv("SERVICE_ROLE_KEY") ||
    readEnv("CONTROLLER_SERVICE_ROLE_KEY") ||
    readEnv("SUPABASE_SERVICE_ROLE_KEY") ||
    readEnv("CONTROLLER_INTERNAL_TOKEN") ||
    null;
  if (serviceToken) {
    return { token: serviceToken, source: "env", profile: null };
  }

  throw formatAuthRequiredError({
    retryCommand,
    advancedHint:
      "pass --access-token / --service-token, or set INSTAFY_ACCESS_TOKEN / SUPABASE_ACCESS_TOKEN / INSTAFY_SERVICE_TOKEN",
  });
}

function resolvePort(opts: TunnelCliOptions): number {
  const fromEnv =
    readEnv("WEBHOOK_LOCAL_PORT") ||
    readEnv("TUNNEL_LOCAL_PORT") ||
    undefined;
  const parsedEnv = fromEnv ? Number(fromEnv) : NaN;
  return opts.port ?? (Number.isFinite(parsedEnv) ? parsedEnv : 3000);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function safePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return randomUUID();
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function writeStateFile(state: TunnelStateFile) {
  ensureDir(INSTAFY_DIR);
  fs.writeFileSync(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  try {
    fs.chmodSync(TUNNEL_STATE_FILE, 0o600);
  } catch {
    // ignore chmod failures (windows / unusual fs)
  }
}

function readStateFile(): TunnelStateFile {
  try {
    const raw = fs.readFileSync(TUNNEL_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as TunnelStateFile;
    if (!parsed || typeof parsed !== "object") return { version: 1, tunnels: [] };
    if (!Array.isArray(parsed.tunnels)) return { version: 1, tunnels: [] };
    return {
      version: 1,
      tunnels: parsed.tunnels.filter(Boolean),
    };
  } catch {
    return { version: 1, tunnels: [] };
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : null;
    // EPERM means the process exists but we don't have permission to signal it.
    return code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

function upsertTunnelState(entry: TunnelStateEntry) {
  const state = readStateFile();
  const next = state.tunnels.filter((tunnel) => tunnel.tunnelId !== entry.tunnelId);
  next.unshift(entry);
  writeStateFile({ version: 1, tunnels: next });
}

function removeTunnelState(tunnelId: string): TunnelStateEntry | null {
  const state = readStateFile();
  const existing = state.tunnels.find((tunnel) => tunnel.tunnelId === tunnelId) ?? null;
  const next = state.tunnels.filter((tunnel) => tunnel.tunnelId !== tunnelId);
  writeStateFile({ version: 1, tunnels: next });
  return existing;
}

async function requestTunnel(
  controllerUrl: string,
  auth: { token: string; source: AccessTokenSource; profile: string | null },
  projectId: string,
  purpose: string | null,
  metadata: Record<string, unknown>,
): Promise<TunnelResponse> {
  const target = `${cleanUrl(controllerUrl)}/projects/${encodeURIComponent(projectId)}/tunnels/request`;
  const { response } = await fetchWithControllerAuth({
    url: target,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        runtimeId: readEnv("RUNTIME_ID"),
        runtimeLeaseId: readEnv("RUNTIME_LEASE_ID"),
        purpose: purpose ?? undefined,
        localPort: typeof metadata.localPort === "number" ? metadata.localPort : undefined,
        metadata,
      }),
    },
    accessToken: auth.token,
    tokenSource: auth.source,
    profile: auth.profile,
    cwd: process.cwd(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
        retryCommand: "instafy tunnel start",
      });
    }
    throw new Error(`Tunnel request failed (${response.status} ${response.statusText}): ${text}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const tunnelId =
    typeof body["tunnelId"] === "string"
      ? body["tunnelId"]
      : typeof body["tunnel_id"] === "string"
        ? body["tunnel_id"]
        : null;
  const hostname =
    typeof body["hostname"] === "string" ? body["hostname"] : null;
  if (!tunnelId || !hostname) {
    throw new Error("Tunnel response missing tunnelId/hostname");
  }
  return {
    tunnelId,
    hostname,
    url: typeof body["url"] === "string" ? (body["url"] as string) : undefined,
    credentials: (body["credentials"] ?? null) as Record<string, unknown> | undefined,
  };
}

async function revokeTunnel(
  controllerUrl: string,
  auth: { token: string; source: AccessTokenSource; profile: string | null },
  projectId: string,
  tunnelId: string,
) {
  const target = `${cleanUrl(controllerUrl)}/projects/${encodeURIComponent(projectId)}/tunnels/${encodeURIComponent(tunnelId)}/revoke`;
  const { response } = await fetchWithControllerAuth({
    url: target,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ metadata: { reason: "instafy-cli-tunnel:stop" } }),
    },
    accessToken: auth.token,
    tokenSource: auth.source,
    profile: auth.profile,
    cwd: process.cwd(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
        retryCommand: `instafy tunnel stop ${tunnelId}`,
      });
    }
    throw new Error(`Tunnel revoke failed (${response.status} ${response.statusText}): ${text}`);
  }
}

function buildRatholeConfig(creds: Record<string, unknown>, port: number): string {
  const server = typeof creds["server"] === "string" ? (creds["server"] as string) : null;
  const token = typeof creds["token"] === "string" ? (creds["token"] as string) : null;
  const service =
    (typeof creds["service"] === "string" && (creds["service"] as string)) ||
    (typeof creds["serviceName"] === "string" && (creds["serviceName"] as string)) ||
    "runtime";
  const protocol =
    (typeof creds["protocol"] === "string" && (creds["protocol"] as string)) || "tcp";
  if (!server || !token) {
    throw new Error("Tunnel credentials missing server/token");
  }
  return (
    `[client]
remote_addr = "${server}"
default_token = "${token}"
heartbeat_timeout = 40
retry_interval = 1

[client.transport]
type = "tcp"

[client.transport.tcp]
nodelay = true
keepalive_secs = 20
keepalive_interval = 8

[client.services.${service}]
type = "${protocol}"
local_addr = "127.0.0.1:${port}"
`
  );
}

type TunnelSession = {
  url: string;
  hostname: string;
  tunnelId: string;
  close: () => Promise<void>;
};

export async function startTunnelSession(opts: TunnelCliOptions): Promise<TunnelSession> {
  const projectId = resolveProject(opts);
  const controllerUrl = resolveTunnelControllerUrl(opts);
  const controllerToken = resolveControllerToken(opts);
  const port = resolvePort(opts);
  const alias = resolveTunnelAlias(opts, projectId);
  let cleanedUp = false;

  if (opts.ratholeBin) {
    process.env.RATHOLE_BIN = opts.ratholeBin;
  }

  const rathole = await resolveRatholeBinaryForCli({
    env: process.env,
    version: process.env.RATHOLE_VERSION ?? null,
    cacheDir: process.env.RATHOLE_CACHE_DIR ?? null,
    logger: (message) => console.log(kleur.cyan(`[rathole] ${message}`)),
    warn: (message) => console.warn(kleur.yellow(message)),
  });
  if (!rathole) {
    throw new Error(
      "rathole is required to start a tunnel. Set RATHOLE_BIN or ensure it is on PATH.",
    );
  }

  const metadata = { localPort: port, source: "instafy-cli", tunnelName: alias.name };
  const grant = await requestTunnel(controllerUrl, controllerToken, projectId, alias.purpose, metadata);
  persistTunnelAliasResult(alias, grant.hostname, grant.url ?? `https://${grant.hostname}`);

  const creds =
    grant.credentials && typeof grant.credentials === "object"
      ? grant.credentials
      : {};
  const configBody = buildRatholeConfig(creds, port);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-tunnel-"));
  const configPath = path.join(workdir, "rathole.toml");
  fs.writeFileSync(configPath, configBody, { encoding: "utf8", mode: 0o600 });

  const child = spawn(rathole, ["-c", configPath], {
    stdio: "inherit",
    cwd: workdir,
    env: buildRatholeEnvironment(),
  });

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    child.kill("SIGTERM");
    await revokeTunnel(controllerUrl, controllerToken, projectId, grant.tunnelId);
    fs.rmSync(workdir, { recursive: true, force: true });
  };

  child.on("exit", () => {
    void cleanup().catch((error) => {
      console.warn(kleur.yellow(`Tunnel cleanup failed: ${String(error)}`));
    });
  });

  return {
    url: grant.url ?? `https://${grant.hostname}`,
    hostname: grant.hostname,
    tunnelId: grant.tunnelId,
    close: cleanup,
  };
}

export async function runTunnelCommand(opts: TunnelCliOptions, options?: { timeoutMs?: number }) {
  const session = await startTunnelSession(opts);
  console.log(
    kleur.green(`Tunnel ready: ${session.url} (tunnelId=${session.tunnelId})`),
  );

  const timeoutMs = options?.timeoutMs ?? null;

  await new Promise<void>((resolve) => {
    let timeout: NodeJS.Timeout | null = null;
    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(async () => {
        await session.close();
        resolve();
      }, timeoutMs);
    }
    const handle = async () => {
      await session.close();
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    process.once("SIGINT", handle);
    process.once("SIGTERM", handle);
  });
}

export async function startTunnelDetached(opts: TunnelStartOptions): Promise<TunnelStateEntry> {
  const projectId = resolveProject(opts);
  const controllerUrl = resolveTunnelControllerUrl(opts);
  const controllerToken = resolveControllerToken(opts);
  const port = resolvePort(opts);
  const alias = resolveTunnelAlias(opts, projectId);

  if (opts.ratholeBin) {
    process.env.RATHOLE_BIN = opts.ratholeBin;
  }

  const rathole = await resolveRatholeBinaryForCli({
    env: process.env,
    version: process.env.RATHOLE_VERSION ?? null,
    cacheDir: process.env.RATHOLE_CACHE_DIR ?? null,
    logger: (message) => console.log(kleur.cyan(`[rathole] ${message}`)),
    warn: (message) => console.warn(kleur.yellow(message)),
  });
  if (!rathole) {
    throw new Error(
      "rathole is required to start a tunnel. Set RATHOLE_BIN or ensure it is on PATH.",
    );
  }

  const metadata = { localPort: port, source: "instafy-cli", tunnelName: alias.name };
  const grant = await requestTunnel(controllerUrl, controllerToken, projectId, alias.purpose, metadata);
  persistTunnelAliasResult(alias, grant.hostname, grant.url ?? `https://${grant.hostname}`);

  ensureDir(TUNNEL_WORKDIR_DIR);
  ensureDir(TUNNEL_LOG_DIR);
  const tunnelIdSafe = safePathSegment(grant.tunnelId);
  const workdir = path.join(TUNNEL_WORKDIR_DIR, tunnelIdSafe);
  ensureDir(workdir);

  const creds =
    grant.credentials && typeof grant.credentials === "object"
      ? grant.credentials
      : {};
  const configBody = buildRatholeConfig(creds, port);
  const configPath = path.join(workdir, "rathole.toml");
  fs.writeFileSync(configPath, configBody, { encoding: "utf8", mode: 0o600 });

  const logFile = opts.logFile?.trim()
    ? path.resolve(opts.logFile.trim())
    : path.join(TUNNEL_LOG_DIR, `tunnel-${tunnelIdSafe}.log`);
  const logFd = fs.openSync(logFile, "a");

  const child = spawn(rathole, ["-c", configPath], {
    stdio: ["ignore", logFd, logFd],
    cwd: workdir,
    detached: true,
    env: buildRatholeEnvironment(),
  });

  let exitedEarly = false;
  let exitMessage = "";
  child.on("exit", (code, signal) => {
    exitedEarly = true;
    exitMessage = code !== null ? `code ${code}` : `signal ${signal}`;
  });

  // Give rathole a moment to fail fast, so `instafy tunnel start` can report errors.
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (exitedEarly || !isProcessAlive(child.pid ?? -1)) {
    const logTail = (() => {
      try {
        const text = fs.readFileSync(logFile, "utf8");
        const lines = text.split(/\r?\n/).filter(Boolean);
        return lines.slice(-20).join("\n");
      } catch {
        return "";
      }
    })();
    await revokeTunnel(controllerUrl, controllerToken, projectId, grant.tunnelId).catch(() => {});
    const suffix = logTail ? `\n\nLast logs:\n${logTail}` : "";
    throw new Error(`Tunnel process exited (${exitMessage || "unknown"}).${suffix}`);
  }

  child.unref();

  const entry: TunnelStateEntry = {
    tunnelId: grant.tunnelId,
    projectId,
    hostname: grant.hostname,
    url: grant.url ?? `https://${grant.hostname}`,
    localPort: port,
    controllerUrl: cleanUrl(controllerUrl),
    pid: child.pid ?? -1,
    logFile,
    workdir,
    startedAt: new Date().toISOString(),
  };

  upsertTunnelState(entry);
  return entry;
}

export function listTunnelSessions(options?: TunnelListOptions): TunnelStateEntry[] {
  const state = readStateFile();
  if (options?.all) {
    return state.tunnels;
  }
  return state.tunnels.filter((entry) => isProcessAlive(entry.pid));
}

export async function stopTunnelSession(opts: TunnelStopOptions): Promise<{ ok: boolean; tunnelId: string }> {
  const tunnelId = opts.tunnelId?.trim() ?? "";
  if (!tunnelId) {
    const active = listTunnelSessions({ all: false });
    if (active.length === 1) {
      return stopTunnelSession({ ...opts, tunnelId: active[0]?.tunnelId });
    }
    throw new Error("Tunnel id is required. Use `instafy tunnel list` to find it.");
  }

  const entry = removeTunnelState(tunnelId);
  if (!entry) {
    throw new Error(`Tunnel not found in local state: ${tunnelId}`);
  }

  if (isProcessAlive(entry.pid)) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // ignore
    }
    const stopped = await waitForProcessExit(entry.pid, 4000);
    if (!stopped) {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  const controllerToken = resolveControllerToken(opts, `instafy tunnel stop ${tunnelId}`);
  try {
    await revokeTunnel(entry.controllerUrl, controllerToken, entry.projectId, entry.tunnelId);
  } catch (error) {
    // Keep a retryable local record when the controller rejects or cannot
    // receive the revoke. The local process is already stopped, so this entry
    // only appears with `tunnel list --all` until the user retries by id.
    upsertTunnelState({ ...entry, pid: -1 });
    throw error;
  }

  try {
    fs.rmSync(entry.workdir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return { ok: true, tunnelId: entry.tunnelId };
}

export function resolveTunnelLogFile(tunnelId?: string): TunnelStateEntry {
  const chosen = tunnelId?.trim() ?? "";
  const all = readStateFile().tunnels;
  if (chosen) {
    const entry = all.find((tunnel) => tunnel.tunnelId === chosen);
    if (!entry) {
      throw new Error(`Tunnel not found in local state: ${chosen}`);
    }
    return entry;
  }
  const active = all.filter((entry) => isProcessAlive(entry.pid));
  if (active.length === 1) {
    return active[0]!;
  }
  throw new Error("Tunnel id is required. Use `instafy tunnel list` to find it.");
}

export async function tailTunnelLogs(options: TunnelLogsOptions): Promise<void> {
  const entry = resolveTunnelLogFile(options.tunnelId);
  const logFile = entry.logFile;

  const lines = Number.isFinite(options.lines) ? (options.lines as number) : NaN;
  const lineCount = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 200;
  const follow = Boolean(options.follow);

  if (options.json) {
    console.log(JSON.stringify({ tunnelId: entry.tunnelId, logFile, follow, lines: lineCount }, null, 2));
    return;
  }

  if (!follow) {
    const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    const rows = raw.split(/\r?\n/);
    const tail = rows.slice(Math.max(0, rows.length - lineCount));
    console.log(tail.join("\n"));
    return;
  }

  // Follow mode: prefer system tail tools.
  const child =
    process.platform === "win32"
      ? spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Get-Content -LiteralPath '${logFile.replace(/'/g, "''")}' -Tail ${lineCount} -Wait`,
          ],
          { stdio: "inherit" },
        )
      : spawn("tail", ["-n", String(lineCount), "-f", logFile], { stdio: "inherit" });
  const handleExit = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  };
  process.once("SIGINT", handleExit);
  process.once("SIGTERM", handleExit);
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}
