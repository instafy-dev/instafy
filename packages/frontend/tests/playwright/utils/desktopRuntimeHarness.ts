import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  startRuntime,
  stopRuntime,
  mintPrivateRuntimeIdentity,
  type RuntimeStartOptions,
} from "../../../../instafy-cli/src/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../..");

interface EnsureOptions {
  controllerUrl: string;
  serviceRoleKey: string;
  ownerAccessToken: string;
  projectId: string;
}

export type OriginPresenceStatus = "online" | "offline" | "degraded";

interface RuntimeState {
  projectId: string | null;
  controllerUrl: string | null;
  serviceRoleKey: string | null;
  runtimeId: string | null;
  originId: string | null;
  endpoint: string | null;
  tunnelUrl: string | null;
  originToken: string | null;
  ensurePromise: Promise<void> | null;
  handle: RuntimeHandle | null;
}

type RuntimeHandle = {
  process: { pid: number | null; exitCode: number | null };
  stop: () => Promise<void>;
};

const state: RuntimeState = {
  projectId: null,
  controllerUrl: null,
  serviceRoleKey: null,
  runtimeId: null,
  originId: null,
  endpoint: null,
  tunnelUrl: null,
  originToken: null,
  ensurePromise: null,
  handle: null,
};

export function isDesktopOriginEnabled(): boolean {
  return true;
}

function useCliRuntime(): boolean {
  // CLI is the only supported path now.
  return true;
}

