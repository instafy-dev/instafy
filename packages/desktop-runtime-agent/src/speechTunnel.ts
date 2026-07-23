import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { ensureRatholeBinary } from "./rathole.js";
import { supportsSpeechTunnelStatusUpdates } from "./speechTunnelAuth.js";

export interface StartSpeechTunnelOptions {
  controllerUrl: string;
  projectId: string;
  controllerAccessToken: string;
  localPort?: number;
  readyPath?: string;
  readyTimeoutMs?: number;
  rathole?: {
    version?: string;
    cacheDir?: string;
    logger?: (message: string) => void;
  };
  logger?: (message: string) => void;
}

export interface DesktopSpeechTunnelHandle {
  pid: number;
  process: ChildProcess;
  projectId: string;
  tunnelId: string;
  publicUrl: string;
  hostname: string | null;
  localPort: number;
  readyPath: string;
  stop: () => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

type TunnelGrantResponse = {
  tunnelId?: string;
  hostname?: string | null;
  url?: string | null;
  credentials?: Record<string, unknown> | string | null;
};

const TUNNEL_REQUEST_TIMEOUT_MS = 10_000;
const TUNNEL_REQUEST_MAX_ATTEMPTS = 3;
const TUNNEL_START_RETRY_BASE_DELAY_MS = 1_000;
const TUNNEL_START_RETRY_MAX_DELAY_MS = 3_000;
const TUNNEL_START_RETRY_OUTPUT_LIMIT = 8_000;
const RATHOLE_SERVICE_PROPAGATION_PATTERNS = [
  /authentication failed:.*service not exist/i,
  /service not exist/i,
];

type TunnelStatusUpdateOutcome = "ok" | "unsupported" | "ignored";

function cleanUrl(raw: string) {
  return raw.replace(/\/+$/, "");
}

function normalizeReadyPath(raw: string | null | undefined) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return "/health";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isLocalController(raw: string) {
  try {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return raw.includes("127.0.0.1") || raw.includes("localhost");
  }
}

function normalizeIpLiteral(raw: string | null | undefined) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^\[/, "").replace(/\]$/, "");
}

function rewriteTunnelServerForLocalController(rawServer: string, controllerUrl: string) {
  const trimmed = rawServer.trim();
  if (!trimmed || !isLocalController(controllerUrl)) {
    return trimmed;
  }
  try {
    const parsed = new URL(`tcp://${trimmed}`);
    const host = normalizeIpLiteral(parsed.hostname);
    const port = parsed.port;
    if (!host || !port) {
      return trimmed;
    }
    const configuredIngressIpv4 = normalizeIpLiteral(process.env.INGRESS_IPV4);
    if (
      host === "host.docker.internal" ||
      host === "0.0.0.0" ||
      (configuredIngressIpv4 && host === configuredIngressIpv4)
    ) {
      return `127.0.0.1:${port}`;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

async function requestTunnel(options: StartSpeechTunnelOptions): Promise<TunnelGrantResponse> {
  const requestUrl =
    `${cleanUrl(options.controllerUrl)}/projects/${encodeURIComponent(options.projectId)}/tunnels/request`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= TUNNEL_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, TUNNEL_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.controllerAccessToken}`,
        },
        body: JSON.stringify({
          metadata: {
            localPort: options.localPort ?? 8796,
            source: "desktop-speech-tunnel",
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).trim();
        const message = `Speech tunnel request failed (${response.status})${detail ? `: ${detail}` : ""}`;
        if (
          attempt < TUNNEL_REQUEST_MAX_ATTEMPTS &&
          (response.status >= 500 || response.status === 408 || response.status === 429)
        ) {
          lastError = new Error(message);
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }
        throw new Error(message);
      }

      return (await response.json()) as TunnelGrantResponse;
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Speech tunnel request timed out after ${TUNNEL_REQUEST_TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      lastError = new Error(message);
      if (attempt >= TUNNEL_REQUEST_MAX_ATTEMPTS) {
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error("Speech tunnel request failed.");
}

async function updateTunnelStatus(
  options: StartSpeechTunnelOptions,
  tunnelId: string,
  status: string,
  metadata?: Record<string, unknown>,
): Promise<TunnelStatusUpdateOutcome> {
  try {
    const response = await fetch(
      `${cleanUrl(options.controllerUrl)}/projects/${encodeURIComponent(options.projectId)}/tunnels/${encodeURIComponent(tunnelId)}/status`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.controllerAccessToken}`,
        },
        body: JSON.stringify({
          status,
          metadata: metadata ?? undefined,
        }),
      },
    );
    if (response.status === 401 || response.status === 403) {
      return "unsupported";
    }
    return response.ok ? "ok" : "ignored";
  } catch {
    return "ignored";
  }
}

