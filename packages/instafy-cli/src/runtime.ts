import { spawn, spawnSync, type SpawnOptions, type StdioOptions } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import kleur from "kleur";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { ensureRatholeBinary } from "./rathole.js";
import {
  resolveActiveProfileName,
  resolveConfiguredAccessToken,
  resolveConfiguredControllerUrl,
  type AccessTokenSource,
} from "./config.js";
import { formatAuthRejectedError } from "./errors.js";
import { findProjectManifest, type ProjectManifest } from "./project-manifest.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";

export interface RuntimeStartOptions {
  project?: string;
  controllerUrl?: string;
  supabaseAccessToken?: string;
  supabaseAccessTokenFile?: string;
  provider?: string;
  codexBin?: string;
  proxyBaseUrl?: string;
  workspace?: string;
  originId?: string;
  originEndpoint?: string;
  originToken?: string;
  displayName?: string;
  bindHost?: string;
  bindPort?: number;
  detach?: boolean;
  logFile?: string;
  controllerAccessToken?: string;
  runtimeToken?: string;
  runtimeId?: string;
  runtimeLeaseId?: string;
  runtimeMode?: "auto" | "process" | "docker";
}

interface RuntimeState {
  runner?: "process" | "docker";
  pid: number;
  projectId: string;
  workspace: string;
  controllerUrl?: string;
  originId?: string;
  runtimeId?: string | null;
  displayName?: string;
  startedAt: string;
  logFile?: string;
  detached?: boolean;
  containerId?: string | null;
  containerName?: string | null;
}

const INSTAFY_DIR = path.join(os.homedir(), ".instafy");
const STATE_FILE = path.join(INSTAFY_DIR, "cli-runtime-state.json");
const LOG_DIR = path.join(INSTAFY_DIR, "cli-runtime-logs");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveRepoRoot(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "../../..");
}

function resolveRuntimeBinary(): string {
  // Reuse existing runtime-agent binary from workspace target (assumes `cargo build` done).
  const repoRoot = resolveRepoRoot();
  const candidates = [
    path.join(repoRoot, "target", "debug", "runtime-agent"),
    path.join(repoRoot, "target", "release", "runtime-agent"),
    path.join(repoRoot, "packages", "runtime-agent", "target", "debug", "runtime-agent"),
    path.join(repoRoot, "packages", "runtime-agent", "target", "release", "runtime-agent"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "runtime-agent binary not found. If you're in the instafy repo, run `cargo build -p runtime-agent`. Otherwise install Docker and rerun `instafy runtime start`.",
  );
}

function tryResolveRuntimeBinary(): string | null {
  try {
    return resolveRuntimeBinary();
  } catch {
    return null;
  }
}

function isDockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function normalizeControllerUrlForDocker(controllerUrl: string): string {
  const trimmed = controllerUrl.trim().replace(/\/$/, "");
  if (!trimmed) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0") {
      url.hostname = "host.docker.internal";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed
      .replace("127.0.0.1", "host.docker.internal")
      .replace("localhost", "host.docker.internal")
      .replace("0.0.0.0", "host.docker.internal")
      .replace(/\/$/, "");
  }
}

function resolveRuntimeAgentImage(): string {
  const fromEnv =
    normalizeToken(process.env["INSTAFY_RUNTIME_AGENT_IMAGE"]) ??
    normalizeToken(process.env["RUNTIME_AGENT_IMAGE"]) ??
    null;
  if (!fromEnv) {
    throw new Error(
      "Docker runtime startup requires an explicit image reference. Set INSTAFY_RUNTIME_AGENT_IMAGE to a local image tag or, for hosted use, an immutable OCI digest.",
    );
  }
  return fromEnv;
}

function dockerContainerRunning(containerId: string): boolean {
  const id = containerId.trim();
  if (!id) {
    return false;
  }
  try {
    const result = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", id], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return false;
    }
    return String(result.stdout ?? "").trim() === "true";
  } catch {
    return false;
  }
}

function stopDockerContainer(containerId: string): void {
  const id = containerId.trim();
  if (!id) {
    return;
  }
  try {
    spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
  } catch {
    // ignore
  }
}

function printStatus(label: string, value: string) {
  console.log(`${kleur.cyan(label)} ${value}`);
}

function ensureStateDir() {
  mkdirSync(INSTAFY_DIR, { recursive: true });
}

function ensureLogDir() {
  mkdirSync(LOG_DIR, { recursive: true });
}

function writeState(state: RuntimeState) {
  ensureStateDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readState(): RuntimeState | null {
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw) as RuntimeState;
  } catch {
    return null;
  }
}

function clearState() {
  try {
    rmSync(STATE_FILE);
  } catch {
    // ignore
  }
}

function normalizeToken(value: string | undefined | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function runtimeIdFromScopedToken(token: string): string | null {
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const raw =
      typeof payload.runtime_id === "string"
        ? payload.runtime_id
        : typeof payload.runtimeId === "string"
          ? payload.runtimeId
          : "";
    const runtimeId = raw.trim().toLowerCase();
    return UUID_PATTERN.test(runtimeId) ? runtimeId : null;
  } catch {
    return null;
  }
}

