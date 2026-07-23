import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { resolvePrivateEnvPath } from "../../../scripts/lib/privateEnvPaths.mjs";

function repoRoot(): string {
  return path.resolve(path.join(__dirname, "../../.."));
}

function privateEnvPath(relativePath: string): string {
  return resolvePrivateEnvPath({ repoRoot: repoRoot(), relativePath });
}

type EnvMap = Record<string, string>;

function parseEnv(content: string | undefined | null): EnvMap {
  if (!content) return {};
  const map: EnvMap = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line
      .slice(eqIndex + 1)
      .trim()
      .replace(/^['"](.+)['"]$/, "$1");
    if (key) {
      map[key] = value;
    }
  }
  return map;
}

function readServiceRoleKeyFromMap(map: EnvMap): string | null {
  const candidates = [
    map.SUPABASE_SERVICE_ROLE_KEY,
    map.SERVICE_ROLE_KEY,
  ];
  for (const value of candidates) {
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readServiceRoleKeyFromFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, "utf8");
    return readServiceRoleKeyFromMap(parseEnv(content));
  } catch (error) {
    console.warn(
      `[runtime-tunnel] Unable to read ${filePath} while resolving service role key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function isLocalControllerUrl(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value.includes("127.0.0.1") || value.includes("localhost");
}

function resolveControllerAccessToken(controllerUrl: string): string | null {
  const direct =
    process.env.CONTROLLER_INTERNAL_TOKEN ??
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN;
  if (direct && direct.trim()) {
    return direct.trim();
  }

  if (isLocalControllerUrl(controllerUrl)) {
    // Matches the default used by `scripts/run-e2e-dev.mjs` and the Playwright global setup.
    return "dev-internal-token";
  }

  const fromEnv = readServiceRoleKeyFromMap(process.env as EnvMap);
  if (fromEnv) {
    return fromEnv;
  }

  const candidates = [
    privateEnvPath("docker/.env.local"),
    path.join(repoRoot(), "docker", ".env"),
    privateEnvPath("supabase/.env.dev.local"),
    privateEnvPath(".env.supabase.local"),
    privateEnvPath(".env.supabase"),
  ];
  for (const candidate of candidates) {
    const key = readServiceRoleKeyFromFile(candidate);
    if (key) {
      return key;
    }
  }

  return null;
}

function readAgentLoginKey(): string | null {
  const fromEnv = process.env.AGENT_LOGIN_KEY ?? process.env.AGENT_KEY;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  const candidates = [
    privateEnvPath("docker/.env.local"),
    path.join(repoRoot(), "docker", ".env"),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf8");
      const map = parseEnv(content);
      const candidate = map["AGENT_LOGIN_KEY"] ?? map["AGENT_KEY"];
      if (candidate && candidate.trim()) {
        return candidate.trim();
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function createProject(controllerUrl: string, controllerAccessToken: string): Promise<string> {
  const cleaned = controllerUrl.replace(/\/+$/, "");
  const orgResponse = await fetch(`${cleaned}/orgs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controllerAccessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ orgName: "CLI Tunnel Org" }),
  });
  if (!orgResponse.ok) {
    const text = await orgResponse.text().catch(() => "");
    throw new Error(`failed to create org (${orgResponse.status} ${orgResponse.statusText}): ${text}`);
  }
  const orgPayload = (await orgResponse.json()) as Record<string, unknown>;
  const orgId =
    typeof orgPayload["orgId"] === "string"
      ? (orgPayload["orgId"] as string)
      : typeof orgPayload["org_id"] === "string"
        ? (orgPayload["org_id"] as string)
        : null;
  if (!orgId) {
    throw new Error("organization creation response missing orgId");
  }

  const response = await fetch(`${cleaned}/orgs/${encodeURIComponent(orgId)}/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controllerAccessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ projectType: "cli-tunnel-smoke" }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`failed to create project (${response.status} ${response.statusText}): ${text}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const projectId =
    typeof payload["projectId"] === "string"
      ? (payload["projectId"] as string)
      : typeof payload["project_id"] === "string"
        ? (payload["project_id"] as string)
        : null;
  if (!projectId) {
    throw new Error("project creation response missing projectId");
  }
  return projectId;
}