async function revokeTunnel(options: StartSpeechTunnelOptions, tunnelId: string) {
  try {
    await fetch(
      `${cleanUrl(options.controllerUrl)}/projects/${encodeURIComponent(options.projectId)}/tunnels/${encodeURIComponent(tunnelId)}/revoke`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.controllerAccessToken}`,
        },
        body: JSON.stringify({ metadata: { reason: "desktop-speech-tunnel:stop" } }),
      },
    );
  } catch {
    // best effort only
  }
}

function isRetryableTunnelStartupFailure(error: unknown, output: string) {
  const detail = [
    error instanceof Error ? error.message : String(error),
    output,
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return RATHOLE_SERVICE_PROPAGATION_PATTERNS.some((pattern) => pattern.test(detail));
}

function resolveTunnelStartRetryDelayMs(attempt: number) {
  return Math.min(
    TUNNEL_START_RETRY_BASE_DELAY_MS * Math.max(attempt, 1),
    TUNNEL_START_RETRY_MAX_DELAY_MS,
  );
}

function buildIngressReadinessTarget(controllerUrl: string, publicUrl: string) {
  const parsedPublicUrl = new URL(publicUrl);
  const protocol = parsedPublicUrl.protocol === "https:" ? "https:" : "http:";
  if (isLocalController(controllerUrl)) {
    const port = parsedPublicUrl.port || (protocol === "https:" ? "443" : "80");
    return {
      requestUrl: new URL(`${protocol}//127.0.0.1:${port}`),
      hostHeader: parsedPublicUrl.host,
    };
  }
  return {
    requestUrl: parsedPublicUrl,
    hostHeader: null,
  };
}

async function fetchTunnelReady(target: { requestUrl: URL; hostHeader: string | null }, pathname: string) {
  const requestUrl = new URL(pathname, target.requestUrl);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const headers = target.hostHeader ? { host: target.hostHeader } : {};

  return await new Promise<{ ok: boolean; status: number; body: string }>((resolve, reject) => {
    const request = transport.request(
      requestUrl,
      {
        method: "GET",
        headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(2_000, () => {
      request.destroy(new Error("timed out"));
    });
    request.end();
  });
}

type SpawnedTunnelClient = {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  getOutput: () => string;
};

function buildTunnelClientEnv(env: NodeJS.ProcessEnv = process.env) {
  const allowedKeys = [
    "HOME",
    "LOGNAME",
    "USER",
    "USERNAME",
    "USERPROFILE",
    "PATH",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SHELL",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "RUST_LOG",
    "RUST_BACKTRACE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NO_COLOR",
    "FORCE_COLOR",
    "TERM",
  ];
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      childEnv[key] = value;
    }
  }
  return childEnv;
}

function shouldSuppressTransientTunnelLog(text: string) {
  return RATHOLE_SERVICE_PROPAGATION_PATTERNS.some((pattern) => pattern.test(text));
}