export { findProjectManifest, type ProjectManifest };

function readTokenFromFile(filePath: string | undefined | null): string | null {
  const normalized = normalizeToken(filePath);
  if (!normalized) {
    return null;
  }
  const resolved = path.resolve(normalized);
  const contents = readFileSync(resolved, "utf8").trim();
  if (!contents) {
    throw new Error(`token file ${resolved} was empty`);
  }
  return contents;
}

function resolveSupabaseAccessToken(
  options: RuntimeStartOptions,
  env: NodeJS.ProcessEnv,
): string | null {
  const explicit = normalizeToken(options.supabaseAccessToken);
  if (explicit) {
    return explicit;
  }
  const fromFile = readTokenFromFile(options.supabaseAccessTokenFile);
  if (fromFile) {
    return fromFile;
  }
  const fromEnv = normalizeToken(env["SUPABASE_ACCESS_TOKEN"]);
  if (fromEnv) {
    return fromEnv;
  }
  return null;
}

function findRatholeOnPath(): string | null {
  const names = process.platform === "win32" ? ["rathole.exe", "rathole"] : ["rathole"];
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveControllerAccessTokenForCliWithSource(
  options: RuntimeStartOptions,
  env: NodeJS.ProcessEnv,
  supabaseAccessToken: string | null,
  profile: string | null,
  cwd: string | null,
): { token: string | null; source: AccessTokenSource } {
  const explicit = normalizeToken(options.controllerAccessToken);
  if (explicit) {
    return { token: explicit, source: "explicit" };
  }

  const envToken =
    normalizeToken(env["INSTAFY_ACCESS_TOKEN"]);
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  if (supabaseAccessToken) {
    return { token: supabaseAccessToken, source: "explicit" };
  }

  const supabaseEnvToken = normalizeToken(env["SUPABASE_ACCESS_TOKEN"]);
  if (supabaseEnvToken) {
    return { token: supabaseEnvToken, source: "env" };
  }

  const stored = resolveConfiguredAccessToken({ profile, cwd });
  if (stored) {
    return { token: stored, source: "config" };
  }

  return { token: null, source: "none" };
}

const RUNTIME_CHILD_CREDENTIALS_TO_REMOVE = [
  "CONTROLLER_ACCESS_TOKEN",
  "INSTAFY_ACCESS_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "INSTAFY_SERVICE_TOKEN",
  "RUNTIME_TOKEN",
  "ORIGIN_TOKEN",
  "WORKSPACE_ACCESS_TOKEN",
  "WORKSPACE_INTERNAL_TOKEN",
  "WORKSPACE_TOKEN",
  "CONTROLLER_WORKSPACE_TOKEN",
  "INSTAFY_WORKSPACE_TOKEN",
  "CONTROLLER_INTERNAL_TOKEN",
  "CONTROLLER_TOKEN",
  "CONTROLLER_BEARER",
  "CONTROLLER_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
  "SERVICE_ROLE_KEY",
  "AGENT_LOGIN_KEY",
  "AGENT_KEY",
  "PROXY_SIGNING_SECRET",
  "CONTROLLER_BROWSER_TURN_SHARED_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
  "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS",
  "PROGRESS_CALLBACK_SECRET",
  "SUPABASE_JWT_SECRET",
  "USER_TOKEN_SECRET",
  "RUNTIME_SIGNING_PRIVATE_KEY",
  "RUNTIME_SIGNING_PRIVATE_KEY_B64",
  "PROVIDER_AUTH_TOKEN",
  "DEV_PROVIDER_AUTH_TOKEN",
  "RUNTIME_PROVIDER_AUTH_TOKEN",
  "HETZNER_PROVIDER_AUTH_TOKEN",
  "DOCKER_POOL_AUTH_TOKEN",
  "HCLOUD_TOKEN",
  "HETZNER_TOKEN",
  "PDNS_API_KEY",
  "GIT_EDGE_CONTROLLER_TOKEN",
  "GIT_EVENTS_WEBHOOK_TOKEN",
  "GIT_EVENT_HOOK_SECRET",
  "TUNNEL_BROKER_TOKEN",
  "TUNNEL_BROKER_HOOK_SECRET",
  "BROKER_API_TOKENS",
  "RATHOLE_SHARED_TOKEN",
  "TOKEN_SIGNING_KEY",
  "ACL_HOOK_TOKEN",
  "EVENT_HOOK_TOKEN",
  "SUPABASE_REFRESH_TOKEN",
  "INSTAFY_REFRESH_TOKEN",
  "CONTROLLER_REFRESH_TOKEN",
  "REFRESH_TOKEN",
] as const;

export function buildRuntimeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...source };
  for (const key of RUNTIME_CHILD_CREDENTIALS_TO_REMOVE) {
    delete child[key];
  }
  return child;
}

interface RatholeResolutionOptions {
  env: NodeJS.ProcessEnv;
  version?: string | null;
  cacheDir?: string | null;
  logger?: (message: string) => void;
  warn?: (message: string) => void;
  findBinary?: () => string | null;
  downloadBinary?: (options?: Parameters<typeof ensureRatholeBinary>[0]) => Promise<string>;
}