async function resolveAvailableTcpPort(host: string, preferredPort: number): Promise<number> {
  if (preferredPort <= 0) {
    throw new Error(`Invalid preferred port: ${preferredPort}`);
  }

  const canBindPreferred = await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(preferredPort, host);
  });

  if (canBindPreferred) {
    return preferredPort;
  }

  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        server.close(() => reject(new Error("Unable to resolve ephemeral port.")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

export async function ensureDesktopOriginServer(
  options: EnsureOptions,
): Promise<void> {
  if (state.ensurePromise) {
    await state.ensurePromise;
    return;
  }

  const controllerUrl = options.controllerUrl.replace(/\/$/, "");

  state.ensurePromise = ensureDesktopRuntimeInner({
    controllerUrl,
    serviceRoleKey: options.serviceRoleKey,
    ownerAccessToken: options.ownerAccessToken,
    projectId: options.projectId,
  }).finally(() => {
    state.ensurePromise = null;
  });

  await state.ensurePromise;
}

async function mintDesktopRuntimeIdentity(options: {
  controllerUrl: string;
  ownerAccessToken: string;
  projectId: string;
}): Promise<{
  runtimeId: string;
  runtimeToken: string;
}> {
  const identity = await mintPrivateRuntimeIdentity({
    controllerUrl: options.controllerUrl,
    controllerAccessToken: options.ownerAccessToken,
    projectId: options.projectId,
  });
  return { runtimeId: identity.runtimeId, runtimeToken: identity.token };
}

async function ensureDesktopRuntimeInner(options: {
  controllerUrl: string;
  serviceRoleKey: string;
  ownerAccessToken: string;
  projectId: string;
}): Promise<void> {
  const sameProject =
    state.projectId === options.projectId &&
    state.controllerUrl === options.controllerUrl;

  if (state.handle && !sameProject) {
    await stopHandle(state.handle);
    state.handle = null;
  }

  state.projectId = options.projectId;
  state.controllerUrl = options.controllerUrl;
  state.serviceRoleKey = options.serviceRoleKey;
  let identity: Awaited<ReturnType<typeof mintDesktopRuntimeIdentity>> | null = null;

  if (!state.handle) {
    // Ensure any existing CLI runtime is stopped before starting a new one.
    await stopRuntimeHandle().catch(() => {});

    const workspaceDir =
      process.env.PLAYWRIGHT_DESKTOP_RUNTIME_WORKSPACE ??
      path.join(process.cwd(), "tmp", "playwright-desktop-runtime");
    fs.mkdirSync(workspaceDir, { recursive: true });

    await ensureNoExistingCliRuntimeProcess();

    identity = await mintDesktopRuntimeIdentity({
      controllerUrl: options.controllerUrl,
      ownerAccessToken: options.ownerAccessToken,
      projectId: options.projectId,
    });
    console.info("[desktopRuntimeHarness] controller minted private desktop runtime", {
      projectId: options.projectId,
      runtimeId: identity.runtimeId,
    });
    state.runtimeId = identity.runtimeId;
    state.tunnelUrl = null;

    const handle = await startRuntimeProgrammatic({
      projectId: options.projectId,
      controllerUrl: options.controllerUrl,
      controllerAccessToken: options.ownerAccessToken,
      workspaceDir,
      runtimeId: identity.runtimeId,
      originId: identity.runtimeId,
      runtimeToken: identity.runtimeToken,
      originToken: identity.runtimeToken,
    });

    state.originToken = identity.runtimeToken;
    state.handle = handle;
  }

  let runtimeInfo: Awaited<ReturnType<typeof waitForOriginEndpoint>> | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      runtimeInfo = await waitForOriginEndpoint({
        controllerUrl: options.controllerUrl,
        serviceRoleKey: options.serviceRoleKey,
        projectId: options.projectId,
        runtimeId: state.runtimeId,
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldRetry = message.includes("timed out waiting for origin endpoint");
      if (!shouldRetry || attempt >= 1) {
        throw error;
      }
      console.warn(
        `[desktopRuntimeHarness] origin endpoint not ready; restarting CLI runtime (attempt ${
          attempt + 2
        }/2): ${message}`
      );
      await stopRuntimeHandle().catch(() => {});
      state.handle = null;

      identity = await mintDesktopRuntimeIdentity({
        controllerUrl: options.controllerUrl,
        projectId: options.projectId,
        ownerAccessToken: options.ownerAccessToken,
      });
      state.runtimeId = identity.runtimeId;
      state.tunnelUrl = null;

      const workspaceDir =
        process.env.PLAYWRIGHT_DESKTOP_RUNTIME_WORKSPACE ??
        path.join(process.cwd(), "tmp", "playwright-desktop-runtime");
      fs.mkdirSync(workspaceDir, { recursive: true });

      const handle = await startRuntimeProgrammatic({
        projectId: options.projectId,
        controllerUrl: options.controllerUrl,
        controllerAccessToken: options.ownerAccessToken,
        workspaceDir,
        runtimeId: identity.runtimeId,
        originId: identity.runtimeId,
        runtimeToken: identity.runtimeToken,
        originToken: identity.runtimeToken,
      });

      state.originToken = identity.runtimeToken;
      state.handle = handle;
    }
  }

  if (!runtimeInfo) {
    throw new Error("Failed to resolve desktop runtime origin endpoint after retry.");
  }

  state.runtimeId = runtimeInfo.runtimeId;
  state.originId = runtimeInfo.originId;
  state.endpoint = runtimeInfo.endpoint;
  if ((process.env.PLAYWRIGHT_DESKTOP_ORIGIN_USE_TUNNEL ?? "").trim() === "1") {
    state.tunnelUrl = runtimeInfo.endpoint;
  }

  try {
    const snapshot = await fetchRuntimeSnapshot({
      controllerUrl: options.controllerUrl,
      serviceRoleKey: options.serviceRoleKey,
      projectId: options.projectId,
    });
    console.info("[desktopRuntimeHarness] runtime snapshot", snapshot);
  } catch (error) {
    console.warn(
      "[desktopRuntimeHarness] failed to fetch runtime snapshot",
      error instanceof Error ? error.message : String(error),
    );
  }

  console.info(
    "[desktopRuntimeHarness] desktop runtime ready",
    {
      projectId: state.projectId,
      runtimeId: state.runtimeId,
      originId: state.originId,
      endpoint: state.endpoint,
    },
  );
}

async function fetchRuntimeSnapshot(options: {
  controllerUrl: string;
  serviceRoleKey: string;
  projectId: string;
}): Promise<Record<string, unknown>> {
  const statusRes = await fetch(
    new URL(
      `/projects/${encodeURIComponent(options.projectId)}/runtime/status`,
      options.controllerUrl,
    ),
    { headers: { authorization: `Bearer ${options.serviceRoleKey}` } },
  );
  const tunnelsRes = await fetch(
    new URL(
      `/projects/${encodeURIComponent(options.projectId)}/tunnels`,
      options.controllerUrl,
    ),
    { headers: { authorization: `Bearer ${options.serviceRoleKey}` } },
  );
  const statusJson = statusRes.ok
    ? ((await statusRes.json()) as Record<string, unknown>)
    : { error: await statusRes.text().catch(() => statusRes.statusText) };
  const tunnelsJson = tunnelsRes.ok
    ? ((await tunnelsRes.json()) as Record<string, unknown>)
    : { error: await tunnelsRes.text().catch(() => tunnelsRes.statusText) };
  return {
    statusOk: statusRes.ok,
    tunnelsOk: tunnelsRes.ok,
    runtimes: statusJson["runtimes"] ?? statusJson,
    tunnels: tunnelsJson["grants"] ?? tunnelsJson,
  };
}

export function getDesktopOriginContext(): {
  projectId: string | null;
  runtimeId: string | null;
  originId: string | null;
  endpoint: string | null;
  tunnelUrl: string | null;
} {
  return {
    projectId: state.projectId,
    runtimeId: state.runtimeId,
    originId: state.originId,
    endpoint: state.endpoint,
    tunnelUrl: state.tunnelUrl,
  };
}

export async function stopDesktopOriginServer(): Promise<void> {
  if (state.handle) {
    await stopHandle(state.handle);
    state.handle = null;
  }

  if (state.projectId && state.controllerUrl && state.serviceRoleKey && state.originId) {
    try {
      await setDesktopOriginPresenceStatus({ status: "offline" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[desktopRuntimeHarness] failed to mark origin offline: ${message}`);
    }
  }

  state.projectId = null;
  state.controllerUrl = null;
  state.serviceRoleKey = null;
  state.runtimeId = null;
  state.originId = null;
  state.endpoint = null;
  state.tunnelUrl = null;
  state.originToken = null;
}

export async function setDesktopOriginPresenceStatus(options: {
  status: OriginPresenceStatus;
  latencyMs?: number;
  region?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!state.controllerUrl || !state.projectId || !state.originId) {
    throw new Error(
      "origin not initialized; call ensureDesktopOriginServer first.",
    );
  }

  const token = state.originToken ?? state.serviceRoleKey;
  if (!token) {
    throw new Error("origin token is not available for presence update.");
  }

  const projectScopedUrl = new URL(
    `/projects/${encodeURIComponent(state.projectId)}/origin/presence/beat`,
    state.controllerUrl,
  );
  const payload = {
    projectId: state.projectId,
    originId: state.originId,
    status: options.status,
    latencyMs: options.latencyMs ?? (options.status === "offline" ? null : 120),
    region: options.region ?? "iad",
    metadata: {
      playwright: true,
      ...(options.metadata ?? {}),
    },
  } satisfies Record<string, unknown>;

  let response = await fetch(projectScopedUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 404) {
    await delay(250);
    response = await fetch(projectScopedUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `[origin] presence update failed (${response.status} ${response.statusText}): ${text}`,
    );
  }
}

async function waitForOriginEndpoint(options: {
  controllerUrl: string;
  serviceRoleKey: string;
  projectId: string;
  runtimeId: string | null;
}): Promise<{ runtimeId: string | null; originId: string; endpoint: string }>
{
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const statusUrl = new URL(
      `/projects/${encodeURIComponent(options.projectId)}/runtime/status`,
      options.controllerUrl,
    );
    const response = await fetch(statusUrl, {
      headers: {
        authorization: `Bearer ${options.serviceRoleKey}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `[origin] runtime status failed (${response.status} ${response.statusText}): ${text}`,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];

    const entry = findRuntimeEntry(runtimes, options.runtimeId);
    if (entry) {
      const originInfo = normalizeOriginBlock(entry.origin ?? entry.origin_info);
      if (originInfo) {
        const runtimeId =
          (entry.runtimeId as string | undefined) ??
          (entry.runtime_id as string | undefined) ??
          options.runtimeId ?? null;
        return {
          runtimeId,
          originId: originInfo.originId,
          endpoint: originInfo.endpoint,
        };
      }
    }

    await delay(500);
  }

  throw new Error("timed out waiting for origin endpoint");
}

function findRuntimeEntry(
  candidates: unknown[],
  runtimeId: string | null,
): Record<string, unknown> | null {
  if (runtimeId) {
    const match = candidates.find((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const value = item as Record<string, unknown>;
      const id =
        typeof value.runtimeId === "string"
          ? value.runtimeId
          : typeof value.runtime_id === "string"
            ? value.runtime_id
            : null;
      return id === runtimeId;
    });
    if (match && typeof match === "object") {
      return match as Record<string, unknown>;
    }
  }

  const fallback = candidates.find((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const value = item as Record<string, unknown>;
    const origin = value.origin ?? value.origin_info;
    if (!origin || typeof origin !== "object") {
      return false;
    }
    const mode = (origin as Record<string, unknown>).mode ?? (origin as Record<string, unknown>).origin_mode;
    return typeof mode === "string" && mode.toLowerCase() === "desktop";
  });

  return fallback && typeof fallback === "object"
    ? (fallback as Record<string, unknown>)
    : null;
}

async function stopHandle(handle: RuntimeHandle): Promise<void> {
  await stopRuntimeHandle();
}

async function startRuntimeProgrammatic(options: {
  projectId: string;
  controllerUrl: string;
  controllerAccessToken: string;
  workspaceDir: string;
  runtimeToken: string;
  originToken: string;
  runtimeId?: string;
  runtimeLeaseId?: string;
  originId?: string;
}): Promise<RuntimeHandle> {
  const explicitEndpoint =
    process.env.PLAYWRIGHT_DESKTOP_ORIGIN_ENDPOINT &&
    process.env.PLAYWRIGHT_DESKTOP_ORIGIN_ENDPOINT.trim().length > 0
      ? process.env.PLAYWRIGHT_DESKTOP_ORIGIN_ENDPOINT.trim()
      : null;
  const useTunnel =
    (process.env.PLAYWRIGHT_DESKTOP_ORIGIN_USE_TUNNEL ?? "").trim() === "1";

  const bindHost = process.env.ORIGIN_BIND_HOST || "127.0.0.1";
  const explicitBindPortRaw = (process.env.ORIGIN_BIND_PORT ?? "").trim();
  const preferredPort = explicitBindPortRaw ? Number(explicitBindPortRaw) : 54332;
  const bindPort = explicitBindPortRaw
    ? preferredPort
    : await resolveAvailableTcpPort(bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost, preferredPort);
  const endpointHost =
    bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "[::1]" : bindHost;
  const originEndpoint = explicitEndpoint
    ? explicitEndpoint
    : useTunnel
      ? null
      : `${endpointHost.startsWith("http") ? "" : "http://"}${endpointHost}:${bindPort}`;

  const logFile = path.join(options.workspaceDir, "instafy-cli-runtime.log");
  fs.mkdirSync(options.workspaceDir, { recursive: true });
  try {
    if (fs.existsSync(logFile)) {
      fs.rmSync(logFile);
    }
  } catch {
    // ignore cleanup failure
  }

  // Ensure Codex config is isolated to avoid inheriting bad defaults (e.g., invalid reasoning effort).
  const codexHome = path.join(options.workspaceDir, ".codex");
  process.env.CODEX_HOME = codexHome;
  try {
    fs.mkdirSync(codexHome, { recursive: true });
    const codexConfigPath = path.join(codexHome, "config.toml");
    if (fs.existsSync(codexConfigPath)) {
      fs.rmSync(codexConfigPath);
    }
    const proxyAuthPath = path.join(repoRoot, "tmp", "proxy-codex", "auth.json");
    if (fs.existsSync(proxyAuthPath)) {
      process.env.CODEX_AUTH_PATH = proxyAuthPath;
    }
  } catch {
    // ignore
  }

  // Ensure codex/proxy endpoints point to the local proxy on host.
  const proxyBase = process.env.PROXY_BASE_URL || "http://127.0.0.1:8789";
  process.env.PROXY_BASE_URL = proxyBase;
  process.env.OPENAI_BASE_URL = `${proxyBase.replace(/\/+$/, "")}/v1`;
  const responsesPath = `${proxyBase.replace(/\/+$/, "")}/backend-api/codex/responses`;
  process.env.CODEX_CHATGPT_ENDPOINT = responsesPath;
  process.env.CODEX_PROXY_CHATGPT_ENDPOINT = responsesPath;

  const startOptions: RuntimeStartOptions = {
    project: options.projectId,
    controllerUrl: options.controllerUrl,
    controllerAccessToken: options.controllerAccessToken,
    runtimeToken: options.runtimeToken,
    originToken: options.originToken,
    workspace: options.workspaceDir,
    provider: "self-hosted",
    detach: true,
    logFile,
    bindHost,
    bindPort,
    proxyBaseUrl: proxyBase,
  };

  if (options.originId) startOptions.originId = options.originId;
  if (options.runtimeId) startOptions.runtimeId = options.runtimeId;
  if (options.runtimeLeaseId) startOptions.runtimeLeaseId = options.runtimeLeaseId;
  if (originEndpoint) startOptions.originEndpoint = originEndpoint;

  await startRuntime(startOptions);

  return {
    process: { pid: null, exitCode: null },
    stop: stopRuntimeHandle,
  };
}

async function stopRuntimeHandle(): Promise<void> {
  const previousControllerAccessToken = process.env.CONTROLLER_ACCESS_TOKEN;
  const previousRuntimeAccessToken = process.env.RUNTIME_ACCESS_TOKEN;
  const previousOriginInternalToken = process.env.ORIGIN_INTERNAL_TOKEN;

  try {
    // Ensure `instafy runtime stop` can send an offline presence beat without relying on
    // `instafy login` (which may not be configured in test environments).
    if (state.serviceRoleKey) {
      process.env.CONTROLLER_ACCESS_TOKEN = state.serviceRoleKey;
    }
    if (state.originToken) {
      process.env.ORIGIN_INTERNAL_TOKEN = state.originToken;
      process.env.RUNTIME_ACCESS_TOKEN = state.originToken;
    }
    await stopRuntime({ json: true });
  } finally {
    if (typeof previousControllerAccessToken === "string") {
      process.env.CONTROLLER_ACCESS_TOKEN = previousControllerAccessToken;
    } else {
      delete process.env.CONTROLLER_ACCESS_TOKEN;
    }
    if (typeof previousRuntimeAccessToken === "string") {
      process.env.RUNTIME_ACCESS_TOKEN = previousRuntimeAccessToken;
    } else {
      delete process.env.RUNTIME_ACCESS_TOKEN;
    }
    if (typeof previousOriginInternalToken === "string") {
      process.env.ORIGIN_INTERNAL_TOKEN = previousOriginInternalToken;
    } else {
      delete process.env.ORIGIN_INTERNAL_TOKEN;
    }
    await ensureNoExistingCliRuntimeProcess();
  }
}

function normalizeOriginBlock(raw: unknown):
  | { originId: string; endpoint: string }
  | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const originId =
    typeof value.originId === "string"
      ? value.originId
      : typeof value.origin_id === "string"
        ? value.origin_id
        : null;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint : null;
  if (!originId || !endpoint) {
    return null;
  }
  return {
    originId,
    endpoint: endpoint.replace(/\/$/, ""),
  };
}

async function ensureNoExistingCliRuntimeProcess(): Promise<void> {
  const instafyDir = path.join(os.homedir(), ".instafy");
  const statePath = path.join(instafyDir, "cli-runtime-state.json");

  let pid: number | null = null;
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    pid = typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    // no state file or unreadable; nothing to clear
  }

  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGINT");
    } catch {}
    await delay(500);
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    await delay(250);
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }

  try {
    fs.rmSync(statePath);
  } catch {
    // ignore cleanup failures
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