function spawnTunnelClient(options: {
  ratholeBin: string;
  configPath: string;
  workdir: string;
  logger: (message: string) => void;
}) {
  let recentOutput = "";
  const child = spawn(options.ratholeBin, ["-c", options.configPath], {
    cwd: options.workdir,
    env: buildTunnelClientEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const appendOutput = (text: string) => {
    if (!text) {
      return;
    }
    recentOutput = `${recentOutput}\n${text}`.slice(-TUNNEL_START_RETRY_OUTPUT_LIMIT);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      appendOutput(text);
      if (!shouldSuppressTransientTunnelLog(text)) {
        options.logger(`[desktop-speech-tunnel] ${text}`);
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      appendOutput(text);
      if (!shouldSuppressTransientTunnelLog(text)) {
        options.logger(`[desktop-speech-tunnel] ${text}`);
      }
    }
  });

  return {
    child,
    exited: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    }),
    getOutput: () => recentOutput.trim(),
  } satisfies SpawnedTunnelClient;
}

function buildRatholeConfig(credentials: Record<string, unknown>, port: number) {
  const server = typeof credentials.server === "string" ? credentials.server : "";
  const token = typeof credentials.token === "string" ? credentials.token : "";
  const service =
    typeof credentials.service === "string"
      ? credentials.service
      : typeof credentials.serviceName === "string"
        ? credentials.serviceName
        : "runtime";
  const protocol = typeof credentials.protocol === "string" ? credentials.protocol : "tcp";
  if (!server || !token) {
    throw new Error("Speech tunnel credentials missing server/token.");
  }
  return `[client]
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
`;
}