export async function resolveRatholeBinaryForCli(
  options: RatholeResolutionOptions,
): Promise<string | null> {
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(kleur.yellow(message));
    });
  const logger =
    options.logger ??
    ((message: string) => {
      console.log(kleur.cyan(`[rathole] ${message}`));
    });

  const existing = normalizeToken(options.env["RATHOLE_BIN"]);
  if (existing) {
    options.env["RATHOLE_BIN"] = existing;
    return existing;
  }

  const finder = options.findBinary ?? findRatholeOnPath;
  const detected = finder();
  if (detected) {
    options.env["RATHOLE_BIN"] = detected;
    return detected;
  }

  const download =
    options.downloadBinary ??
    ((params?: Parameters<typeof ensureRatholeBinary>[0]) => ensureRatholeBinary(params));

  try {
    const resolved = await download({
      version: normalizeToken(options.version ?? undefined) ?? undefined,
      cacheDir: normalizeToken(options.cacheDir ?? undefined) ?? undefined,
      logger,
    });
    options.env["RATHOLE_BIN"] = resolved;
    return resolved;
  } catch (error) {
    const suffix =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    const osHint =
      process.platform === "darwin"
        ? "Install with cargo (`cargo install --locked rathole`) or set RATHOLE_BIN to a downloaded binary."
        : process.platform === "linux"
          ? "Download from https://github.com/rapiz1/rathole/releases (matching your arch) or build via `cargo install --locked rathole`."
          : "Download a rathole binary for your OS/arch and set RATHOLE_BIN.";
    warn(
      `rathole unavailable (set RATHOLE_BIN or install on PATH). ${osHint} ${suffix}`,
    );
    return null;
  }
}

type RuntimeAccessTokenParams = {
  controllerUrl: string;
  controllerAccessToken: string;
  projectId: string;
  runtimeId?: string;
  leaseId?: string;
  scopes?: string[];
  tokenSource?: AccessTokenSource;
  profile?: string | null;
  cwd?: string | null;
};

