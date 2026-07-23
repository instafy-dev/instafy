#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { ensureRatholeBinary } from "../packages/desktop-runtime-agent/dist/index.js";

function cleanUrl(raw) {
  return raw.replace(/\/+$/, "");
}

function isLocalController(raw) {
  try {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return raw.includes("127.0.0.1") || raw.includes("localhost");
  }
}

const controllerUrl =
  process.env.CONTROLLER_URL ||
  process.env.CONTROLLER_BASE_URL ||
  "http://localhost:8788";
const projectId = process.env.CONTROLLER_SPACE_ID || process.env.SPACE_ID;
const orgId = process.env.CONTROLLER_ORG_ID || process.env.ORG_ID;
const ownerUserId =
  process.env.CONTROLLER_OWNER_USER_ID ||
  process.env.OWNER_USER_ID ||
  null;
const bearer =
  process.env.CONTROLLER_BEARER ||
  process.env.CONTROLLER_TOKEN ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.CONTROLLER_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const ratholeBin = process.env.RATHOLE_BIN || "rathole";
const localPort = parseInt(process.env.WEBHOOK_LOCAL_PORT || "8788", 10);

function buildAutoProjectName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `Voice Tunnel ${stamp}`;
}

function usage() {
  console.log(
    [
      "Usage: node scripts/webhook-tunnel.mjs [--port <local_port>] [--controller <url>] [--space <uuid>] [--org <uuid>] [--token <bearer>] [--ready-path </path>] [--ready-timeout-ms <ms>] [--print-speech-env] [--json]",
      "Env fallbacks: CONTROLLER_URL, CONTROLLER_SPACE_ID/SPACE_ID, CONTROLLER_ORG_ID/ORG_ID, CONTROLLER_OWNER_USER_ID/OWNER_USER_ID, CONTROLLER_TOKEN/CONTROLLER_BEARER/SERVICE_ROLE_KEY/CONTROLLER_SERVICE_ROLE_KEY/SUPABASE_SERVICE_ROLE_KEY, WEBHOOK_LOCAL_PORT, RATHOLE_BIN",
    ].join("\n")
  );
}

function parseArgs() {
  const args = process.argv.slice(2);
  let port = localPort;
  let controller = controllerUrl;
  let project = projectId;
  let org = orgId;
  let owner = ownerUserId;
  let token = bearer;
  let readyPath = null;
  let readyTimeoutMs = 30_000;
  let printSpeechEnv = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (arg === "--controller" && args[i + 1]) {
      controller = args[++i];
    } else if (arg === "--space" && args[i + 1]) {
      project = args[++i];
    } else if ((arg === "--org" || arg === "--org-id") && args[i + 1]) {
      org = args[++i];
    } else if ((arg === "--owner-user-id" || arg === "--owner") && args[i + 1]) {
      owner = args[++i];
    } else if (arg === "--token" && args[i + 1]) {
      token = args[++i];
    } else if (arg === "--ready-path" && args[i + 1]) {
      readyPath = args[++i];
    } else if (arg === "--ready-timeout-ms" && args[i + 1]) {
      readyTimeoutMs = parseInt(args[++i], 10);
    } else if (arg === "--print-speech-env") {
      printSpeechEnv = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
  }
  return {
    port,
    controller,
    project,
    org,
    ownerUserId: owner,
    token,
    readyPath,
    readyTimeoutMs,
    printSpeechEnv,
    json,
  };
}

function assertConfig(cfg) {
  if (!cfg.token) {
    console.error(
      "[webhook-tunnel] Missing access token (set CONTROLLER_TOKEN/CONTROLLER_BEARER/SERVICE_ROLE_KEY or --token)",
    );
    process.exit(1);
  }
}