async function waitForTunnelReadiness(options: {
  controllerUrl: string;
  publicUrl: string;
  readyPath: string;
  readyTimeoutMs: number;
  child: ChildProcess;
}) {
  const target = buildIngressReadinessTarget(options.controllerUrl, options.publicUrl);
  const deadline = Date.now() + Math.max(options.readyTimeoutMs, 1_000);
  let lastError = "unknown error";

  while (Date.now() < deadline) {
    if (options.child.exitCode !== null) {
      throw new Error(`rathole exited with code ${options.child.exitCode} before the speech tunnel became ready`);
    }

    try {
      const response = await fetchTunnelReady(target, options.readyPath);
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}${response.body ? `: ${response.body.slice(0, 200)}` : ""}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for tunnel readiness on ${options.readyPath}: ${lastError}`);
}

export async function startSpeechTunnel(
  options: StartSpeechTunnelOptions,
): Promise<DesktopSpeechTunnelHandle> {
  const logger = options.logger ?? options.rathole?.logger ?? (() => undefined);
  const localPort = options.localPort ?? 8796;
  const readyPath = normalizeReadyPath(options.readyPath);
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;

  logger(
    `[desktop-speech-tunnel] requesting tunnel grant for ${options.projectId} (localPort=${localPort}, readyPath=${readyPath})`,
  );

  const grant = await requestTunnel({
    ...options,
    localPort,
    readyPath,
    readyTimeoutMs,
  });

  const credentials =
    typeof grant.credentials === "string"
      ? (JSON.parse(grant.credentials) as Record<string, unknown>)
      : grant.credentials && typeof grant.credentials === "object"
        ? (grant.credentials as Record<string, unknown>)
        : null;
  if (!credentials) {
    throw new Error("Speech tunnel response missing credentials.");
  }
  const resolvedServer =
    typeof credentials.server === "string"
      ? rewriteTunnelServerForLocalController(credentials.server, options.controllerUrl)
      : null;
  if (resolvedServer && resolvedServer !== credentials.server) {
    credentials.server = resolvedServer;
    logger(
      `[desktop-speech-tunnel] rewrote local ingress address to ${resolvedServer} for local controller access`,
    );
  }

  const tunnelId =
    typeof grant.tunnelId === "string" && grant.tunnelId.trim().length > 0
      ? grant.tunnelId.trim()
      : "";
  if (!tunnelId) {
    throw new Error("Speech tunnel response missing tunnel id.");
  }

  const publicUrl =
    (typeof grant.url === "string" && grant.url.trim()) ||
    (typeof grant.hostname === "string" && grant.hostname.trim() ? `https://${grant.hostname.trim()}` : "");
  if (!publicUrl) {
    throw new Error("Speech tunnel response missing public URL.");
  }

  logger(
    `[desktop-speech-tunnel] granted tunnel ${tunnelId} -> ${publicUrl}`,
  );

  const configBody = buildRatholeConfig(credentials, localPort);
  const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-speech-tunnel-"));
  const configPath = path.join(workdir, "rathole.toml");
  await fs.promises.writeFile(configPath, configBody, "utf8");

  const ratholeBin = await ensureRatholeBinary({
    version: options.rathole?.version,
    cacheDir: options.rathole?.cacheDir,
    logger: options.rathole?.logger,
  });
  let statusUpdatesSupported = supportsSpeechTunnelStatusUpdates(
    options.controllerAccessToken,
    options.projectId,
  );
  if (!statusUpdatesSupported) {
    logger(
      "[desktop-speech-tunnel] skipping controller tunnel status posts because the current token is not service-role or runtime-scoped auth",
    );
  }

  const reportTunnelStatus = async (status: string, metadata?: Record<string, unknown>) => {
    if (!statusUpdatesSupported) {
      return;
    }
    const outcome = await updateTunnelStatus(options, tunnelId, status, metadata);
    if (outcome === "unsupported") {
      statusUpdatesSupported = false;
      logger(
        "[desktop-speech-tunnel] controller rejected tunnel status posts for this token; disabling further status updates",
      );
    }
  };

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = () => {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = (async () => {
      await revokeTunnel(options, tunnelId);
      await fs.promises.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    })();
    return cleanupPromise;
  };
  const startupDeadline = Date.now() + Math.max(readyTimeoutMs, 1_000);
  let attempt = 0;
  let activeClient: SpawnedTunnelClient | null = null;
  try {
    while (Date.now() < startupDeadline) {
      attempt += 1;
      const client = spawnTunnelClient({
        ratholeBin,
        configPath,
        workdir,
        logger,
      });
      try {
        await waitForTunnelReadiness({
          controllerUrl: options.controllerUrl,
          publicUrl,
          readyPath,
          readyTimeoutMs: startupDeadline - Date.now(),
          child: client.child,
        });
        activeClient = client;
        await reportTunnelStatus("active", {
          readyPath,
          readyCheckedAt: new Date().toISOString(),
          startupAttempts: attempt,
        });
        break;
      } catch (error) {
        if (!client.child.killed && client.child.exitCode === null) {
          client.child.kill("SIGTERM");
        }
        await client.exited.catch(() => undefined);
        const retryable = isRetryableTunnelStartupFailure(error, client.getOutput());
        if (retryable && Date.now() < startupDeadline - 250) {
          const delayMs = Math.min(
            resolveTunnelStartRetryDelayMs(attempt),
            Math.max(startupDeadline - Date.now(), 250),
          );
          logger(
            `[desktop-speech-tunnel] rathole client exited before ingress propagation completed; retrying in ${delayMs}ms (attempt ${attempt})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        await reportTunnelStatus("failed", {
          reason,
          readyPath,
          startupAttempts: attempt,
        });
        throw error;
      }
    }
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }

  if (!activeClient) {
    const reason = `Timed out starting speech tunnel client after ${attempt} attempts`;
    await reportTunnelStatus("failed", {
      reason,
      readyPath,
      startupAttempts: attempt,
    });
    await cleanup().catch(() => undefined);
    throw new Error(reason);
  }

  const child = activeClient.child;
  const exited = activeClient.exited.then(async ({ code, signal }) => {
    await cleanup();
    return { code, signal };
  });

  let stopping = false;
  return {
    pid: child.pid ?? -1,
    process: child,
    projectId: options.projectId,
    tunnelId,
    publicUrl: publicUrl.replace(/\/+$/, ""),
    hostname:
      typeof grant.hostname === "string" && grant.hostname.trim().length > 0
        ? grant.hostname.trim()
        : null,
    localPort,
    readyPath,
    stop: async () => {
      if (stopping) {
        await exited;
        return;
      }
      stopping = true;
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await exited;
    },
    exited,
  };
}