async function requestRuntimeAccessToken(
  params: RuntimeAccessTokenParams,
): Promise<{ token: string; runtimeId: string | null }> {
  const url = params.controllerUrl.replace(/\/$/, "");
  const target = `${url}/projects/${encodeURIComponent(params.projectId)}/runtime/token`;
  const { response } = await fetchWithControllerAuth({
    url: target,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runtimeId: params.runtimeId,
        leaseId: params.leaseId,
        scopes: params.scopes,
      }),
    },
    accessToken: params.controllerAccessToken,
    tokenSource: params.tokenSource ?? "env",
    profile: params.profile ?? null,
    cwd: params.cwd ?? null,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
      });
    }
    throw new Error(
      `Instafy server rejected runtime token request (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!token) {
    throw new Error("Instafy server response missing token field while minting runtime token.");
  }
  const responseRuntimeIdRaw =
    typeof payload.runtimeId === "string"
      ? payload.runtimeId
      : typeof payload.runtime_id === "string"
        ? payload.runtime_id
        : null;
  const responseRuntimeId = responseRuntimeIdRaw?.trim().toLowerCase() ?? null;
  if (responseRuntimeId && !UUID_PATTERN.test(responseRuntimeId)) {
    throw new Error("Instafy server response included an invalid runtimeId.");
  }
  return { token, runtimeId: responseRuntimeId };
}

export async function mintRuntimeAccessToken(
  params: RuntimeAccessTokenParams,
): Promise<string> {
  return (await requestRuntimeAccessToken(params)).token;
}

export async function mintPrivateRuntimeIdentity(
  params: RuntimeAccessTokenParams,
): Promise<{ token: string; runtimeId: string }> {
  const minted = await requestRuntimeAccessToken(params);
  const tokenRuntimeId = runtimeIdFromScopedToken(minted.token);
  if (!tokenRuntimeId) {
    throw new Error("Controller runtime token is missing its signed runtimeId claim.");
  }
  if (
    minted.runtimeId &&
    minted.runtimeId !== tokenRuntimeId
  ) {
    throw new Error(
      "Controller runtime token identity does not match its response runtimeId.",
    );
  }
  return { token: minted.token, runtimeId: tokenRuntimeId };
}

export async function mintOriginAccessToken(params: {
  controllerUrl: string;
  controllerAccessToken: string;
  projectId: string;
  leaseId: string;
  protocol?: string;
  scopes?: string[];
  tokenSource?: AccessTokenSource;
  profile?: string | null;
  cwd?: string | null;
}): Promise<{ token: string; endpoint: string | null }> {
  const url = params.controllerUrl.replace(/\/$/, "");
  const target = `${url}/access_token`;
  const { response } = await fetchWithControllerAuth({
    url: target,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: params.projectId,
        protocol: params.protocol ?? "http",
        scopes: params.scopes ?? ["fs.read", "fs.write"],
        leaseId: params.leaseId,
      }),
    },
    accessToken: params.controllerAccessToken,
    tokenSource: params.tokenSource ?? "env",
    profile: params.profile ?? null,
    cwd: params.cwd ?? null,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
      });
    }
    throw new Error(
      `Instafy server rejected origin token request (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!token) {
    throw new Error("Instafy server response missing token field while minting origin token.");
  }

  const endpoint =
    typeof payload.endpoint === "string" && payload.endpoint.trim()
      ? payload.endpoint.trim()
      : null;

  return { token, endpoint };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runtimeStart(options: RuntimeStartOptions) {
  const env = { ...process.env };
  const cwd = process.cwd();
  const existing = readState();
  if (existing) {
    if (existing.runner === "docker" && existing.containerId && dockerContainerRunning(existing.containerId)) {
      throw new Error(
        `Runtime already running (docker container ${existing.containerId}) for space ${existing.projectId}. Stop it first.`,
      );
    }
    if ((!existing.runner || existing.runner === "process") && isProcessAlive(existing.pid)) {
      throw new Error(
        `Runtime already running (pid ${existing.pid}) for space ${existing.projectId}. Stop it first.`,
      );
    }
  }

  const manifestInfo = findProjectManifest(cwd);
  const projectId =
    options.project ?? env["SPACE_ID"] ?? manifestInfo.manifest?.spaceId ?? null;
  if (!projectId) {
    throw new Error(
      "No space configured. Run `instafy space init` in this folder (recommended) or pass --space.",
    );
  }
  env["SPACE_ID"] = projectId;
  
  const supabaseAccessToken = resolveSupabaseAccessToken(options, env);
  if (supabaseAccessToken) {
    env["SUPABASE_ACCESS_TOKEN"] = supabaseAccessToken;
  }

  const profile = resolveActiveProfileName({ cwd });
  const controllerAccessTokenResult = resolveControllerAccessTokenForCliWithSource(
    options,
    env,
    supabaseAccessToken,
    profile,
    cwd,
  );
  let controllerAccessToken = controllerAccessTokenResult.token;
  const controllerAccessTokenSource = controllerAccessTokenResult.source;
  let runtimeAccessToken =
    normalizeToken(options.runtimeToken) ?? normalizeToken(env["RUNTIME_ACCESS_TOKEN"]);
  const agentKey = env["AGENT_LOGIN_KEY"] ?? env["AGENT_KEY"];
  if (!agentKey && !controllerAccessToken && !runtimeAccessToken) {
    throw new Error(
      "Login required. Run `instafy login`, or pass --access-token / --supabase-access-token, or provide --runtime-token.",
    );
  }
  if (agentKey) {
    env["AGENT_LOGIN_KEY"] = agentKey;
  }
  env["CONTROLLER_BASE_URL"] =
    options.controllerUrl ??
    env["INSTAFY_SERVER_URL"] ??
    manifestInfo.manifest?.controllerUrl ??
    resolveConfiguredControllerUrl({ profile, cwd }) ??
    "http://127.0.0.1:8788";

  if (options.codexBin) env["CODEX_BIN"] = options.codexBin;
  if (options.proxyBaseUrl) env["PROXY_BASE_URL"] = options.proxyBaseUrl;
  if (!env["CODEX_REASONING_EFFORT"]) {
    env["CODEX_REASONING_EFFORT"] = "low";
  }

  const workspace = path.resolve(
    options.workspace ?? env["WORKSPACE_DIR"] ?? path.join(process.cwd(), ".instafy", "workspace"),
  );
  mkdirSync(workspace, { recursive: true });
  env["WORKSPACE_DIR"] = workspace;

  const requestedOriginId = normalizeToken(options.originId) ?? normalizeToken(env["ORIGIN_ID"]);
  env["ORIGIN_BIND_HOST"] = options.bindHost ?? env["ORIGIN_BIND_HOST"] ?? "127.0.0.1";
  env["ORIGIN_BIND_PORT"] = String(options.bindPort ?? env["ORIGIN_BIND_PORT"] ?? 54332);
  env["ORIGIN_PROTOCOLS"] = env["ORIGIN_PROTOCOLS"] ?? "http";
  if (options.originEndpoint && options.originEndpoint.trim()) {
    env["ORIGIN_ENDPOINT"] = options.originEndpoint.trim();
  }

  const skipAuthRaw = env["ORIGIN_SKIP_AUTH"]?.trim().toLowerCase();
  const skipAuth =
    skipAuthRaw === "1" || skipAuthRaw === "true" || skipAuthRaw === "yes";
  const usesTunnel = !env["ORIGIN_ENDPOINT"];
  const usesExplicitEndpoint = Boolean(env["ORIGIN_ENDPOINT"]);
  if (skipAuth && (usesTunnel || usesExplicitEndpoint)) {
    console.warn(
      kleur.yellow(
        "Warning: ORIGIN_SKIP_AUTH is enabled while the origin may be reachable remotely (tunnel or --origin-endpoint). " +
          "This is unsafe; disable ORIGIN_SKIP_AUTH for any non-local usage.",
      ),
    );
  }

  env["RUNTIME_DISPLAY_NAME"] =
    options.displayName ?? env["RUNTIME_DISPLAY_NAME"] ?? "Instafy CLI Runtime";
  env["RUNTIME_PROVIDER"] =
    options.provider ?? env["RUNTIME_PROVIDER"] ?? "self-hosted";
  env["RUNTIME_VERSION"] = env["RUNTIME_VERSION"] ?? "0.1.0";
  env["RUNTIME_REQUIRE_CODEX_BIN"] = env["RUNTIME_REQUIRE_CODEX_BIN"] || "0";
  env["RUNTIME_CAPABILITIES"] =
    env["RUNTIME_CAPABILITIES"] ||
    JSON.stringify({ fs: true, github: true, supabase: true, runs: true, agent: true, origin: true });
  if (options.runtimeId && options.runtimeId.trim()) {
    env["RUNTIME_ID"] = options.runtimeId.trim();
  }
  if (options.runtimeLeaseId && options.runtimeLeaseId.trim()) {
    env["RUNTIME_LEASE_ID"] = options.runtimeLeaseId.trim();
  }

  const runtimeMode = (options.runtimeMode ?? "auto").toLowerCase() as RuntimeStartOptions["runtimeMode"];
  const runtimeBin = runtimeMode === "docker" ? null : tryResolveRuntimeBinary();
  const useDocker =
    runtimeMode === "docker" ||
    (runtimeMode === "auto" && !runtimeBin);

  if (useDocker && !isDockerAvailable()) {
    throw new Error(
      "runtime-agent is not available (no local binary and docker is not installed). Install Docker Desktop, or build runtime-agent from source.",
    );
  }

  const originEnabledRaw = env["ORIGIN_ENABLED"]?.trim().toLowerCase();
  const originEnabled =
    !originEnabledRaw ||
    originEnabledRaw === "1" ||
    originEnabledRaw === "true" ||
    originEnabledRaw === "yes" ||
    originEnabledRaw === "on";

  if (originEnabled && usesTunnel && !useDocker) {
    const ratholeResolved = await resolveRatholeBinaryForCli({
      env,
      version: process.env["RATHOLE_VERSION"] ?? null,
      cacheDir: process.env["RATHOLE_CACHE_DIR"] ?? null,
      logger: (message) => console.log(kleur.cyan(`[rathole] ${message}`)),
      warn: (message) => console.warn(kleur.yellow(message)),
    });

    if (!ratholeResolved) {
      throw new Error(
        "Tunnel is required but rathole is unavailable. Set RATHOLE_BIN (recommended) or pass --origin-endpoint to use a reachable URL.",
      );
    }
  }

  if (!runtimeAccessToken && controllerAccessToken) {
    const mintedIdentity = await mintPrivateRuntimeIdentity({
      controllerUrl: env["CONTROLLER_BASE_URL"],
      controllerAccessToken,
      projectId,
      runtimeId: env["RUNTIME_ID"],
      leaseId: env["RUNTIME_LEASE_ID"],
      tokenSource: controllerAccessTokenSource,
      profile,
      cwd,
    });
    runtimeAccessToken = mintedIdentity.token;
    env["RUNTIME_ID"] = mintedIdentity.runtimeId;
  }
  if (runtimeAccessToken) {
    env["RUNTIME_ACCESS_TOKEN"] = runtimeAccessToken;
  }

  const requestedRuntimeId = normalizeToken(env["RUNTIME_ID"])?.toLowerCase() ?? null;
  const tokenRuntimeId = runtimeAccessToken
    ? runtimeIdFromScopedToken(runtimeAccessToken)
    : null;
  if (requestedRuntimeId && tokenRuntimeId && requestedRuntimeId !== tokenRuntimeId) {
    throw new Error(
      "Controller runtime token identity does not match the requested runtime id.",
    );
  }
  const runtimeId = tokenRuntimeId ?? requestedRuntimeId;
  if (!runtimeId) {
    throw new Error(
      "Runtime token is missing the controller-assigned runtime id; mint a fresh runtime token.",
    );
  }
  env["RUNTIME_ID"] = runtimeId;
  const originId = requestedOriginId?.toLowerCase() ?? runtimeId;
  if (originId !== runtimeId) {
    throw new Error(
      "A private self-hosted origin id must match its controller-assigned runtime id.",
    );
  }
  env["ORIGIN_ID"] = originId;

  let originToken =
    normalizeToken(options.originToken) ??
    normalizeToken(env["ORIGIN_ACCESS_TOKEN"]) ??
    normalizeToken(env["ORIGIN_INTERNAL_TOKEN"]);
  if (!originToken && runtimeAccessToken) {
    // Use the owner-bound runtime token to register and publish the private
    // origin. The runtime agent requests its tunnel only after registration,
    // without entering the hosted allocator lease lifecycle.
    originToken = runtimeAccessToken;
  }
  if (!originToken && controllerAccessToken && env["RUNTIME_LEASE_ID"]) {
    const mintedOrigin = await mintOriginAccessToken({
      controllerUrl: env["CONTROLLER_BASE_URL"],
      controllerAccessToken,
      projectId,
      leaseId: env["RUNTIME_LEASE_ID"],
      tokenSource: controllerAccessTokenSource,
      profile,
      cwd,
    });
    originToken = mintedOrigin.token;
    if (!env["ORIGIN_ENDPOINT"] && mintedOrigin.endpoint) {
      env["ORIGIN_ENDPOINT"] = mintedOrigin.endpoint;
    }
  }
  if (!originToken && controllerAccessToken) {
    originToken = await mintRuntimeAccessToken({
      controllerUrl: env["CONTROLLER_BASE_URL"],
      controllerAccessToken,
      projectId,
      runtimeId: env["RUNTIME_ID"],
      leaseId: env["RUNTIME_LEASE_ID"],
      tokenSource: controllerAccessTokenSource,
      profile,
      cwd,
    });
  }

  if (!originToken) {
    throw new Error(
      "Runtime/origin token is required (--origin-token or ORIGIN_ACCESS_TOKEN), or provide --runtime-token/--access-token to mint/use one",
    );
  }
  env["ORIGIN_ACCESS_TOKEN"] = originToken;
  if (runtimeAccessToken) {
    env["ORIGIN_INTERNAL_TOKEN"] = runtimeAccessToken;
  } else if (!env["ORIGIN_INTERNAL_TOKEN"]) {
    env["ORIGIN_INTERNAL_TOKEN"] = originToken;
  }

  if (!useDocker) {
    if (!env["ORIGIN_ENDPOINT"]) {
      const ratholeResolved = await resolveRatholeBinaryForCli({
        env,
        version: process.env["RATHOLE_VERSION"] ?? null,
        cacheDir: process.env["RATHOLE_CACHE_DIR"] ?? null,
        logger: (message) => console.log(kleur.cyan(`[rathole] ${message}`)),
        warn: (message) => console.warn(kleur.yellow(message)),
      });

      if (!ratholeResolved) {
        throw new Error(
          "Tunnel is required but rathole is unavailable. Set RATHOLE_BIN (recommended) or pass --origin-endpoint to use a reachable URL.",
        );
      }
    }

    const bin = runtimeBin ?? resolveRuntimeBinary();
    printStatus("Starting runtime-agent:", bin);
    printStatus("Space:", projectId);
    printStatus("Workspace:", workspace);
    printStatus("Origin:", originId);
    const detached = Boolean(options.detach);
    const logFile = options.logFile?.trim()
      ? path.resolve(options.logFile)
      : detached
        ? path.join(LOG_DIR, `runtime-${Date.now()}.log`)
        : undefined;

    if (logFile) {
      ensureLogDir();
    }

    let stdio: StdioOptions;
    if (!logFile && !detached) {
      stdio = "inherit";
    } else {
      const out = logFile ? openSync(logFile, "a") : "ignore";
      stdio = ["ignore", out, out];
    }

    const childEnvironment = buildRuntimeChildEnvironment(env);
    const spawnOptions: SpawnOptions = { env: childEnvironment, stdio, detached };
    const child = spawn(bin, spawnOptions);

    if (detached) {
      child.unref();
    }

    const startedAt = new Date().toISOString();
    writeState({
      runner: "process",
      pid: child.pid ?? -1,
      projectId,
      workspace,
      controllerUrl: env["CONTROLLER_BASE_URL"],
      originId,
      runtimeId: env["RUNTIME_ID"] ?? null,
      displayName: env["RUNTIME_DISPLAY_NAME"],
      startedAt,
      logFile,
      detached,
    });

    child.on("exit", (code, signal) => {
      const msg = code !== null ? `code ${code}` : `signal ${signal}`;
      console.log(kleur.yellow(`runtime-agent exited (${msg})`));
      const current = readState();
      if (current && current.pid === child.pid) {
        clearState();
      }
    });
    return;
  }

  const image = resolveRuntimeAgentImage();
  const containerName = `instafy-runtime-${originId}`;
  const hostPort = String(options.bindPort ?? env["ORIGIN_BIND_PORT"] ?? 54332);
  const hostBindHost = options.bindHost ?? "127.0.0.1";

  const dockerEnv = buildRuntimeChildEnvironment(env);
  dockerEnv["WORKSPACE_DIR"] = "/workspace";
  dockerEnv["CODEX_HOME"] = "/workspace/.codex";
  dockerEnv["TMPDIR"] = "/tmp";
  dockerEnv["TMP"] = "/tmp";
  dockerEnv["TEMP"] = "/tmp";
  dockerEnv["ORIGIN_BIND_HOST"] = "0.0.0.0";
  dockerEnv["CONTROLLER_BASE_URL"] = normalizeControllerUrlForDocker(env["CONTROLLER_BASE_URL"] ?? "");

  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(dockerEnv)) {
    if (typeof value !== "string" || value.length === 0) continue;
    envArgs.push("-e", `${key}=${value}`);
  }

  const runArgs = [
    "run",
    "--detach",
    "--name",
    containerName,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    `${hostBindHost}:${hostPort}:${hostPort}`,
    "-v",
    `${workspace}:/workspace`,
    ...envArgs,
    image,
  ];

  printStatus("Starting runtime-agent (docker):", image);
  printStatus("Space:", projectId);
  printStatus("Workspace:", workspace);
  printStatus("Origin:", originId);
  const started = spawnSync("docker", runArgs, { encoding: "utf8" });
  if (started.status !== 0) {
    const stderr = String(started.stderr ?? "").trim();
    const normalized = (stderr || "").toLowerCase();
    const hints: string[] = [];
    if (image.startsWith("ghcr.io/") && (normalized.includes("not found") || normalized.includes("denied") || normalized.includes("unauthorized") || normalized.includes("manifest unknown"))) {
      hints.push("If this is a GHCR image, ensure it's published and you are authenticated (`docker login ghcr.io`).");
    }
    hints.push("Override the image with `INSTAFY_RUNTIME_AGENT_IMAGE=... instafy runtime start`.");
    const suffix = hints.length > 0 ? `\n\nNext:\n- ${hints.join("\n- ")}` : "";
    throw new Error(`docker run failed: ${stderr || "unknown error"}${suffix}`);
  }
  const containerId = String(started.stdout ?? "").trim();
  if (!containerId) {
    throw new Error("docker run did not return a container id");
  }

  const startedAt = new Date().toISOString();
  writeState({
    runner: "docker",
    pid: -1,
    projectId,
    workspace,
    controllerUrl: env["CONTROLLER_BASE_URL"],
    originId,
    runtimeId: env["RUNTIME_ID"] ?? null,
    displayName: env["RUNTIME_DISPLAY_NAME"],
    startedAt,
    detached: Boolean(options.detach),
    containerId,
    containerName,
  });

  if (options.detach) {
    printStatus("Container:", containerId);
    console.log(kleur.gray(`Use: docker logs -f ${containerId}`));
    return;
  }

  const logs = spawn("docker", ["logs", "-f", containerId], { stdio: "inherit" });
  const handleExit = async () => {
    stopDockerContainer(containerId);
    const current = readState();
    if (current?.containerId === containerId) {
      clearState();
    }
  };

  process.once("SIGINT", () => {
    void handleExit();
  });
  process.once("SIGTERM", () => {
    void handleExit();
  });

  logs.on("exit", () => {
    void handleExit();
  });
}