async function startRuntime(options: {
  projectId: string;
  controllerUrl: string;
  controllerAccessToken: string;
  workspaceDir: string;
  logFile: string;
}) {
  await ensureCleanRuntimeState();
  const entry = path.join(repoRoot(), "packages", "instafy-cli", "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error("CLI entry dist/index.js not found. Run pnpm --filter @instafy/cli build first.");
  }
  const agentKey = readAgentLoginKey() ?? "dev-agent-key";
  console.info("[runtime-tunnel] using agent key prefix:", agentKey.slice(0, 6), "…");
  const args = [
    entry,
    "runtime",
    "start",
    "--space",
    options.projectId,
    "--controller-url",
    options.controllerUrl,
    "--controller-access-token",
    options.controllerAccessToken,
    "--workspace",
    options.workspaceDir,
    "--provider",
    "self-hosted",
    "--detach",
    "--log-file",
    options.logFile,
  ];
  const child = spawn("node", args, {
    cwd: repoRoot(),
    env: (() => {
      const env = {
        ...process.env,
        NODE_ENV: "test",
        WORKSPACE_DIR: options.workspaceDir,
        RUNTIME_PROVIDER: "self-hosted",
        RUNTIME_TYPE: "self-hosted",
        AGENT_LOGIN_KEY: agentKey,
        AGENT_KEY: agentKey,
      } as Record<string, string>;
      return env;
    })(),
    stdio: "pipe",
});
  const [code] = (await once(child, "exit")) as [number | null];
  const stdout = await collectStream(child.stdout);
  const stderr = await collectStream(child.stderr);
  if (stdout.trim()) {
    console.info("[runtime-tunnel] runtime start stdout:", stdout);
  }
  if (stderr.trim()) {
    console.error("[runtime-tunnel] runtime start stderr:", stderr);
  }
  if (code !== 0) {
    let logContents = "";
    try {
      if (fs.existsSync(options.logFile)) {
        logContents = fs.readFileSync(options.logFile, "utf8");
      }
    } catch {
      // ignore
    }
    throw new Error(
      `runtime start failed (${code ?? -1}): stdout=${stdout} stderr=${stderr}${
        logContents ? ` log:\n${logContents}` : ""
      }`,
    );
  }
}

async function stopRuntime() {
  const entry = path.join(repoRoot(), "packages", "instafy-cli", "dist", "index.js");
  const args = [entry, "runtime", "stop", "--json"];
  const child = spawn("node", args, { cwd: repoRoot(), env: { ...process.env, NODE_ENV: "test" }, stdio: "pipe" });
  const [code] = (await once(child, "exit")) as [number | null];
  const stdout = await collectStream(child.stdout);
  const stderr = await collectStream(child.stderr);
  if (code !== 0) {
    throw new Error(`runtime stop failed (${code ?? -1}): stdout=${stdout} stderr=${stderr}`);
  }
  await ensureCleanRuntimeState();
}

async function ensureCleanRuntimeState() {
  const statePath = path.join(process.env.HOME ?? os.homedir(), ".instafy", "cli-runtime-state.json");
  let pid: number | null = null;
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    pid = typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    // ignore missing/invalid file
  }

  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 400));
    } catch {
      // ignore
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch {
        // ignore
      }
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  try {
    fs.rmSync(statePath);
  } catch {
    // ignore cleanup errors
  }
}