async function ensureProjectContext(cfg) {
  if (cfg.project) {
    return {
      projectId: cfg.project,
      orgId: cfg.org ?? null,
      projectName: null,
    };
  }
  if (!isLocalController(cfg.controller)) {
    throw new Error(
      "Missing space id (set SPACE_ID or --space). Refusing to auto-create spaces against non-local controllers.",
    );
  }

  let resolvedOrgId = cfg.org;
  if (!resolvedOrgId) {
    console.log("[webhook-tunnel] No org id provided; creating a new org...");
    const orgRes = await fetch(`${cleanUrl(cfg.controller)}/orgs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.token}`,
        accept: "application/json",
      },
      body: JSON.stringify({
        orgName: `Webhook Tunnel ${new Date().toISOString()}`,
      }),
    });
    if (!orgRes.ok) {
      const text = await orgRes.text();
      throw new Error(`org creation failed (${orgRes.status}): ${text}`);
    }
    const orgPayload = await orgRes.json();
    const createdOrg =
      orgPayload.orgId || orgPayload.org_id || orgPayload.id || orgPayload.org;
    if (!createdOrg || typeof createdOrg !== "string") {
      throw new Error("org creation response missing orgId");
    }
    resolvedOrgId = createdOrg;
  }

  console.log("[webhook-tunnel] No space id provided; creating a new space...");
  const generatedProjectName = buildAutoProjectName();
  const url = `${cleanUrl(cfg.controller)}/orgs/${encodeURIComponent(resolvedOrgId)}/projects`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.token}`,
      accept: "application/json",
    },
    body: JSON.stringify({
      projectType: "customer",
      projectName: generatedProjectName,
      ...(cfg.ownerUserId ? { ownerUserId: cfg.ownerUserId } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`space creation failed (${res.status}): ${text}`);
  }
  const payload = await res.json();
  const created =
    payload.projectId || payload.project_id || payload.id || payload.project;
  if (!created || typeof created !== "string") {
    throw new Error("space creation response missing projectId");
  }
  return {
    projectId: created,
    orgId: resolvedOrgId ?? null,
    projectName:
      (typeof payload.projectName === "string" && payload.projectName.trim()) ||
      (typeof payload.project_name === "string" && payload.project_name.trim()) ||
      generatedProjectName,
  };
}

async function requestTunnel(cfg) {
  const url = `${cleanUrl(cfg.controller)}/projects/${cfg.project}/tunnels/request`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({
      metadata: {
        localPort: cfg.port,
        source: "webhook-tunnel-script",
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`tunnel request failed (${res.status}): ${text}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReadyPath(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function buildIngressReadinessTarget(controller, publicUrl) {
  const parsedPublicUrl = new URL(publicUrl);
  const protocol = parsedPublicUrl.protocol === "https:" ? "https:" : "http:";
  if (isLocalController(controller)) {
    const port =
      parsedPublicUrl.port ||
      (protocol === "https:" ? "443" : "80");
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

async function fetchTunnelReady(target, pathname) {
  const requestUrl = new URL(pathname, target.requestUrl);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const headers = target.hostHeader ? { host: target.hostHeader } : {};

  return new Promise((resolve, reject) => {
    const request = transport.request(
      requestUrl,
      {
        method: "GET",
        headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks = [];
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

async function updateTunnelStatus(cfg, tunnelId, status, metadata) {
  try {
    const url = `${cleanUrl(cfg.controller)}/projects/${cfg.project}/tunnels/${tunnelId}/status`;
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        status,
        metadata: metadata ?? undefined,
      }),
    });
  } catch {
    // Best effort only; some callers may not have service-role permissions.
  }
}

async function waitForTunnelReadiness({ cfg, publicUrl, readyPath, child, tunnelId }) {
  const normalizedReadyPath = normalizeReadyPath(readyPath);
  if (!normalizedReadyPath) {
    return;
  }

  const target = buildIngressReadinessTarget(cfg.controller, publicUrl);
  const deadline = Date.now() + Math.max(cfg.readyTimeoutMs || 0, 1_000);
  let lastError = "unknown error";
  console.log(
    `[webhook-tunnel] Waiting for tunnel readiness on ${normalizedReadyPath}...`,
  );

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await updateTunnelStatus(cfg, tunnelId, "failed", {
        reason: "rathole exited before tunnel became ready",
      });
      throw new Error(
        `rathole exited with code ${child.exitCode} before tunnel readiness check passed`,
      );
    }

    try {
      const response = await fetchTunnelReady(target, normalizedReadyPath);
      if (response.ok) {
        await updateTunnelStatus(cfg, tunnelId, "active", {
          readyPath: normalizedReadyPath,
          readyCheckedAt: new Date().toISOString(),
        });
        console.log("[webhook-tunnel] Tunnel is ready.");
        return;
      }
      lastError = `status ${response.status}${response.body ? `: ${response.body.slice(0, 200)}` : ""}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }

  await updateTunnelStatus(cfg, tunnelId, "failed", {
    reason: "tunnel readiness check timed out",
    readyPath: normalizedReadyPath,
    lastError,
  });
  throw new Error(`Timed out waiting for tunnel readiness on ${normalizedReadyPath}: ${lastError}`);
}

async function resolveRatholeBinary() {
  if (process.env.RATHOLE_BIN && process.env.RATHOLE_BIN.trim().length > 0) {
    return process.env.RATHOLE_BIN.trim();
  }

  try {
    const resolved = await ensureRatholeBinary({
      logger: (message) => console.log(`[webhook-tunnel] ${message}`),
    });
    process.env.RATHOLE_BIN = resolved;
    return resolved;
  } catch (error) {
    console.warn(
      `[webhook-tunnel] Unable to auto-install rathole; falling back to PATH lookup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return ratholeBin;
  }
}

function buildRatholeConfig(credentials, port) {
  const server = credentials.server;
  const token = credentials.token;
  const service =
    credentials.service || credentials.serviceName || "runtime";
  const protocol = credentials.protocol || "tcp";
  if (!server || !token) {
    throw new Error("tunnel credentials missing server/token");
  }
  return (
    `[client]
remote_addr = "${server}"
default_token = "${token}"

[client.services.${service}]
type = "${protocol}"
local_addr = "127.0.0.1:${port}"
`
  );
}

async function revokeTunnel(cfg, tunnelId) {
  const url = `${cleanUrl(cfg.controller)}/projects/${cfg.project}/tunnels/${tunnelId}/revoke`;
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({ metadata: { reason: "webhook-tunnel:stop" } }),
  }).catch(() => {});
}

async function main() {
  const cfg = parseArgs();
  assertConfig(cfg);
  const projectContext = await ensureProjectContext(cfg);
  cfg.project = projectContext.projectId;
  cfg.org = projectContext.orgId ?? cfg.org;
  console.log("[webhook-tunnel] Requesting tunnel from controller...");
  const grant = await requestTunnel(cfg);
  if (!grant.credentials) {
    throw new Error("tunnel response missing credentials");
  }
  const creds =
    typeof grant.credentials === "string"
      ? JSON.parse(grant.credentials)
      : grant.credentials;
  const configBody = buildRatholeConfig(creds, cfg.port);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-webhook-tunnel-"));
  const configPath = path.join(workdir, "rathole.toml");
  fs.writeFileSync(configPath, configBody, "utf-8");
  const resolvedRatholeBin = await resolveRatholeBinary();
  const publicUrl = grant.url || `https://${grant.hostname}`;
  const normalizedPublicUrl = publicUrl.replace(/\/+$/, "");
  const speechEnv = {
    VITE_INSTAFY_SPEECH_BASE_URL: normalizedPublicUrl,
    VITE_INSTAFY_TRANSCRIPTION_URL: `${normalizedPublicUrl}/transcribe`,
    VITE_INSTAFY_SYNTHESIS_URL: `${normalizedPublicUrl}/synthesize`,
  };

  const child = spawn(resolvedRatholeBin, ["-c", configPath], {
    stdio: "inherit",
    cwd: workdir,
  });

  await waitForTunnelReadiness({
    cfg,
    publicUrl: normalizedPublicUrl,
    readyPath: cfg.readyPath,
    child,
    tunnelId: grant.tunnelId,
  });

  if (cfg.json) {
    console.log(
      JSON.stringify(
        {
          projectId: cfg.project,
          projectName: projectContext.projectName ?? null,
          orgId: cfg.org ?? null,
          tunnelId: grant.tunnelId ?? null,
          url: normalizedPublicUrl,
          hostname: grant.hostname ?? null,
          localPort: cfg.port,
          configPath,
          speechEnv: cfg.printSpeechEnv ? speechEnv : undefined,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("[webhook-tunnel] Config written to", configPath);
    if (projectContext.projectName) {
      console.log("[webhook-tunnel] Project:", projectContext.projectName);
    }
    console.log("[webhook-tunnel] Public URL:", normalizedPublicUrl);
    if (cfg.printSpeechEnv) {
      console.log("[webhook-tunnel] Speech env:");
      for (const [key, value] of Object.entries(speechEnv)) {
        console.log(`export ${key}=${value}`);
      }
    }
  }

  const shutdown = async () => {
    console.log("\n[webhook-tunnel] Shutting down...");
    child.kill("SIGTERM");
    await revokeTunnel(cfg, grant.tunnelId);
    fs.rmSync(workdir, { recursive: true, force: true });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  child.on("exit", async () => {
    await revokeTunnel(cfg, grant.tunnelId);
    fs.rmSync(workdir, { recursive: true, force: true });
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[webhook-tunnel] Failed:", error);
  process.exit(1);
});