function formatStatus(state: RuntimeState, running: boolean) {
  return {
    running,
    runner: state.runner ?? "process",
    pid: state.pid,
    containerId: state.containerId ?? null,
    containerName: state.containerName ?? null,
    projectId: state.projectId,
    workspace: state.workspace,
    controllerUrl: state.controllerUrl ?? null,
    originId: state.originId ?? null,
    runtimeId: state.runtimeId ?? null,
    displayName: state.displayName ?? null,
    startedAt: state.startedAt,
    logFile: state.logFile ?? null,
    detached: state.detached ?? false,
  };
}

async function sendOfflineBeat(state: RuntimeState): Promise<void> {
  if (!state.controllerUrl || !state.projectId || !state.originId) {
    return;
  }
  const directToken =
    normalizeToken(process.env["RUNTIME_ACCESS_TOKEN"]) ??
    normalizeToken(process.env["ORIGIN_INTERNAL_TOKEN"]);

  let bearer = directToken;
  if (!bearer) {
    const cwd = process.cwd();
    const profile = resolveActiveProfileName({ cwd });
    const configuredToken = resolveConfiguredAccessToken({ profile, cwd });
    const controllerAccessToken =
      normalizeToken(process.env["INSTAFY_ACCESS_TOKEN"]) ??
      normalizeToken(process.env["SUPABASE_ACCESS_TOKEN"]) ??
      configuredToken;
    if (controllerAccessToken) {
      const tokenSource: AccessTokenSource =
        normalizeToken(process.env["INSTAFY_ACCESS_TOKEN"]) ||
        normalizeToken(process.env["SUPABASE_ACCESS_TOKEN"])
          ? "env"
          : "config";
      try {
        bearer = await mintRuntimeAccessToken({
          controllerUrl: state.controllerUrl,
          controllerAccessToken,
          projectId: state.projectId,
          runtimeId: state.runtimeId ?? undefined,
          tokenSource,
          profile,
          cwd,
        });
      } catch (error) {
        const suffix =
          error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : "";
        console.warn(kleur.yellow(`Could not mint runtime token for offline beat${suffix}`));
      }
    }
  }

  if (!bearer) {
    return;
  }

  const offlinePayload = {
    projectId: state.projectId,
    originId: state.originId,
    status: "offline",
    latencyMs: null,
    region: "iad",
    metadata: { cli: true },
  };

  try {
    const controllerUrl = new URL(state.controllerUrl);
    if (
      (controllerUrl.protocol !== "http:" && controllerUrl.protocol !== "https:") ||
      controllerUrl.username ||
      controllerUrl.password
    ) {
      return;
    }
    await fetch(
      `${controllerUrl.toString().replace(/\/$/, "")}/projects/${encodeURIComponent(state.projectId)}/origin/presence/beat`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(offlinePayload),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch {
    // ignore failures
  }
}

async function waitForExit(pid: number, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !isProcessAlive(pid);
}

export async function runtimeStatus(options?: { json?: boolean }) {
  const state = readState();
  if (!state) {
    if (options?.json) {
      console.log(JSON.stringify({ running: false }));
    } else {
      console.log(kleur.yellow("No runtime state found."));
    }
    return;
  }

  const alive =
    state.runner === "docker"
      ? Boolean(state.containerId && dockerContainerRunning(state.containerId))
      : isProcessAlive(state.pid);
  const payload = formatStatus(state, alive);
  if (options?.json) {
    console.log(JSON.stringify(payload));
    return;
  }

  console.log(alive ? kleur.green("Runtime is running") : kleur.red("Runtime is not running"));
  printStatus("Runner:", state.runner ?? "process");
  if (state.runner === "docker") {
    if (state.containerId) printStatus("Container:", state.containerId);
    if (state.containerName) printStatus("Name:", state.containerName);
  } else {
    printStatus("PID:", String(state.pid));
  }
  printStatus("Space:", state.projectId);
  printStatus("Workspace:", state.workspace);
  if (state.controllerUrl) printStatus("Server:", state.controllerUrl);
  if (state.originId) printStatus("Origin:", state.originId);
  if (state.runtimeId) printStatus("Runtime:", state.runtimeId);
  if (state.displayName) printStatus("Display:", state.displayName);
  printStatus("Started:", state.startedAt);
  if (state.logFile) printStatus("Log:", state.logFile);
  printStatus("Detached:", state.detached ? "yes" : "no");

  if (!alive) {
    console.log(
      kleur.yellow(
        `State file exists but ${state.runner === "docker" ? "container" : "process"} is not alive.`,
      ),
    );
  }
}

export async function runtimeStop(options?: { json?: boolean }) {
  const state = readState();
  if (!state) {
    if (options?.json) {
      console.log(JSON.stringify({ stopped: false, reason: "not_running" }));
    } else {
      console.log(kleur.yellow("Runtime not running."));
    }
    return;
  }

  if (state.runner === "docker") {
    const running = Boolean(state.containerId && dockerContainerRunning(state.containerId));
    if (state.containerId) {
      stopDockerContainer(state.containerId);
    }
    clearState();
    await sendOfflineBeat(state);

    const result = { stopped: running, containerId: state.containerId ?? null };
    if (options?.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(running ? kleur.green("Runtime stopped.") : kleur.yellow("Runtime not running."));
    }
    return;
  }

  if (!isProcessAlive(state.pid)) {
    clearState();
    if (options?.json) {
      console.log(JSON.stringify({ stopped: false, reason: "not_running" }));
    } else {
      console.log(kleur.yellow("Runtime process already stopped. State cleared."));
    }
    return;
  }

  try {
    process.kill(state.pid, "SIGINT");
  } catch (error) {
    if (options?.json) {
      console.log(JSON.stringify({ stopped: false, error: String(error) }));
      return;
    }
    throw error;
  }

  const exited = await waitForExit(state.pid, 5000);
  if (!exited) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // ignore
  }
}

  const alive = isProcessAlive(state.pid);
  if (!alive) {
    clearState();
  }

  await sendOfflineBeat(state);

  const result = { stopped: !alive, pid: state.pid };
  if (options?.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(!alive ? kleur.green("Runtime stopped.") : kleur.red("Failed to stop runtime."));
  }
}