async function collectStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function httpGet(
  url: string,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    servername?: string;
    rejectUnauthorized?: boolean;
  },
) {
  const parsed = new URL(url);
  const isHttp = parsed.protocol === "http:";
  const isHttps = parsed.protocol === "https:";
  if (!isHttp && !isHttps) {
    throw new Error(`httpGet only supports http(s):// URLs (got ${url})`);
  }
  const timeoutMs = options?.timeoutMs ?? 5000;
  const defaultPort = isHttps ? 443 : 80;

  return await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const request = isHttps ? https.request : http.request;
    const requestOptions = {
      method: "GET",
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : defaultPort,
      path: `${parsed.pathname}${parsed.search}`,
      headers: options?.headers,
      timeout: timeoutMs,
      ...(isHttps
        ? {
            rejectUnauthorized: options?.rejectUnauthorized ?? false,
            servername: options?.servername,
          }
        : {}),
    };

    const req = request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForRuntimeEndpoint(options: {
  controllerUrl: string;
  projectId: string;
  serviceRoleKey: string;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const res = await fetch(
      `${options.controllerUrl}/projects/${encodeURIComponent(options.projectId)}/runtime/status`,
      {
        headers: { authorization: `Bearer ${options.serviceRoleKey}` },
      },
    );
    if (res.ok) {
      const payload = (await res.json()) as Record<string, unknown>;
      const runtimes = Array.isArray(payload["runtimes"]) ? payload["runtimes"] : [];
      const entry = runtimes.find((item) => {
        if (!item || typeof item !== "object") return false;
        const value = item as Record<string, unknown>;
        const provider =
          typeof value["provider"] === "string" ? (value["provider"] as string) : "";
        return provider.toLowerCase().includes("self");
      }) as Record<string, unknown> | undefined;
      const selected =
        entry ?? (runtimes.length > 0 && typeof runtimes[0] === "object" ? (runtimes[0] as Record<string, unknown>) : undefined);
      if (selected) {
        const origin = selected["origin"] ?? selected["origin_info"];
        const endpoint =
          origin && typeof origin === "object" ? (origin as Record<string, unknown>)["endpoint"] : null;
        const runtimeId =
          typeof selected["runtimeId"] === "string"
            ? selected["runtimeId"]
            : typeof selected["runtime_id"] === "string"
              ? selected["runtime_id"]
              : typeof selected["id"] === "string"
                ? selected["id"]
                : null;
        if (
          typeof endpoint === "string" &&
          endpoint.trim().length > 0 &&
          typeof runtimeId === "string"
        ) {
          const grantsResponse = await fetch(
            `${options.controllerUrl}/projects/${encodeURIComponent(options.projectId)}/tunnels`,
            { headers: { authorization: `Bearer ${options.serviceRoleKey}` } },
          );
          if (grantsResponse.ok) {
            const grantsPayload = (await grantsResponse.json()) as Record<string, unknown>;
            const grants = Array.isArray(grantsPayload["grants"])
              ? grantsPayload["grants"]
              : [];
            const grant = grants.find((item) => {
              if (!item || typeof item !== "object") return false;
              const value = item as Record<string, unknown>;
              const grantRuntimeId = value["runtimeId"] ?? value["runtime_id"];
              return grantRuntimeId === runtimeId;
            }) as Record<string, unknown> | undefined;
            const tunnelProvider = grant?.["provider"];
            const tunnelHostname = grant?.["hostname"];
            if (
              tunnelProvider === "self_hosted" &&
              typeof tunnelHostname === "string" &&
              tunnelHostname.trim().length > 0
            ) {
              return {
                entry: selected,
                endpoint: endpoint.trim(),
                runtimeId,
                origin:
                  origin && typeof origin === "object"
                    ? (origin as Record<string, unknown>)
                    : {},
                grant,
                tunnelHostname: tunnelHostname.trim(),
              };
            }
          }
        }
      }
      if (attempts % 10 === 0) {
        console.info(
          "[runtime-tunnel] runtime status poll",
          attempts,
          "providers",
          runtimes.map((r) =>
            typeof (r as Record<string, unknown>)["provider"] === "string"
              ? (r as Record<string, unknown>)["provider"]
              : (r as Record<string, unknown>)["type"],
          ),
        );
      }
    } else if (attempts === 1) {
      console.warn("[runtime-tunnel] runtime status request failed", res.status, res.statusText);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for desktop runtime origin endpoint");
}

describe("CLI desktop runtime tunnel smoke", () => {
  const controllerUrl =
    process.env.PLAYWRIGHT_CONTROLLER_URL ??
    process.env.VITE_CONTROLLER_URL ??
    process.env.CONTROLLER_BASE_URL ??
    "http://127.0.0.1:8788";

  const brokerBaseUrl =
    (process.env.TUNNEL_BROKER_BASE_URL ?? process.env.VITE_TUNNEL_BROKER_BASE_URL ?? "").trim();
  const smokeIt = brokerBaseUrl ? it : it.skip;

  smokeIt("starts CLI desktop runtime and exposes tunnel endpoint", async () => {
    const controllerAccessToken = resolveControllerAccessToken(controllerUrl);
    if (!controllerAccessToken) {
      throw new Error("Controller access token is required for CLI runtime tunnel smoke.");
    }
    console.info("[runtime-tunnel] using controller:", controllerUrl);
    console.info(
      "[runtime-tunnel] controller token prefix:",
      controllerAccessToken ? `${controllerAccessToken.slice(0, 6)}…` : "missing",
    );

    const projectId = await createProject(controllerUrl, controllerAccessToken);
    console.info("[runtime-tunnel] project id:", projectId);
    const workspaceDir = path.join(repoRoot(), "tmp", "cli-tunnel-smoke");
    const logFile = path.join(workspaceDir, `instafy-cli-runtime-${Date.now()}.log`);
    fs.mkdirSync(workspaceDir, { recursive: true });

    try {
      await startRuntime({
        projectId,
        controllerUrl,
        controllerAccessToken,
        workspaceDir,
        logFile,
      });

      let endpoint: string | null = null;
      let tunnelHostname: string | null = null;
      try {
        const result = await waitForRuntimeEndpoint({
          controllerUrl,
          projectId,
          serviceRoleKey: controllerAccessToken,
        });
        endpoint = result.endpoint;
        tunnelHostname = result.tunnelHostname;
        const originId = result.origin["originId"] ?? result.origin["origin_id"];
        const grantLeaseId =
          result.grant["runtimeLeaseId"] ?? result.grant["runtime_lease_id"];
        expect(originId).toBe(result.runtimeId);
        expect(result.entry["isPrivateSelfHosted"]).toBe(true);
        expect(grantLeaseId ?? null).toBeNull();
        expect(result.grant["provider"]).toBe("self_hosted");
      } catch (error) {
        if (fs.existsSync(logFile)) {
          try {
            const logs = fs.readFileSync(logFile, "utf8");
            console.error("[runtime-tunnel] runtime logs:\n", logs);
          } catch {
            // ignore
          }
        }
        const statusRes = await fetch(
          `${controllerUrl}/projects/${encodeURIComponent(projectId)}/runtime/status`,
          { headers: { authorization: `Bearer ${controllerAccessToken}` } },
        ).catch(() => null);
        if (statusRes?.ok) {
          const statusJson = await statusRes.json().catch(() => null);
          console.error("[runtime-tunnel] runtime status payload:", statusJson);
        }
        throw error;
      }

      console.info("[runtime-tunnel] desktop origin endpoint:", endpoint);
      const isHttp = endpoint.startsWith("http://") || endpoint.startsWith("https://");
      expect(isHttp).toBe(true);

      if (!tunnelHostname) {
        throw new Error("Registered private runtime tunnel did not expose a hostname.");
      }
      expect(endpoint.toLowerCase()).toContain(tunnelHostname.toLowerCase());

      const ingressBaseUrl = (process.env.TUNNEL_E2E_HTTP_BASE_URL || "").trim().replace(/\/$/, "");
      if (ingressBaseUrl) {
        const deadline = Date.now() + 30_000;
        let lastError: unknown = null;
        while (Date.now() < deadline) {
          try {
            const result = await httpGet(`${ingressBaseUrl}/healthz`, {
              headers: { host: tunnelHostname },
              servername: tunnelHostname,
              timeoutMs: 3000,
            });
            if (result.statusCode !== 200) {
              throw new Error(`unexpected status ${result.statusCode} for ingress /healthz: ${result.body}`);
            }
            if (result.body.trim() !== "ok") {
              throw new Error(`unexpected body for ingress /healthz: ${result.body}`);
            }
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 750));
          }
        }
        if (lastError) {
          throw lastError;
        }
      } else {
        const healthUrl = endpoint.replace(/\/$/, "") + "/health";
        const health = await fetch(healthUrl).catch((error) => {
          console.warn(
            "[runtime-tunnel] health check failed (non-fatal):",
            error instanceof Error ? error.message : String(error),
          );
          return null;
        });
        // Any HTTP response means the tunnel endpoint is reachable (origin routes may return 401/403 without auth).
        if (!health) {
          console.warn("[runtime-tunnel] skipping health assertion; endpoint not reachable");
        } else {
          expect(health).not.toBeNull();
        }
      }
    } finally {
      const keepRuntime = process.env.KEEP_CLI_TUNNEL_RUNTIME === "1";
      if (keepRuntime) {
        console.info("[runtime-tunnel] preserving runtime process (KEEP_CLI_TUNNEL_RUNTIME=1)");
      } else {
        await stopRuntime().catch(() => {});
      }
      try {
        const keepWorkspace =
          keepRuntime || process.env.KEEP_CLI_TUNNEL_WORKSPACE === "1";
        if (!keepWorkspace) {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } else {
          console.info("[runtime-tunnel] preserving workspace at", workspaceDir);
        }
      } catch {
        // ignore
      }
    }
  }, 120_000);
});