export async function runtimeToken(options: {
  project: string;
  controllerUrl?: string;
  controllerAccessToken?: string;
  runtimeId?: string;
  scopes?: string[];
  json?: boolean;
}): Promise<string | void> {
  const cwd = process.cwd();
  const controllerUrl =
    options.controllerUrl ??
    process.env["INSTAFY_SERVER_URL"] ??
    "http://127.0.0.1:8788";
  const profile = resolveActiveProfileName({ cwd });
  const stored = resolveConfiguredAccessToken({ profile, cwd });

  const tokenSource: AccessTokenSource = options.controllerAccessToken
    ? "explicit"
    : process.env["INSTAFY_ACCESS_TOKEN"] ||
        process.env["SUPABASE_ACCESS_TOKEN"]
      ? "env"
      : stored
        ? "config"
        : "none";

  const token =
    options.controllerAccessToken ??
    process.env["INSTAFY_ACCESS_TOKEN"] ??
    process.env["SUPABASE_ACCESS_TOKEN"] ??
    stored;
  if (!token) {
    throw new Error(
      "Login required. Run `instafy login` or pass --access-token / set SUPABASE_ACCESS_TOKEN.",
    );
  }
  const minted = await mintRuntimeAccessToken({
    controllerUrl,
    controllerAccessToken: token,
    projectId: options.project,
    runtimeId: options.runtimeId,
    scopes: options.scopes,
    tokenSource: tokenSource === "none" ? "env" : tokenSource,
    profile,
    cwd,
  });
  if (options.json) {
    console.log(JSON.stringify({ token: minted }));
  } else {
    console.log(minted);
  }
  return minted;
}
