#!/usr/bin/env node
/**
 * Dev/E2E environment helper.
 *
 * Brings up/down a local stack:
 * - Supabase (via `supabase start`, same helper used by `pnpm supabase:up`)
 * - Runtime controller (Cargo project)
 *
 * Also exposes helpers to run Playwright tests against this stack.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SERVICE_RUNTIME_EMAIL,
  DEFAULT_SUPABASE_PROJECT_URL,
  ensureServiceRuntimeUserId,
  setEnvFileValue,
} from "./lib/runtimeEnvHelpers.mjs";
import {
  isIsolatedByocProxyAuthPath,
  localProxyStaticAuthEnabled,
} from "./lib/proxyCredentialMode.mjs";
import {
  resolvePrivateEnvPath,
  writePrivateEnvFileSync,
} from "./lib/privateEnvPaths.mjs";
import { ensureSupabaseEmailTemplateMounts } from "./lib/supabaseEmailTemplateMounts.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const composeFile = path.join(repoRoot, "docker", "docker-compose.runtime.yml");
const privateEnvPath = (relativePath) =>
  resolvePrivateEnvPath({ repoRoot, relativePath });
const composeEnvPath = privateEnvPath("docker/.env.local");
const edgeEnvPath = privateEnvPath("supabase/.env.dev.local");
const supabaseProjectDir = path.join(repoRoot, "supabase", "supabase");
const supabaseMigrationsDir = path.join(repoRoot, "supabase", "migrations");
const supabaseProjectMigrationsDir = path.join(supabaseProjectDir, "migrations");
const supabaseEnvCandidates = [
  privateEnvPath("supabase/.env.dev.local"),
  privateEnvPath("supabase/.env.local"),
  path.join(repoRoot, "supabase", ".env"),
];

const supabaseFlag = path.join(repoRoot, "tmp", ".runtime-supabase-started");
const sandboxDir = path.join(repoRoot, "tmp", "runtime-sandbox");
const runtimeCodexDirName = ".codex-runtime";
const proxyCodexRootDefault = path.join(repoRoot, "tmp", "proxy-codex");
const proxyCodexRootByoc = path.join(repoRoot, "tmp", "proxy-codex-byoc");
const runtimeCodexDummyKey = "runtime-dev-dummy-key";
const defaultCodexModel = "gpt-5.5";
const projectRegistryPath = path.join(repoRoot, "tmp", "runtime-projects.json");
const originSigningKeyPath = path.join(repoRoot, "tmp", "origin-signing-key.json");
const credentialEncryptionKeyPath = path.join(
  repoRoot,
  "tmp",
  "credential-encryption-key.b64"
);
const runtimeProvenancePath = path.join(repoRoot, "tmp", "runtime-provenance.json");
const runtimePruneScript = path.join(repoRoot, "scripts", "prune-runtime-agents.mjs");
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PLACEHOLDER_PROJECT_ID = "00000000-0000-0000-0000-000000000000";
let composeEnvMigratedLegacyProjectId = false;

function normalizeCodexModel(model) {
  const value = String(model ?? "").trim();
  if (!value) return defaultCodexModel;
  // Floor stale OpenAI ids (anything below gpt-5.5 is no longer served
  // upstream); a stale pin in docker/.env.local otherwise survives forever.
  const lower = value.toLowerCase();
  if (lower === "gpt-5" || lower === "gpt-5-codex") return defaultCodexModel;
  if (lower.startsWith("gpt-4") || lower.startsWith("o3")) return defaultCodexModel;
  const versioned = lower.match(/^gpt-5\.(\d+)/);
  if (versioned && Number(versioned[1]) < 5) return defaultCodexModel;
  return value;
}

const composeProject = process.env.COMPOSE_PROJECT_NAME ?? "instafy-runtime";

// Controller bits
const controllerManifest = path.join(
  repoRoot,
  "packages",
  "runtime-controller",
  "Cargo.toml"
);
const controllerPidFile = path.join(repoRoot, "tmp", ".controller.pid");
const logsDir = path.join(repoRoot, "tmp", "logs");
const controllerLogPath = path.join(logsDir, "controller.log");
const controllerPort = Number(process.env.CONTROLLER_PORT || 8788);
const controllerBaseUrl = `http://127.0.0.1:${controllerPort}`;
const redisPort = Number(process.env.REDIS_PORT || 6379);
const redisUrlDefault = `redis://127.0.0.1:${redisPort}`;

// Provider service (external allocator) bits
const providerManifest = path.join(repoRoot, "packages", "runtime-provider-service", "Cargo.toml");
const providerPidFile = path.join(repoRoot, "tmp", ".provider.pid");
const providerLogPath = path.join(logsDir, "provider.log");
const providerPort = Number(process.env.PROVIDER_PORT || 9090);
const providerBaseUrl = process.env.DEV_PROVIDER_ENDPOINT || `http://127.0.0.1:${providerPort}`;

// Proxy bits
const proxyManifest = path.join(
  repoRoot,
  "packages",
  "openai-proxy-server",
  "Cargo.toml"
);
const proxyPidFile = path.join(repoRoot, "tmp", ".proxy.pid");
const proxyLogPath = path.join(logsDir, "proxy.log");
const proxyDefaultPort = Number(process.env.PROXY_PORT || 8789);
const stripeEnvPath = privateEnvPath(".env.stripe");
const githubOauthEnvPath = path.join(repoRoot, ".env.github-oauth");
const geminiEnvPath = path.join(repoRoot, ".env.gemini");
const vapidEnvPath = path.join(repoRoot, ".env.vapid");
const apnsEnvPath = path.join(repoRoot, ".env.apns");
const tunnelBrokerDir = path.join(repoRoot, "packages", "tunnel-broker");
const tunnelBrokerComposeFile = path.join(tunnelBrokerDir, "docker-compose.yml");
const tunnelBrokerComposeOverride = path.join(tunnelBrokerDir, "docker-compose.stack.yml");
const tunnelBrokerFlag = path.join(repoRoot, "tmp", ".tunnel-broker-stack-started");
const tunnelBrokerPort = Number(process.env.TUNNEL_BROKER_PORT || 8082);
const tunnelBrokerBaseUrlDefault = `http://127.0.0.1:${tunnelBrokerPort}`;

// ───────────────────────── helpers ─────────────────────────
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });
  const exitCode = result.status ?? result.code ?? 1;
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`);
  }
}

function writePrivateEnvFile(relativePath, filePath, content, options = {}) {
  const writtenPath = writePrivateEnvFileSync({
    repoRoot,
    relativePath,
    data: content,
    encoding: "utf-8",
    flag: options.flag ?? "w",
  });
  if (writtenPath !== filePath) {
    throw new Error("private env path changed between resolution and write");
  }
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: repoRoot,
    encoding: "utf-8",
    ...options,
  });
  const exitCode = result.status ?? result.code ?? 1;
  if (exitCode !== 0) {
    const stderr = result.stderr?.trim() ?? `exit ${exitCode}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  }
  return result.stdout ?? "";
}
function tryCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: repoRoot,
    encoding: "utf-8",
    ...options,
  });
  const exitCode =
    typeof result.status === "number"
      ? result.status
      : typeof result.code === "number"
        ? result.code
        : result.error
          ? 1
          : 0;
  return {
    code: exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function envFlagEnabled(value, defaultValue = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function resolveComposeHostBindPath(rawValue, fallbackRelativeToComposeFile) {
  const value = String(rawValue ?? "").trim();
  const candidate = value || fallbackRelativeToComposeFile;
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(path.dirname(composeFile), candidate);
}

function ensureGitCanonicalBindRoots() {
  const roots = [
    resolveComposeHostBindPath(process.env.GIT_REPO_VOLUME, "../tmp/git-repos"),
    resolveComposeHostBindPath(
      process.env.ORIGIN_GATEWAY_WORKSPACE_VOLUME,
      "../tmp/origin-gateway-workspaces"
    ),
  ];
  for (const root of roots) {
    fs.mkdirSync(root, { recursive: true });
  }
}

function pruneRuntimeAgentsBeforeUp() {
  if (!envFlagEnabled(process.env.RUNTIME_PRUNE_ON_UP, true)) {
    return;
  }

  console.log("[runtime-dev] Pruning stale per-project runtime containers before startup...");
  try {
    run(process.execPath, [runtimePruneScript]);
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to prune stale per-project runtimes before startup: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function runSupabase(args, options = {}) {
  run("pnpm", ["exec", "supabase", "--workdir", "supabase", ...args], options);
}

function runCaptureSupabase(args, options = {}) {
  return runCapture("pnpm", ["exec", "supabase", "--workdir", "supabase", ...args], options);
}

function tryCaptureSupabase(args, options = {}) {
  return tryCapture("pnpm", ["exec", "supabase", "--workdir", "supabase", ...args], options);
}

function ensureDefaultProviderSeed() {
  try {
    const endpoint = process.env.DEV_PROVIDER_ENDPOINT;
    if (endpoint && endpoint.trim().length > 0) {
      console.log(
        `[runtime-dev] Seeding default runtime providers (external http -> ${endpoint})...`,
      );
    } else {
      console.log("[runtime-dev] Seeding default runtime providers (local docker)...");
    }
    run("node", ["scripts/providers-seed.mjs", "default"]);
  } catch (error) {
    console.warn(
      `[runtime-dev] Failed to seed default provider: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function ensureDir(dirPath) {
  if (!fileExists(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureTmpDir() {
  const tmpDir = path.dirname(supabaseFlag);
  ensureDir(tmpDir);
  ensureDir(logsDir);
}

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;
      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim().replace(/^['"](.+)['"]$/, "$1");
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
    console.log(`[runtime-dev] Loaded env from ${filePath}`);
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to load ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function syncSupabaseMigrationsDir() {
  if (!fileExists(supabaseMigrationsDir)) {
    return;
  }
  try {
    fs.mkdirSync(supabaseProjectDir, { recursive: true });
    fs.rmSync(supabaseProjectMigrationsDir, { recursive: true, force: true });
    fs.cpSync(supabaseMigrationsDir, supabaseProjectMigrationsDir, {
      dereference: true,
      errorOnExist: false,
      force: true,
      recursive: true,
    });
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to mirror Supabase migrations into ${supabaseProjectMigrationsDir}: ${error.message}`
    );
  }
}

function applySupabaseMigrations() {
  syncSupabaseMigrationsDir();
  try {
    console.log("[runtime-dev] Applying Supabase migrations...");
    runSupabase(["migration", "up", "--local"]);
  } catch (error) {
    console.warn(
      `[runtime-dev] Supabase migration up failed: ${error.message}`
    );
    throw error;
  }
}

function ensureOriginSigningKeys() {
  try {
    const raw = fs.readFileSync(originSigningKeyPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.privateKey && parsed.publicKey && parsed.keyId) {
      return parsed;
    }
  } catch {}

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const keyId = crypto.randomUUID();
  const payload = { privateKey: privatePem, publicKey: publicPem, keyId };
  try {
    fs.mkdirSync(path.dirname(originSigningKeyPath), { recursive: true });
    fs.writeFileSync(originSigningKeyPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to persist origin signing key ${originSigningKeyPath}: ${error.message}`
    );
  }
  return payload;
}

function isValidCredentialEncryptionKey(raw) {
  try {
    return Buffer.from(raw, "base64").length === 32;
  } catch {
    return false;
  }
}

function ensureCredentialEncryptionKey() {
  const explicit = (process.env.CREDENTIAL_ENCRYPTION_KEY || "").trim();
  if (explicit) {
    if (!isValidCredentialEncryptionKey(explicit)) {
      throw new Error(
        "[runtime-dev] CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key."
      );
    }
    return explicit;
  }

  try {
    const raw = fs.readFileSync(credentialEncryptionKeyPath, "utf-8").trim();
    if (raw && isValidCredentialEncryptionKey(raw)) {
      return raw;
    }
  } catch {}

  const generated = crypto.randomBytes(32).toString("base64");
  try {
    fs.mkdirSync(path.dirname(credentialEncryptionKeyPath), { recursive: true });
    fs.writeFileSync(credentialEncryptionKeyPath, `${generated}\n`, "utf-8");
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to persist credential encryption key ${credentialEncryptionKeyPath}: ${error.message}`
    );
  }
  return generated;
}

function ensureDockerConfig() {
  const dockerConfigDir = path.join(repoRoot, "tmp", "docker-config");
  try {
    fs.mkdirSync(dockerConfigDir, { recursive: true });
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to create docker config dir ${dockerConfigDir}: ${error.message}`
    );
  }
  const configPath = path.join(dockerConfigDir, "config.json");
  if (!fileExists(configPath)) {
    try {
      fs.writeFileSync(configPath, `${JSON.stringify({ auths: {} }, null, 2)}\n`, "utf-8");
    } catch (error) {
      console.warn(
        `[runtime-dev] Unable to seed docker config ${configPath}: ${error.message}`
      );
    }
  }
  if (!process.env.DOCKER_CONFIG) {
    process.env.DOCKER_CONFIG = dockerConfigDir;
  }
}
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSupabaseAuthReady(
  supabaseEnv,
  { attempts = 30, delayMs = 1500 } = {}
) {
  const baseUrl = resolveSupabaseBaseUrl(supabaseEnv);
  if (!baseUrl || typeof fetch !== "function") {
    return false;
  }
  const healthUrl = `${baseUrl}/auth/v1/health`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { cache: "no-store" });
      if (response.ok) {
        return true;
      }
      console.warn(
        `[runtime-dev] Supabase auth not ready (attempt ${attempt + 1}): ${response.status} ${response.statusText}`
      );
    } catch (error) {
      console.warn(
        `[runtime-dev] Supabase auth health check failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
    await wait(delayMs);
  }
  return false;
}

function resolveSupabaseBaseUrl(supabaseEnv = {}) {
  const baseUrlRaw =
    process.env.SUPABASE_PROJECT_URL ||
    process.env.SUPABASE_URL ||
    supabaseEnv.SUPABASE_PROJECT_URL ||
    supabaseEnv.SUPABASE_URL ||
    DEFAULT_SUPABASE_PROJECT_URL;
  return baseUrlRaw ? baseUrlRaw.trim().replace(/\/$/, "") : "";
}

async function waitForSupabaseAdminReady(
  supabaseEnv,
  { attempts = 30, delayMs = 1500 } = {}
) {
  const baseUrl = resolveSupabaseBaseUrl(supabaseEnv);
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    supabaseEnv.SERVICE_ROLE_KEY ||
    "";
  if (!baseUrl || !serviceRoleKey || typeof fetch !== "function") {
    return false;
  }
  const probeEmail =
    (process.env.SERVICE_RUNTIME_USER_EMAIL || DEFAULT_SERVICE_RUNTIME_EMAIL)
      .trim()
      .toLowerCase() || DEFAULT_SERVICE_RUNTIME_EMAIL;
  const healthUrl = `${baseUrl}/auth/v1/admin/users?email=${encodeURIComponent(probeEmail)}`;
  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json"
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { headers, cache: "no-store" });
      if (response.ok) {
        return true;
      }
      console.warn(
        `[runtime-dev] Supabase admin API not ready (attempt ${attempt + 1}): ${response.status} ${response.statusText}`
      );
    } catch (error) {
      console.warn(
        `[runtime-dev] Supabase admin probe failed (attempt ${attempt + 1}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    await wait(delayMs);
  }
  return false;
}

async function waitForPort(
  port,
  { host = "127.0.0.1", attempts = 60, delayMs = 500 } = {}
) {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise((resolve) => {
      const s = net.createConnection({ port, host }, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await wait(delayMs);
  }
  return false;
}

async function waitForPortClose(
  port,
  { host = "127.0.0.1", attempts = 40, delayMs = 250 } = {}
) {
  for (let i = 0; i < attempts; i++) {
    const open = await new Promise((resolve) => {
      const s = net.createConnection({ port, host }, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => {
        resolve(false);
      });
    });
    if (!open) {
      return true;
    }
    await wait(delayMs);
  }
  return false;
}

function streamFileAppends(filePath, { label = "", startAtEnd = true } = {}) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {}

  let position = 0;
  try {
    const stat = fs.statSync(filePath);
    position = startAtEnd ? stat.size : 0;
  } catch {
    try {
      fs.writeFileSync(filePath, "");
    } catch {}
    position = 0;
  }

  const prefix = label ? `[${label}] ` : "";
  const writeChunk = (chunk) => {
    if (!chunk || chunk.length === 0) return;
    const text = chunk.toString();
    if (!text) return;
    const output = prefix ? text.replace(/^/gm, prefix) : text;
    process.stdout.write(output);
  };

  const readNewBytes = () => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    if (!stat || stat.size <= position) return;
    const stream = fs.createReadStream(filePath, {
      start: position,
      end: stat.size - 1,
    });
    stream.on("data", writeChunk);
    stream.on("end", () => {
      position = stat.size;
    });
    stream.on("error", () => {
      position = stat.size;
    });
  };

  readNewBytes();
  const watcher = fs.watch(filePath, (eventType) => {
    if (eventType === "change") {
      readNewBytes();
    }
  });

  return () => {
    try {
      watcher?.close();
    } catch {}
  };
}

function listComposeProjectsUsingFile() {
  try {
    const out = runCapture("docker", ["compose", "ls", "--format", "json"]);
    const rows = JSON.parse(out);
    const target = path.resolve(composeFile);
    return rows
      .filter((row) => {
        const files = Array.isArray(row.ConfigFiles)
          ? row.ConfigFiles
          : (row.ConfigFiles || "").split(/[,\s]+/).filter(Boolean);
        return files.some((f) => path.resolve(f) === target);
      })
      .map((row) => row.Name)
      .filter(Boolean);
  } catch {
    return [];
  }
}
function downAllComposeProjectsForThisFile() {
  const names = Array.from(new Set([composeProject, ...listComposeProjectsUsingFile()]));
  for (const name of names) {
    try {
      console.log(
        `[runtime-dev] Bringing down compose project "${name}" for ${composeFile}...`
      );
      run("docker", [
        "compose",
        "-p",
        name,
        "-f",
        composeFile,
        "down",
        "-v",
        "--remove-orphans",
      ]);
    } catch (error) {
      console.warn(`[runtime-dev] down failed for project "${name}": ${error.message}`);
    }
  }
}

// ─────────────────────── supabase helpers ───────────────────────
function stopSupabaseAlways() {
  if (process.env.RUNTIME_KEEP_SUPABASE === "1") {
    console.log("[runtime-dev] Skipping Supabase stop due to RUNTIME_KEEP_SUPABASE=1");
    return;
  }
  console.log("[runtime-dev] Stopping Supabase local stack...");
  try {
    runSupabase(["stop"]);
  } catch (error) {
    console.warn(`[runtime-dev] Supabase stop failed: ${error.message}`);
  } finally {
    try {
      fs.rmSync(supabaseFlag, { force: true });
    } catch {}
  }
}

async function waitForSupabaseEnv({ attempts = 30, delayMs = 1500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = tryCaptureSupabase(["status", "--output", "env"]);
    if (result.code === 0 && (result.stdout || "").trim().length > 0) {
      return result.stdout;
    }
    await wait(delayMs);
  }
  return null;
}

async function ensureSupabase() {
  syncSupabaseMigrationsDir();
  let alreadyRunning = false;
  try {
    runCaptureSupabase(["status", "--output", "env"]);
    alreadyRunning = true;
  } catch {}

  if (alreadyRunning) {
    ensureSupabaseEmailTemplateMounts({ projectDir: supabaseProjectDir });
    applySupabaseMigrations();
    return { running: true, started: false };
  }

  console.log("[runtime-dev] Supabase not running. Starting local stack...");
  console.log("[runtime-dev] Launching Supabase services (first launch can take a few minutes)...");
  try {
    runSupabase(["start"]);
  } catch (error) {
    console.warn(
      `[runtime-dev] Supabase start failed; retrying with --ignore-health-check: ${error.message}`
    );
    try {
      runSupabase(["stop"]);
    } catch (stopError) {
      console.warn(`[runtime-dev] Supabase stop after failed start: ${stopError.message}`);
    }
    runSupabase(["start", "--ignore-health-check"]);
  }
  const envOutput = await waitForSupabaseEnv();
  if (!envOutput) {
    throw new Error("[runtime-dev] Supabase did not become ready after start.");
  }
  ensureSupabaseEmailTemplateMounts({ projectDir: supabaseProjectDir });
  applySupabaseMigrations();
  ensureTmpDir();
  fs.writeFileSync(supabaseFlag, String(Date.now()));
  return { running: true, started: true };
}
function configureSupabaseSecrets(supabaseEnv = {}) {
  const supabaseToken =
    process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseToken) {
    console.log(
      "[runtime-dev] Skipping Supabase secrets set (no SUPABASE_ACCESS_TOKEN; local defaults will be used)",
    );
    return;
  }
  const serviceRoleKey =
    supabaseEnv.SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const secrets = ["AGENT_LOGIN_KEY=dev-agent-key"];
  if (serviceRoleKey) secrets.push(`JWT_SECRET=${serviceRoleKey}`);
  for (const entry of secrets) {
    const key = entry.split("=", 1)[0];
    try {
      console.log(`[runtime-dev] Setting Supabase secret ${key}...`);
      runSupabase(["secrets", "set", entry]);
    } catch (error) {
      console.warn(`[runtime-dev] Unable to set ${key}: ${error.message}`);
    }
  }
}
function ensureEdgeEnvSupabase(projectUrl) {
  if (!projectUrl) {
    return;
  }
  try {
    let content = "";
    try {
      content = fs.readFileSync(edgeEnvPath, "utf-8");
    } catch {}
    const lines = content ? content.split(/\r?\n/) : [];
    const next = lines
      .filter(Boolean)
      .reduce((acc, line) => {
        if (line.startsWith("SUPABASE_PROJECT_URL="))
          acc.push(`SUPABASE_PROJECT_URL=${projectUrl}`);
        else acc.push(line);
        return acc;
      }, []);
    if (!next.some((l) => l.startsWith("SUPABASE_PROJECT_URL=")))
      next.push(`SUPABASE_PROJECT_URL=${projectUrl}`);
    const nextContent = `${next.join("\n")}\n`;
    const normalizedOriginal = content
      ? `${content.replace(/\r\n/g, "\n").replace(/\n+$/, "\n")}\n`
      : "";
    if (nextContent !== normalizedOriginal) {
      writePrivateEnvFile(
        "supabase/.env.dev.local",
        edgeEnvPath,
        nextContent,
      );
      console.log(
        `[runtime-dev] Updated ${edgeEnvPath} with SUPABASE_PROJECT_URL=${projectUrl}`
      );
    }
  } catch (error) {
    console.warn(`[runtime-dev] Unable to update ${edgeEnvPath}: ${error.message}`);
  }
}

function parseEnv(content) {
  const map = {};
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    const raw = t.slice(idx + 1).trim();
    const val = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (key) map[key] = val;
  }
  return map;
}

function readEnvValueFromFiles(files, key) {
  for (const file of files) {
    try {
      if (!fileExists(file)) continue;
      const content = fs.readFileSync(file, "utf-8");
      const map = parseEnv(content);
      if (map[key]) {
        return map[key];
      }
    } catch (error) {
      console.warn(`[runtime-dev] Unable to read ${file}: ${error.message}`);
    }
  }
  return null;
}

function normalizeComposeEnvSpaceIdentifiers() {
  if (!fileExists(composeEnvPath)) return;
  try {
    const content = fs.readFileSync(composeEnvPath, "utf-8");
    const envMap = parseEnv(content);
    const lines = content.split(/\r?\n/);
    let modified = false;
    let migratedLegacyProjectId = false;

    const legacyProjectId =
      envMap.PROJECT_ID && UUID_PATTERN.test(envMap.PROJECT_ID.trim())
        ? envMap.PROJECT_ID.trim()
        : null;
    const spaceId =
      envMap.SPACE_ID && UUID_PATTERN.test(envMap.SPACE_ID.trim())
        ? envMap.SPACE_ID.trim()
        : legacyProjectId;

    if (spaceId) {
      const desiredSpaceLine = `SPACE_ID=${spaceId}`;
      const spaceIdx = lines.findIndex((line) => line.startsWith("SPACE_ID="));
      if (spaceIdx === -1) {
        lines.push(desiredSpaceLine);
        modified = true;
      } else if (lines[spaceIdx] !== desiredSpaceLine) {
        lines[spaceIdx] = desiredSpaceLine;
        modified = true;
      }
    }

    const projectIdx = lines.findIndex((line) => line.startsWith("PROJECT_ID="));
    if (projectIdx !== -1) {
      lines.splice(projectIdx, 1);
      modified = true;
      migratedLegacyProjectId = true;
    }

    if (spaceId && (process.env.GIT_CANONICAL || "").trim() === "1") {
      const desiredRemoteLine = `ORIGIN_GIT_REMOTE_URL=http://git-edge:8080/${spaceId}.git`;
      const remoteIdx = lines.findIndex((line) => line.startsWith("ORIGIN_GIT_REMOTE_URL="));
      if (remoteIdx === -1) {
        lines.push(desiredRemoteLine);
        modified = true;
      } else if (lines[remoteIdx] !== desiredRemoteLine) {
        lines[remoteIdx] = desiredRemoteLine;
        modified = true;
      }
    }

    if (!modified) {
      return;
    }

    const next = lines.filter((line, idx) => line || idx === lines.length - 1);
    writePrivateEnvFile(
      "docker/.env.local",
      composeEnvPath,
      `${next.join("\n").replace(/\n+$/, "\n")}\n`,
    );

    if (migratedLegacyProjectId) {
      composeEnvMigratedLegacyProjectId = true;
      console.log("[runtime-dev] Migrated docker/.env.local from PROJECT_ID to SPACE_ID.");
    }
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to normalize docker/.env.local identifiers: ${error.message}`
    );
  }
}


// ─────────────────────── compose env helpers ───────────────────────
function ensureSandboxRepo() {
  ensureTmpDir();
  const configuredHostRaw = (process.env.RUNTIME_REPO_HOST ?? "").trim();
  const configuredHost = configuredHostRaw ? path.resolve(configuredHostRaw) : "";
  const resolvedSandbox = path.resolve(sandboxDir);
  const seedFlagRaw = (process.env.RUNTIME_SEED_WITH_REPO ?? "").trim().toLowerCase();
  const shouldSeedRepo = ["1", "true", "yes", "on"].includes(seedFlagRaw);
  if (configuredHost && configuredHost !== resolvedSandbox) {
    try {
      fs.mkdirSync(configuredHost, { recursive: true });
    } catch (error) {
      console.warn(
        `[runtime-dev] Unable to ensure RUNTIME_REPO_HOST directory ${configuredHost}: ${error.message}`
      );
    }
    console.log(
      `[runtime-dev] RUNTIME_REPO_HOST preset (${configuredHost}); skipping sandbox rsync.`
    );
    return;
  }
  try {
    fs.rmSync(resolvedSandbox, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to reset sandbox directory ${resolvedSandbox}: ${error.message}`
    );
  }
  fs.mkdirSync(resolvedSandbox, { recursive: true });
  if (!shouldSeedRepo) {
    console.log(
      `[runtime-dev] RUNTIME_SEED_WITH_REPO is disabled; using empty sandbox at ${resolvedSandbox}. Set RUNTIME_SEED_WITH_REPO=1 to seed from the repo.`
    );
    return;
  }
  const rsyncArgs = [
    "-a",
    "--delete",
    "--exclude",
    ".git",
    "--exclude",
    "tmp/runtime-sandbox",
    `${repoRoot}/`,
    `${sandboxDir}/`,
  ];
  try {
    run("rsync", rsyncArgs);
  } catch (error) {
    console.warn(
      `[runtime-dev] Failed to seed runtime sandbox: ${error.message}`
    );
  }
}
function syncProxyCodexCredentials(targetRoot) {
  const homeDir = process.env.HOME;
  if (!homeDir) return false;
  const sourceDir = path.join(homeDir, ".codex");
  const sourceAuth = path.join(sourceDir, "auth.json");
  if (!fileExists(sourceAuth)) return false;
  const targetAuth = path.join(targetRoot, "auth.json");
  try {
    fs.mkdirSync(targetRoot, { recursive: true });
    const preserveTarget =
      (process.env.RUNTIME_PRESERVE_PROXY_CODEX_AUTH ?? "").trim() === "1";
    const sourceRefresh = preserveTarget ? readCodexAuthRefreshTimestamp(sourceAuth) : null;
    const targetRefresh = preserveTarget ? readCodexAuthRefreshTimestamp(targetAuth) : null;
    const preserveExistingTarget =
      preserveTarget &&
      targetRefresh !== null &&
      sourceRefresh !== null &&
      targetRefresh > sourceRefresh;
    if (!preserveExistingTarget && path.resolve(sourceAuth) !== path.resolve(targetAuth)) {
      fs.copyFileSync(sourceAuth, targetAuth);
      try {
        fs.chmodSync(targetAuth, 0o600);
      } catch {}
    }
    for (const f of ["config.toml", "version.json"]) {
      const src = path.join(sourceDir, f);
      const dst = path.join(targetRoot, f);
      if (fileExists(src) && path.resolve(src) !== path.resolve(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
    return true;
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to mirror .codex credentials: ${error.message}`
    );
    return false;
  }
}

function readCodexAuthRefreshTimestamp(authPath) {
  if (!fileExists(authPath)) return null;
  try {
    const raw = fs.readFileSync(authPath, "utf-8");
    const parsed = JSON.parse(raw);
    const refreshValue =
      parsed && typeof parsed === "object" && typeof parsed.last_refresh === "string"
        ? Date.parse(parsed.last_refresh)
        : Number.NaN;
    if (Number.isFinite(refreshValue)) {
      return refreshValue;
    }
  } catch {}
  try {
    return fs.statSync(authPath).mtimeMs;
  } catch {
    return null;
  }
}

function runtimeCodexVolume(root) {
  return path.join(root, runtimeCodexDirName);
}

function ensureRuntimeCodexStub(runtimeCodexHome) {
  try {
    fs.mkdirSync(runtimeCodexHome, { recursive: true });
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to create runtime Codex directory ${runtimeCodexHome}: ${error.message}`
    );
  }
  const authPath = path.join(runtimeCodexHome, "auth.json");
  let payload = {};
  if (fileExists(authPath)) {
    try {
      const raw = fs.readFileSync(authPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        delete parsed.tokens;
        delete parsed.last_refresh;
        delete parsed.OPENAI_API_KEY;
        payload = parsed;
      }
    } catch (error) {
      console.warn(
        `[runtime-dev] Failed to read existing runtime auth.json, overwriting with stub: ${error.message}`
      );
    }
  }
  try {
    fs.writeFileSync(authPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to write runtime auth.json stub: ${error.message}`
    );
  }
  ensureRuntimeCodexConfig(runtimeCodexHome);
}


function ensureRuntimeCodexConfig(runtimeCodexHome) {
  const configPath = path.join(runtimeCodexHome, "config.toml");
  let existing = "";
  if (fileExists(configPath)) {
    try {
      existing = fs.readFileSync(configPath, "utf-8");
    } catch (error) {
      console.warn(
        `[runtime-dev] Unable to read runtime Codex config (${configPath}): ${error.message}`
      );
    }
  }

  let sanitized = existing;
  if (sanitized.includes("[mcp_servers.templates]")) {
    const lines = sanitized.split(/\r?\n/);
    const filtered = [];
    let skippingTemplateBlock = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!skippingTemplateBlock && trimmed === "[mcp_servers.templates]") {
        skippingTemplateBlock = true;
        continue;
      }
      if (skippingTemplateBlock) {
        if (!trimmed || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
          skippingTemplateBlock = trimmed === "[mcp_servers.templates]";
          if (!skippingTemplateBlock && trimmed) {
            filtered.push(line);
          }
        }
        continue;
      }
      filtered.push(line);
    }
    const nextSanitized = filtered.join("\n");
    if (nextSanitized !== sanitized) {
      sanitized = nextSanitized;
      try {
        fs.writeFileSync(configPath, `${sanitized.trimEnd()}\n`, "utf-8");
      } catch (error) {
        console.warn(
          `[runtime-dev] Unable to remove template MCP config (${configPath}): ${error.message}`
        );
      }
    }
  }

  let nextBody = sanitized.trimEnd();
  const additions = [];
  const needsExperimentalFlag = !/\bexperimental_use_rmcp_client\b/.test(nextBody);
  if (needsExperimentalFlag) {
    additions.push("experimental_use_rmcp_client = true");
  }

  const needsPhaseOneModel = !/\bphase_1_model\s*=/.test(nextBody);
  const needsPhaseTwoModel = !/\bphase_2_model\s*=/.test(nextBody);
  if (needsPhaseOneModel || needsPhaseTwoModel) {
    const memoryModelLines = [];
    if (needsPhaseOneModel) {
      memoryModelLines.push('phase_1_model = "gpt-5.5-mini"');
    }
    if (needsPhaseTwoModel) {
      memoryModelLines.push('phase_2_model = "gpt-5.5"');
    }

    const lines = nextBody ? nextBody.split(/\r?\n/) : [];
    const memoriesHeaderIndex = lines.findIndex((line) => line.trim() === "[memories]");
    if (memoriesHeaderIndex >= 0) {
      lines.splice(memoriesHeaderIndex + 1, 0, ...memoryModelLines);
      nextBody = lines.join("\n");
    } else {
      additions.push("[memories]", ...memoryModelLines);
    }
  }

  if (additions.length === 0 && nextBody === sanitized.trimEnd()) {
    return;
  }

  const next = [nextBody, additions.join("\n")]
    .filter(Boolean)
    .join("\n\n");

  try {
    fs.writeFileSync(configPath, `${next.trimEnd()}\n`, "utf-8");
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to update runtime Codex config (${configPath}): ${error.message}`
    );
  }
}

function proxyByocModeEnabled() {
  return !localProxyStaticAuthEnabled(process.env);
}

function ensureProxyCodexHomeForMode() {
  if (!proxyByocModeEnabled()) return;
  if (!(process.env.PROXY_CODEX_HOME ?? "").trim()) {
    process.env.PROXY_CODEX_HOME = proxyCodexRootByoc;
  }
  if (!(process.env.PROXY_CODEX_VOLUME ?? "").trim()) {
    process.env.PROXY_CODEX_VOLUME = proxyCodexRootByoc;
  }
}

function resolveProxyCodexHome() {
  const override = process.env.PROXY_CODEX_HOME?.trim();
  if (override) return path.resolve(override);
  const codexHomeEnv = process.env.CODEX_HOME?.trim();
  if (codexHomeEnv && !codexHomeEnv.startsWith("/workspace/")) {
    return path.resolve(codexHomeEnv);
  }
  return proxyCodexRootDefault;
}

function resolveProxyAuthPath(proxyCodexHome) {
  const override = process.env.PROXY_CODEX_AUTH_PATH?.trim();
  if (override) return path.resolve(override);
  const codexAuthEnv = process.env.CODEX_AUTH_PATH?.trim();
  if (codexAuthEnv && !codexAuthEnv.startsWith("/workspace/")) {
    return path.resolve(codexAuthEnv);
  }
  return path.join(proxyCodexHome, "auth.json");
}

function guardAgainstSelfReferentialProxy(proxyConfig, endpoints) {
  const variants = new Set();
  const normalizedBase = (proxyConfig.baseUrl || "").trim().replace(/\/$/, "");
  if (normalizedBase) {
    variants.add(normalizedBase.toLowerCase());
  }
  const hostPortPairs = [
    `${proxyConfig.host}:${proxyConfig.port}`,
    `127.0.0.1:${proxyConfig.port}`,
    `localhost:${proxyConfig.port}`,
    `host.docker.internal:${proxyConfig.port}`
  ];
  for (const pair of hostPortPairs) {
    variants.add(`http://${pair}`.toLowerCase());
    variants.add(`https://${pair}`.toLowerCase());
  }

  const checkEndpoint = (value, label) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    for (const candidate of variants) {
      if (lower === candidate || lower.startsWith(`${candidate}/`)) {
        console.error(
          `[runtime-dev] Refusing to launch proxy: ${label} points at ${trimmed}, which maps back to the proxy itself (${proxyConfig.baseUrl}).`
        );
        throw new Error(
          `Proxy upstream endpoint misconfigured (self-referential): ${label}=${trimmed}`
        );
      }
    }
  };

  checkEndpoint(endpoints.codexChatGpt, "CODEX_CHATGPT_ENDPOINT");
  checkEndpoint(endpoints.codexProxyChatGpt, "CODEX_PROXY_CHATGPT_ENDPOINT");
  checkEndpoint(endpoints.openaiBase, "OPENAI_BASE_URL");
  checkEndpoint(endpoints.codexApi, "CODEX_API_ENDPOINT");
}

async function fetchProxyHealthz(proxyConfig) {
  const url = `${(proxyConfig.baseUrl || "").replace(/\/+$/, "")}/healthz`;
  const timeoutMs = Number(process.env.RUNTIME_PROXY_HEALTHZ_TIMEOUT_MS || 2000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal }).catch(() => null);
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isRecognizedProxyHealth(health) {
  return (
    !!health &&
    typeof health === "object" &&
    health.status === "ok" &&
    typeof health.backend === "string" &&
    typeof health.requiresCredential === "boolean"
  );
}

function ensureComposeEnv(supabaseEnv) {
  const runtimeRepoHostRaw = (process.env.RUNTIME_REPO_HOST ?? "").trim();
  const runtimeRepoHost = runtimeRepoHostRaw
    ? path.resolve(runtimeRepoHostRaw)
    : sandboxDir;
  process.env.RUNTIME_REPO_HOST = runtimeRepoHost;
  if (fileExists(composeEnvPath)) {
    normalizeComposeEnvSpaceIdentifiers();
    try {
      const content = fs.readFileSync(composeEnvPath, "utf-8");
      const envMap = parseEnv(content);
      const anonKey = supabaseEnv.ANON_KEY ?? "";
      const serviceRoleKey = supabaseEnv.SERVICE_ROLE_KEY ?? "";
      if (anonKey && envMap.SUPABASE_ANON_KEY !== anonKey) {
        setEnvFileValue(composeEnvPath, "SUPABASE_ANON_KEY", anonKey);
        console.log("[runtime-dev] Updated docker/.env.local with Supabase ANON_KEY.");
      }
      if (serviceRoleKey && envMap.SUPABASE_SERVICE_ROLE_KEY !== serviceRoleKey) {
        setEnvFileValue(composeEnvPath, "SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey);
        console.log("[runtime-dev] Updated docker/.env.local with Supabase SERVICE_ROLE_KEY.");
      }
    } catch (error) {
      console.warn(
        `[runtime-dev] Unable to sync Supabase keys into docker/.env.local: ${error.message}`
      );
    }
    if (runtimeRepoHostRaw) {
      try {
        const content = fs.readFileSync(composeEnvPath, "utf-8");
        const lines = content.split(/\r?\n/);
        const envMap = parseEnv(content);
        const existingHostRaw = envMap.RUNTIME_REPO_HOST ?? "";
        const existingHost = existingHostRaw ? path.resolve(existingHostRaw) : "";
        const desiredLine = `RUNTIME_REPO_HOST=${runtimeRepoHost}`;
        if (existingHost !== runtimeRepoHost) {
          const idx = lines.findIndex((line) => line.startsWith("RUNTIME_REPO_HOST="));
          if (idx === -1) {
            lines.push(desiredLine);
          } else {
            lines[idx] = desiredLine;
          }
          const next = lines.filter((line, index) => line || index === lines.length - 1);
          writePrivateEnvFile(
            "docker/.env.local",
            composeEnvPath,
            `${next.join("\n").replace(/\n+$/, "\n")}\n`,
          );
          console.log(
            `[runtime-dev] Updated docker/.env.local with RUNTIME_REPO_HOST=${runtimeRepoHost}`
          );
        }
      } catch (error) {
        console.warn(
          `[runtime-dev] Unable to update RUNTIME_REPO_HOST in docker/.env.local: ${error.message}`
        );
      }
    }
    if (process.env.SERVICE_RUNTIME_USER_ID) {
      setEnvFileValue(
        composeEnvPath,
        "SERVICE_RUNTIME_USER_ID",
        process.env.SERVICE_RUNTIME_USER_ID
      );
    }
    ensureSandboxRepo();
    ensureComposeOriginEntries();
    ensureComposeCodexEntries();
    return;
  }
  const projectId = crypto.randomUUID();
  const anonKey = supabaseEnv.ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
  const serviceRoleKey =
    supabaseEnv.SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const serviceRuntimeUserId = process.env.SERVICE_RUNTIME_USER_ID ?? "";

  ensureSandboxRepo();
  const codexVolume = runtimeCodexVolume(runtimeRepoHost);
  const template = `# Auto-generated by run-e2e-dev.mjs
EDGE_URL=http://host.docker.internal:${controllerPort}
AGENT_REGISTER_URL=/runtime/register
AGENT_LOGIN_URL=/agent/login
AGENT_LOGIN_KEY=dev-agent-key
AGENT_TOKEN=
AGENT_KEY=dev-agent-key
SPACE_ID=${projectId}
SUPABASE_ANON_KEY=${anonKey}
SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}
RUNTIME_TYPE=codex-embedded
RUNTIME_REPO_HOST=${runtimeRepoHost}
RUNTIME_CODEX_VOLUME=${codexVolume}
WORKSPACE_DIR=/workspace
EDGE_DISPATCH_WORKFLOW_PATH=/dispatch_workflow
EDGE_DISPATCH_BUILD_PATH=/dispatch_build
EDGE_PROGRESS_CALLBACK_PATH=/progress_callback
EDGE_SUPABASE_RPC_PREFIX=/rpc
EDGE_CREATE_PULL_REQUEST_PATH=/github/create_pull_request
EDGE_SUPABASE_SQL_PATH=/sql
USE_PROXY_FOR_LLM=1
CONTROLLER_BASE_URL=http://host.docker.internal:${controllerPort}
CONTROLLER_INTERNAL_TOKEN=dev-internal-token
PROXY_BASE_URL=http://proxy:8789
PROXY_SIGNING_SECRET=dev-proxy-secret
PROXY_TOKEN_TTL_SECONDS=1800
CODEX_CHATGPT_ENDPOINT=http://proxy:8789/backend-api/codex/responses
CODEX_PROXY_CHATGPT_ENDPOINT=http://proxy:8789/backend-api/codex/responses
CODEX_API_ENDPOINT=http://proxy:8789/api
OPENAI_BASE_URL=http://proxy:8789/v1
CODEX_API_KEY=proxy-dev-key
CODEX_HOME=/workspace/.codex
CODEX_AUTH_PATH=/workspace/.codex/auth.json
CODEX_MODEL=${defaultCodexModel}
CODEX_INCLUDE_PLAN_TOOL=true
CODEX_INCLUDE_APPLY_PATCH_TOOL=true
CODEX_INCLUDE_VIEW_IMAGE_TOOL=true
SERVICE_RUNTIME_USER_ID=${serviceRuntimeUserId}
ORIGIN_ID=${crypto.randomUUID()}
ORIGIN_BIND_HOST=0.0.0.0
ORIGIN_BIND_PORT=54332
ORIGIN_ENDPOINT=http://host.docker.internal:54332
ORIGIN_SKIP_AUTH=0
ORIGIN_ENABLE_PRESENCE_HEARTBEAT=1
ORIGIN_INTERNAL_TOKEN=dev-internal-token
ORIGIN_PROTOCOLS=http
ORIGIN_MODE=desktop
ORIGIN_DEVICE_ID=runtime-desktop
ORIGIN_HOST_PORT=54332
`;
  try {
    writePrivateEnvFile(
      "docker/.env.local",
      composeEnvPath,
      template,
      { flag: "wx" },
    );
    console.log(
      `[runtime-dev] Created docker/.env.local with SPACE_ID=${projectId}`
    );
  } catch (error) {
    if (error.code !== "EEXIST")
      console.warn(
        `[runtime-dev] Unable to write docker/.env.local: ${error.message}`
      );
  }
  normalizeComposeEnvSpaceIdentifiers();
  ensureRuntimeCodexStub(codexVolume);
  ensureComposeOriginEntries();
  ensureComposeCodexEntries();
}

function ensureComposeOriginEntries() {
  if (!fileExists(composeEnvPath)) return;
  try {
    const content = fs.readFileSync(composeEnvPath, "utf-8");
    const envMap = parseEnv(content);
    const originId =
      envMap.ORIGIN_ID && UUID_PATTERN.test(envMap.ORIGIN_ID.trim())
        ? envMap.ORIGIN_ID.trim()
        : crypto.randomUUID();
    setEnvFileValue(composeEnvPath, "ORIGIN_ID", originId);
    const defaults = {
      ORIGIN_BIND_HOST: envMap.ORIGIN_BIND_HOST ?? "0.0.0.0",
      ORIGIN_BIND_PORT: envMap.ORIGIN_BIND_PORT ?? "54332",
      ORIGIN_HOST_PORT: envMap.ORIGIN_HOST_PORT ?? "54332",
      ORIGIN_SKIP_AUTH: envMap.ORIGIN_SKIP_AUTH ?? "0",
      ORIGIN_ENABLE_PRESENCE_HEARTBEAT: envMap.ORIGIN_ENABLE_PRESENCE_HEARTBEAT ?? "1",
      ORIGIN_INTERNAL_TOKEN: envMap.ORIGIN_INTERNAL_TOKEN ?? "dev-internal-token",
      ORIGIN_PROTOCOLS: envMap.ORIGIN_PROTOCOLS ?? "http",
      ORIGIN_MODE: envMap.ORIGIN_MODE ?? "desktop",
      ORIGIN_DEVICE_ID: envMap.ORIGIN_DEVICE_ID ?? "runtime-desktop",
    };
    if (defaults.ORIGIN_SKIP_AUTH === "1") {
      console.warn(
        "[runtime-dev] Warning: ORIGIN_SKIP_AUTH=1 disables origin auth. Only use this for local-only debugging; never expose it via tunnels/LBs."
      );
    }
    const resolvedHostPort = (defaults.ORIGIN_HOST_PORT ?? "54332").toString().trim();
    defaults.ORIGIN_ENDPOINT =
      envMap.ORIGIN_ENDPOINT ?? `http://host.docker.internal:${resolvedHostPort}`;
    for (const [key, value] of Object.entries(defaults)) {
      setEnvFileValue(composeEnvPath, key, value);
    }

    if ((process.env.GIT_CANONICAL || "").trim() === "1") {
      const spaceId =
        envMap.SPACE_ID && UUID_PATTERN.test(envMap.SPACE_ID.trim())
          ? envMap.SPACE_ID.trim()
          : null;
      if (spaceId) {
        setEnvFileValue(
          composeEnvPath,
          "ORIGIN_GIT_REMOTE_URL",
          envMap.ORIGIN_GIT_REMOTE_URL ?? `http://git-edge:8080/${spaceId}.git`,
        );
        setEnvFileValue(
          composeEnvPath,
          "ORIGIN_GIT_BRANCH",
          envMap.ORIGIN_GIT_BRANCH ?? "main",
        );
        setEnvFileValue(
          composeEnvPath,
          "ORIGIN_GIT_REMOTE_NAME",
          envMap.ORIGIN_GIT_REMOTE_NAME ?? "origin",
        );
        setEnvFileValue(
          composeEnvPath,
          "ORIGIN_GIT_AUTHOR_NAME",
          envMap.ORIGIN_GIT_AUTHOR_NAME ?? "instafy-origin",
        );
        setEnvFileValue(
          composeEnvPath,
          "ORIGIN_GIT_AUTHOR_EMAIL",
          envMap.ORIGIN_GIT_AUTHOR_EMAIL ?? "origin@instafy.dev",
        );
      }
    }
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to ensure origin entries in docker/.env.local: ${error.message}`
    );
  }
}

function configureComposeRuntimeRole(role, options = {}) {
  if (!fileExists(composeEnvPath)) {
    console.warn(
      `[runtime-dev] Unable to configure runtime role (${role}); docker/.env.local is missing.`
    );
    return;
  }
  const normalizedRole = role === "hosted" ? "hosted" : "desktop";
  let envMap = {};
  try {
    envMap = parseEnv(fs.readFileSync(composeEnvPath, "utf-8"));
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to read docker/.env.local while configuring runtime role: ${error.message}`
    );
  }
  const defaults = {
    ORIGIN_MODE: normalizedRole,
    ORIGIN_DEVICE_ID:
      normalizedRole === "hosted" ? "runtime-hosted" : "runtime-desktop",
    RUNTIME_TYPE:
      normalizedRole === "hosted" ? "codex-hosted" : "codex-embedded",
    RUNTIME_DISPLAY_NAME:
      normalizedRole === "hosted"
        ? "Hosted Runtime"
        : "Manual Desktop Runtime",
    ORIGIN_HOST_PORT: envMap.ORIGIN_HOST_PORT ?? "54332",
  };
  const overrides = { ...defaults, ...options };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string" && value.trim().length === 0) continue;
    setEnvFileValue(composeEnvPath, key, value);
  }
}

function ensureComposeCodexEntries() {
  if (!fileExists(composeEnvPath)) return;
  try {
    const content = fs.readFileSync(composeEnvPath, "utf-8");
    const envMap = parseEnv(content);
    const codexModel = normalizeCodexModel(
      envMap.CODEX_MODEL ?? process.env.CODEX_MODEL ?? defaultCodexModel
    );
    const runtimeRepoHost =
      envMap.RUNTIME_REPO_HOST ?? process.env.RUNTIME_REPO_HOST ?? sandboxDir;
    const desired = {
      CODEX_MODEL: codexModel,
      CODEX_HOME: "/workspace/.codex",
      CODEX_AUTH_PATH: "/workspace/.codex/auth.json",
      CODEX_CHATGPT_ENDPOINT: "http://proxy:8789/backend-api/codex/responses",
      CODEX_PROXY_CHATGPT_ENDPOINT: "http://proxy:8789/backend-api/codex/responses",
      OPENAI_BASE_URL: "http://proxy:8789/v1",
      CODEX_API_ENDPOINT: "http://proxy:8789/api",
      CODEX_API_KEY: "proxy-dev-key",
      CODEX_INCLUDE_PLAN_TOOL: envMap.CODEX_INCLUDE_PLAN_TOOL ?? "true",
      CODEX_INCLUDE_APPLY_PATCH_TOOL: envMap.CODEX_INCLUDE_APPLY_PATCH_TOOL ?? "true",
      CODEX_INCLUDE_VIEW_IMAGE_TOOL: envMap.CODEX_INCLUDE_VIEW_IMAGE_TOOL ?? "true",
      RUNTIME_CODEX_VOLUME: runtimeCodexVolume(runtimeRepoHost),
      PROXY_BASE_URL: "http://proxy:8789",
    };
    const lines = content.split(/\r?\n/);
    let modified = false;
    for (const [key, value] of Object.entries(desired)) {
      const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
      if (idx === -1) {
        lines.push(`${key}=${value}`);
        modified = true;
      } else if (lines[idx] !== `${key}=${value}`) {
        lines[idx] = `${key}=${value}`;
        modified = true;
      }
    }
    if (modified) {
      const next = lines.filter((line, idx) => line || idx === lines.length - 1);
      writePrivateEnvFile(
        "docker/.env.local",
        composeEnvPath,
        `${next.join("\n").replace(/\n+$/, "\n")}\n`,
      );
    }
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to ensure CODEX entries in docker/.env.local: ${error.message}`
    );
  }
}

function reportComposeEnv() {
  if (!fileExists(composeEnvPath)) {
    console.warn(
      "[runtime-dev] docker/.env.local not found; copy docker/.env.example and set SPACE_ID/SUPABASE_ANON_KEY."
    );
    return;
  }
  try {
    const envContent = fs.readFileSync(composeEnvPath, "utf-8");
    const envMap = parseEnv(envContent);
    for (const [k, v] of Object.entries(envMap))
      if (!(k in process.env)) process.env[k] = v;
    const spaceId = envMap.SPACE_ID ?? "";
    if (!spaceId || /00000000-0000-0000-0000-000000000000/.test(spaceId)) {
      console.warn(
        "[runtime-dev] SPACE_ID in docker/.env.local is unset or placeholder. Set a real UUID."
      );
    }
    if (!envMap.SUPABASE_ANON_KEY) {
      console.warn(
        "[runtime-dev] SUPABASE_ANON_KEY missing from docker/.env.local. Fill it from `supabase status --output env`."
      );
    }
    if (!envMap.RUNTIME_REPO_HOST) {
      console.warn(
        "[runtime-dev] RUNTIME_REPO_HOST missing; defaulting to tmp/runtime-sandbox."
      );
      ensureSandboxRepo();
      process.env.RUNTIME_REPO_HOST = sandboxDir;
    } else if (envMap.RUNTIME_REPO_HOST === repoRoot) {
      console.warn(
        "[runtime-dev] RUNTIME_REPO_HOST points at repo root; consider tmp/runtime-sandbox for isolation."
      );
    }
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to inspect docker/.env.local: ${error.message}`
    );
  }
}
function ensureComposeFile() {
  if (!fileExists(composeFile))
    throw new Error(`Cannot find docker compose file at ${composeFile}`);
}

function getProxyConfig() {
  const baseUrlRaw = process.env.PROXY_BASE_URL || "http://127.0.0.1:8789";
  try {
    const parsed = new URL(baseUrlRaw);
    const protocol = parsed.protocol || "http:";
    const defaultPort = protocol === "https:" ? 443 : 80;
    const port = Number(parsed.port) || defaultPort;
    const host = parsed.hostname || "127.0.0.1";
    // `PROXY_BASE_URL=http://proxy:8789` is only meaningful inside docker-compose networks.
    // For host-level controller/proxy checks, prefer loopback.
    if (host === "proxy") {
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        host: "127.0.0.1",
        port,
        addr: `127.0.0.1:${port}`,
      };
    }
    return {
      baseUrl: parsed.toString().replace(/\/$/, ""),
      host,
      port,
      addr: `${host}:${port}`,
    };
  } catch {
    return {
      baseUrl: baseUrlRaw,
      host: "127.0.0.1",
      port: proxyDefaultPort,
      addr: `127.0.0.1:${proxyDefaultPort}`,
    };
  }
}

function readProxyPid() {
  try {
    return Number(fs.readFileSync(proxyPidFile, "utf-8").trim());
  } catch {
    return 0;
  }
}

function writeProxyPid(pid) {
  ensureTmpDir();
  fs.writeFileSync(proxyPidFile, String(pid));
}

function clearProxyPid() {
  try {
    fs.rmSync(proxyPidFile, { force: true });
  } catch {}
}

async function stopProxyInternal() {
  const pid = readProxyPid();
  if (!pid) return false;
  console.log(`[runtime-dev] Stopping proxy (pid=${pid})...`);
  try {
    process.kill(pid, "SIGINT");
  } catch {}
  await wait(300);
  if (fileExists(proxyPidFile)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    await wait(300);
  }
  clearProxyPid();
  return true;
}

async function stopProxyCompose(options = {}) {
  const { remove = false } = options;
  ensureComposeFile();
  const args = [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "stop",
    "proxy"
  ];
  try {
    run("docker", args);
    if (remove) {
      run("docker", [
        "compose",
        "-p",
        composeProject,
        "-f",
        composeFile,
        "rm",
        "-f",
        "proxy"
      ]);
    }
    return true;
  } catch (error) {
    console.warn(`[runtime-dev] Unable to stop proxy compose service: ${error.message}`);
    return false;
  }
}

async function stopRedisCompose(options = {}) {
  const { remove = false } = options;
  ensureComposeFile();
  const args = [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "stop",
    "redis"
  ];
  try {
    run("docker", args);
    if (remove) {
      run("docker", [
        "compose",
        "-p",
        composeProject,
        "-f",
        composeFile,
        "rm",
        "-f",
        "redis"
      ]);
    }
    return true;
  } catch (error) {
    console.warn(`[runtime-dev] Unable to stop redis compose service: ${error.message}`);
    return false;
  }
}

async function stopGitCompose(options = {}) {
  const { remove = false } = options;
  ensureComposeFile();
  const args = [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "stop",
    "origin-gateway",
    "git-edge",
    "git-shard-0"
  ];
  try {
    run("docker", args);
    if (remove) {
      run("docker", [
        "compose",
        "-p",
        composeProject,
        "-f",
        composeFile,
        "rm",
        "-f",
        "origin-gateway",
        "git-edge",
        "git-shard-0"
      ]);
    }
    return true;
  } catch (error) {
    console.warn(`[runtime-dev] Unable to stop git compose services: ${error.message}`);
    return false;
  }
}

async function startTunnelBrokerIngressIfNeeded() {
  if ((process.env.RUNTIME_SKIP_TUNNEL_BROKER || "").trim() === "1") {
    return { running: false, started: false, skipped: true };
  }

  const existingBaseUrl = (process.env.TUNNEL_BROKER_BASE_URL || "").trim();
  if (existingBaseUrl.length > 0) {
    if (!process.env.TUNNEL_BROKER_TOKEN || process.env.TUNNEL_BROKER_TOKEN.trim() === "") {
      process.env.TUNNEL_BROKER_TOKEN = "dev-token";
    }
    return { running: false, started: false, configured: true };
  }

  console.log("[runtime-dev] Launching tunnel-broker ingress fixture...");
  run(
    "docker",
    [
      "compose",
      "-f",
      tunnelBrokerComposeFile,
      "-f",
      tunnelBrokerComposeOverride,
      "--profile",
      "ingress",
      "up",
      "-d",
      "postgres",
      "broker",
      "rathole",
      "traefik",
    ],
    { cwd: tunnelBrokerDir }
  );
  run(
    "docker",
    [
      "compose",
      "-f",
      tunnelBrokerComposeFile,
      "-f",
      tunnelBrokerComposeOverride,
      "--profile",
      "ingress",
      "up",
      "-d",
      "rathole-sidecar",
    ],
    { cwd: tunnelBrokerDir }
  );

  const ok = await waitForPort(tunnelBrokerPort, {
    attempts: 240,
    delayMs: 250,
    host: "127.0.0.1",
  });
  if (!ok) {
    throw new Error(
      `Tunnel-broker failed to start on 127.0.0.1:${tunnelBrokerPort}. Check logs with: docker compose -f ${tunnelBrokerComposeFile} -f ${tunnelBrokerComposeOverride} --profile ingress logs`
    );
  }

  process.env.TUNNEL_BROKER_BASE_URL = tunnelBrokerBaseUrlDefault;
  process.env.VITE_TUNNEL_BROKER_BASE_URL =
    process.env.VITE_TUNNEL_BROKER_BASE_URL || tunnelBrokerBaseUrlDefault;
  process.env.TUNNEL_BROKER_TOKEN = process.env.TUNNEL_BROKER_TOKEN || "dev-token";

  try {
    ensureDir(path.dirname(tunnelBrokerFlag));
    fs.writeFileSync(tunnelBrokerFlag, "started");
  } catch {}

  console.log(
    `[runtime-dev] Tunnel-broker is listening (TUNNEL_BROKER_BASE_URL=${tunnelBrokerBaseUrlDefault}).`
  );
  return { running: true, started: true };
}

async function stopTunnelBrokerIngressIfWeStarted() {
  if (!fileExists(tunnelBrokerFlag)) {
    return { stopped: false, skipped: true };
  }

  console.log("[runtime-dev] Stopping tunnel-broker ingress fixture...");
  try {
    run(
      "docker",
      [
        "compose",
        "-f",
        tunnelBrokerComposeFile,
        "-f",
        tunnelBrokerComposeOverride,
        "--profile",
        "ingress",
        "--profile",
        "ingress-smoke",
        "down",
      ],
      { cwd: tunnelBrokerDir }
    );
  } finally {
    try {
      fs.rmSync(tunnelBrokerFlag, { force: true });
    } catch {}
  }
  return { stopped: true };
}

async function startRedisComposeIfNeeded() {
  const existing = (process.env.REDIS_URL || "").trim();
  if (existing.length > 0) {
    return { running: false, started: false, skipped: true };
  }

  ensureComposeFile();
  console.log("[runtime-dev] Launching redis via docker compose...");
  run("docker", [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "up",
    "-d",
    "redis"
  ]);

  const ok = await waitForPort(redisPort, {
    attempts: 120,
    delayMs: 250,
    host: "127.0.0.1",
  });
  if (!ok) {
    throw new Error(
      `Redis (compose) failed to start on 127.0.0.1:${redisPort}. Check docker compose logs with: docker compose -p ${composeProject} -f ${composeFile} logs redis`
    );
  }

  process.env.REDIS_URL = redisUrlDefault;
  console.log(`[runtime-dev] Redis is listening (REDIS_URL=${redisUrlDefault}).`);
  return { running: true, started: true, compose: true };
}

async function startGitComposeIfEnabled() {
  if ((process.env.GIT_CANONICAL || "").trim() !== "1") {
    return { running: false, started: false, skipped: true };
  }

  ensureComposeFile();
  // Docker Desktop can otherwise auto-create a missing bind source only in
  // its Linux VM. The mount then becomes unusable once the empty VM-side path
  // is reclaimed, even though the container can still stat the mount point.
  // Materialize both roots on the host before Compose attaches them.
  ensureGitCanonicalBindRoots();
  console.log(
    "[runtime-dev] Launching git-canonical services via docker compose (git-edge + git-shard-0 + origin-gateway)..."
  );
  // Only git-shard-0 owns the shared dev-image build definition. Build it
  // first so the other two services never race Compose's image resolution on
  // a cold machine, then start all three from that exact local image.
  run("docker", [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "build",
    "git-shard-0"
  ]);
  const composeArgs = [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "up",
    "-d",
  ];
  if (process.env.STACK_FORCE_GIT_BUILD === "1") {
    console.log("[runtime-dev] Rebuilding git-canonical service images (forced build)...");
    composeArgs.push("--build");
  } else {
    composeArgs.push("--no-build");
  }
  composeArgs.push(
    "git-shard-0",
    "git-edge",
    "origin-gateway"
  );
  run("docker", composeArgs);

  const edgePort = Number(process.env.GIT_EDGE_PORT || 8080);
  const ok = await waitForPort(edgePort, {
    attempts: 120,
    delayMs: 500,
    host: "127.0.0.1",
  });
  if (!ok) {
    throw new Error(
      `git-edge failed to start on 127.0.0.1:${edgePort}. Check docker compose logs with: docker compose -p ${composeProject} -f ${composeFile} logs git-edge`
    );
  }

  console.log(`[runtime-dev] git-edge is listening on 127.0.0.1:${edgePort}.`);

  const originGatewayPort = Number(process.env.ORIGIN_GATEWAY_PORT || 54333);
  const originOk = await waitForPort(originGatewayPort, {
    attempts: 120,
    delayMs: 500,
    host: "127.0.0.1",
  });
  if (!originOk) {
    throw new Error(
      `origin-gateway failed to start on 127.0.0.1:${originGatewayPort}. Check docker compose logs with: docker compose -p ${composeProject} -f ${composeFile} logs origin-gateway`
    );
  }

  console.log(
    `[runtime-dev] origin-gateway is listening on 127.0.0.1:${originGatewayPort}.`
  );
  return { running: true, started: true };
}

async function startProxyIfNeeded(runtimeRepoHost, proxyConfig) {
  if (process.env.RUNTIME_SKIP_PROXY === "1") {
    console.log("[runtime-dev] Skipping proxy start (RUNTIME_SKIP_PROXY=1).");
    return { running: false, started: false, skipped: true };
  }

  const byocMode = proxyByocModeEnabled();
  if (byocMode) {
    ensureProxyCodexHomeForMode();
  }

  const { host, port, baseUrl } = proxyConfig;
  const isDockerHostAlias = host === "host.docker.internal";
  const isProxyServiceName = host === "proxy";
  const checkHost = isDockerHostAlias || isProxyServiceName ? "127.0.0.1" : host;
  const bindAddr =
    process.env.CODEX_PROXY_ADDR ||
    (byocMode || isDockerHostAlias ? `0.0.0.0:${port}` : `${host}:${port}`);

  const alreadyUp = await waitForPort(port, {
    attempts: 1,
    delayMs: 1,
    host: checkHost,
  });
  if (alreadyUp) {
    const health = await fetchProxyHealthz(proxyConfig);
    const recognizedProxy = isRecognizedProxyHealth(health);
    if (!recognizedProxy) {
      console.log(
        `[runtime-dev] Port ${baseUrl} is occupied by a non-proxy service; restarting proxy startup logic.`
      );
      await stopProxyInternal().catch(() => {});
      await stopProxyCompose({ remove: true }).catch(() => {});
      const closed = await waitForPortClose(port, { host: checkHost }).catch(() => false);
      if (!closed) {
        throw new Error(
          `A non-proxy service is still listening on ${baseUrl}. Stop it manually before retrying.`
        );
      }
    } else if (byocMode) {
      const ok =
        health &&
        health.backend === "remote_dynamic" &&
        health.requiresCredential === true;
      if (ok) {
        console.log(
          `[runtime-dev] Detected proxy already in BYOC mode on ${baseUrl}; reusing existing instance.`
        );
        return { running: true, started: false };
      }

      console.log(
        `[runtime-dev] Detected a static-credential proxy on ${baseUrl}; restarting it in the default per-user BYOC mode.`
      );
      await stopProxyInternal().catch(() => {});
      await stopProxyCompose({ remove: true }).catch(() => {});
      const closed = await waitForPortClose(port, { host: checkHost }).catch(() => false);
      if (!closed) {
        throw new Error(
          `Proxy still listening on ${baseUrl}. Stop it manually before retrying.`
        );
      }
    } else {
      const isByocProxy =
        health &&
        health.backend === "remote_dynamic" &&
        health.requiresCredential === true;
      if (!isByocProxy) {
        console.log(
          `[runtime-dev] Detected proxy on ${baseUrl}; reusing existing instance.`
        );
        return { running: true, started: false };
      }

      console.log(
        `[runtime-dev] Detected a BYOC proxy on ${baseUrl}, but RUNTIME_PROXY_STATIC_AUTH=1 requested legacy static credentials; restarting it.`
      );
      await stopProxyInternal().catch(() => {});
      await stopProxyCompose({ remove: true }).catch(() => {});
      const closed = await waitForPortClose(port, { host: checkHost }).catch(() => false);
      if (!closed) {
        throw new Error(
          `Proxy still listening on ${baseUrl}. Stop it manually before retrying.`
        );
      }
    }
  }

  const proxyCodexHome = resolveProxyCodexHome();
  const proxyAuthPath = resolveProxyAuthPath(resolveProxyCodexHome());
  try {
    fs.mkdirSync(proxyCodexHome, { recursive: true });
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to create proxy Codex directory ${proxyCodexHome}: ${error.message}`
    );
  }

  if (byocMode && fileExists(proxyAuthPath)) {
    if (!isIsolatedByocProxyAuthPath(proxyAuthPath, proxyCodexRootByoc)) {
      throw new Error(
        `Per-user BYOC mode refuses the configured static proxy credential at ${proxyAuthPath}. ` +
          "The file was not changed. Unset PROXY_CODEX_AUTH_PATH/PROXY_CODEX_HOME, or explicitly set RUNTIME_PROXY_STATIC_AUTH=1 for legacy static proxy debugging."
      );
    }
    try {
      fs.rmSync(proxyAuthPath, { force: true });
    } catch (error) {
      throw new Error(
        `Unable to clear the isolated BYOC proxy credential at ${proxyAuthPath}: ${
          error?.message || error
        }`
      );
    }
  }

  const mirroredAuth = byocMode ? false : syncProxyCodexCredentials(proxyCodexHome);
  let authExists = fileExists(proxyAuthPath);
  if (byocMode) {
    authExists = false;
  }
  if (mirroredAuth) {
    authExists = fileExists(proxyAuthPath);
    console.log(
      `[runtime-dev] Mirrored Codex credentials into ${proxyAuthPath} for proxy use.`
    );
  }
  const openAiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const useEnvKey = !byocMode && openAiKey.length > 0;

  if (!byocMode && !authExists && !useEnvKey) {
    console.error(
      `[runtime-dev] Codex auth not found at ${proxyAuthPath}. ` +
        "Run `codex login` (or set OPENAI_API_KEY) before starting the proxy."
    );
    throw new Error("Missing Codex credentials; aborting proxy startup.");
  }
  if (useEnvKey) {
    console.log("[runtime-dev] OPENAI_API_KEY detected; proxy will authenticate via environment.");
  } else if (authExists) {
    try {
      fs.mkdirSync(path.dirname(proxyAuthPath), { recursive: true });
    } catch {}
  }

  const useComposeProxy =
    !byocMode &&
    ["1", "true", "yes", "on"].includes(
      (process.env.RUNTIME_PROXY_IN_COMPOSE || "1").trim().toLowerCase()
    );

  if (useComposeProxy) {
    ensureComposeFile();
    console.log("[runtime-dev] Launching proxy via docker compose...");
    run("docker", [
      "compose",
      "-p",
      composeProject,
      "-f",
      composeFile,
      "up",
      "-d",
      "proxy"
    ]);

    const ok = await waitForPort(port, {
      attempts: 120,
      delayMs: 500,
      host: checkHost,
    });
    if (!ok) {
      throw new Error(
        `Proxy (compose) failed to start on ${bindAddr}. Check docker compose logs with: docker compose -p ${composeProject} -f ${composeFile} logs proxy`
      );
    }
    console.log("[runtime-dev] Proxy (compose) is listening.");
    return { running: true, started: true, compose: true };
  }

  ensureTmpDir();
  console.log(`[runtime-dev] Launching Codex proxy (logs → ${proxyLogPath})...`);
  console.log("[runtime-dev] Building Codex proxy (first run may take a minute while Cargo compiles)...");

  let fd = null;
  try {
    fd = fs.openSync(proxyLogPath, "a");
  } catch (error) {
    console.warn(
      `[runtime-dev] Could not open proxy log file (${proxyLogPath}); proxy output will be discarded: ${error?.message || error}`
    );
  }

  const stdio = fd != null ? ["ignore", fd, fd] : ["ignore", "ignore", "ignore"];

  if (!useEnvKey && authExists) {
    console.log(
      `[runtime-dev] Using Codex credentials at ${proxyAuthPath} (CODEX_HOME=${proxyCodexHome}).`
    );
  } else if (byocMode) {
    console.log(
      "[runtime-dev] Proxy BYOC mode: starting without any static upstream credentials (expect Studio onboarding)."
    );
  } else {
    console.log("[runtime-dev] Using OPENAI_API_KEY from environment (no auth.json required).");
  }
  console.log(
    `[runtime-dev] Proxy controller base URL: ${controllerBaseUrl}`
  );

  guardAgainstSelfReferentialProxy(proxyConfig, {
    codexChatGpt: process.env.CODEX_CHATGPT_ENDPOINT,
    codexProxyChatGpt: process.env.CODEX_PROXY_CHATGPT_ENDPOINT,
    openaiBase: process.env.OPENAI_BASE_URL,
    codexApi: process.env.CODEX_API_ENDPOINT,
  });

  const env = {
    ...process.env,
    CONTROLLER_BASE_URL: controllerBaseUrl,
    PROXY_CONTROLLER_BASE_URL: controllerBaseUrl,
    CONTROLLER_INTERNAL_TOKEN:
      process.env.CONTROLLER_INTERNAL_TOKEN || "dev-internal-token",
    PROXY_SIGNING_SECRET: process.env.PROXY_SIGNING_SECRET || "dev-proxy-secret",
    CODEX_PROXY_ADDR: bindAddr,
    CODEX_HOME: proxyCodexHome,
    PROXY_WORKSPACE_DIR: runtimeRepoHost,
  };
  if (byocMode) {
    delete env.OPENAI_API_KEY;
  }
  if (!("CODEX_INCLUDE_PLAN_TOOL" in env)) env.CODEX_INCLUDE_PLAN_TOOL = "true";
  if (!("CODEX_INCLUDE_APPLY_PATCH_TOOL" in env)) env.CODEX_INCLUDE_APPLY_PATCH_TOOL = "true";
  if (!("CODEX_INCLUDE_VIEW_IMAGE_TOOL" in env)) env.CODEX_INCLUDE_VIEW_IMAGE_TOOL = "true";
  if (!useEnvKey && authExists) {
    env.CODEX_AUTH_PATH = proxyAuthPath;
  } else {
    delete env.CODEX_AUTH_PATH;
  }

  // The proxy talks to upstream providers directly, so ensure any
  // Instafy runtime overrides that point to the proxy itself are removed.
  delete env.CODEX_CHATGPT_ENDPOINT;
  delete env.CODEX_PROXY_CHATGPT_ENDPOINT;
  delete env.OPENAI_BASE_URL;
  delete env.CODEX_API_ENDPOINT;

  console.log(`[runtime-dev] Starting proxy with CODEX_PROXY_ADDR=${env.CODEX_PROXY_ADDR}`);
  try {
    const bytes = Buffer.from(env.CODEX_PROXY_ADDR, "utf-8");
    console.log(
      `[runtime-dev] Proxy bind addr bytes=${Array.from(bytes).join(",")}`
    );
  } catch {}

  const child = spawn(
    "cargo",
    ["run", "--manifest-path", proxyManifest, "--bin", "proxy"],
    {
      cwd: repoRoot,
      env,
      detached: true,
      stdio,
    }
  );
  let proxyExited = false;
  let proxyExitCode = null;
  let proxyExitSignal = null;
  child.once("exit", (code, signal) => {
    proxyExited = true;
    proxyExitCode = code;
    proxyExitSignal = signal;
  });

  if (fd != null) {
    try {
      fs.closeSync(fd);
    } catch {}
  }

  console.log(`[runtime-dev] Proxy started (pid=${child.pid}).`);
  writeProxyPid(child.pid);

  console.log(
    `[runtime-dev] Waiting for proxy to listen on ${bindAddr} (base URL ${baseUrl})...`
  );
  const ok = await (async () => {
    const delayMs = 500;
    const timeoutSeconds = Number(process.env.RUNTIME_PROXY_STARTUP_TIMEOUT_SECONDS || 600);
    const attempts = Math.max(1, Math.ceil((timeoutSeconds * 1000) / delayMs));
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (proxyExited) return false;
      // eslint-disable-next-line no-await-in-loop
      const listening = await waitForPort(port, {
        attempts: 1,
        delayMs: 1,
        host: checkHost,
      });
      if (listening) return true;
      // eslint-disable-next-line no-await-in-loop
      await wait(delayMs);
    }
    return false;
  })();
  if (!ok) {
    await stopProxyInternal().catch(() => {});
    if (proxyExited) {
      throw new Error(
        `Proxy exited before listening (code=${proxyExitCode ?? "null"}, signal=${
          proxyExitSignal ?? "null"
        }). Check logs at: ${proxyLogPath}`
      );
    }
    throw new Error(
      `Proxy failed to start on ${bindAddr}. Check logs at: ${proxyLogPath}`
    );
  }

  child.unref();
  console.log(`[runtime-dev] Proxy is listening on ${bindAddr}.`);
  return { running: true, started: true, pid: child.pid };
}

async function stopProxyIfWeStarted() {
  let stopped = false;
  if (fileExists(proxyPidFile)) {
    stopped = await stopProxyInternal();
  }
  const composeStopped = await stopProxyCompose({ remove: true });
  return stopped || composeStopped;
}

async function ensureProviderStartedIfConfigured() {
  // If the caller explicitly set DEV_PROVIDER_ENDPOINT, assume they manage the provider lifecycle.
  if (process.env.DEV_PROVIDER_ENDPOINT) {
    return { running: true, started: false, pid: readProviderPid() };
  }
  return startProviderService();
}

async function proxyStatus(proxyConfig = getProxyConfig()) {
  const hasPid = fileExists(proxyPidFile);
  const pid = readProxyPid();
  const checkHost =
    proxyConfig.host === "host.docker.internal" ? "127.0.0.1" : proxyConfig.host;
  const ready = await waitForPort(proxyConfig.port, {
    attempts: 1,
    delayMs: 1,
    host: checkHost,
  });
  console.log(
    `[runtime-dev] Proxy ${ready ? "UP" : "DOWN"} on ${proxyConfig.baseUrl}${
      hasPid ? ` (pid=${pid})` : ""
    }`
  );
  if (fileExists(proxyLogPath)) {
    console.log(`Proxy log file: ${proxyLogPath}`);
  }
}

// ─────────────────────── controller helpers ───────────────────────
function readPid() {
  try {
    return Number(fs.readFileSync(controllerPidFile, "utf-8").trim());
  } catch {
    return 0;
  }
}
function writePid(pid) {
  ensureTmpDir();
  fs.writeFileSync(controllerPidFile, String(pid));
}
function clearPid() {
  try {
    fs.rmSync(controllerPidFile, { force: true });
  } catch {}
}
function readProviderPid() {
  try {
    return Number(fs.readFileSync(providerPidFile, "utf-8").trim());
  } catch {
    return 0;
  }
}
function writeProviderPid(pid) {
  ensureTmpDir();
  fs.writeFileSync(providerPidFile, String(pid));
}
function clearProviderPid() {
  try {
    fs.rmSync(providerPidFile, { force: true });
  } catch {}
}
function killPid(pid, signal = "SIGINT") {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────── provider service helpers ─────────────────────
function isProviderProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  const result = tryCapture("ps", ["-p", String(pid), "-o", "command="]);
  if (result.code !== 0) {
    return false;
  }
  const command = (result.stdout ?? "").trim().toLowerCase();
  if (!command) {
    return false;
  }
  return command.includes("runtime-provider-service");
}

function findProviderPidByPort() {
  const byPort = tryCapture("lsof", ["-ti", `:${providerPort}`]);
  if (byPort.code !== 0 || !(byPort.stdout ?? "").trim()) {
    return 0;
  }
  for (const pid of parsePidOutput(byPort.stdout ?? "")) {
    if (isProviderProcess(pid)) {
      return pid;
    }
  }
  return 0;
}

function providerEnv(baseEnv = {}) {
  const env = { ...process.env, ...baseEnv };
  env.RUST_LOG = env.RUST_LOG || "info,runtime_provider=info";
  env.PROVIDER_ID = env.PROVIDER_ID || "instafy-cloud";
  env.PROVIDER_KIND = env.PROVIDER_KIND || "docker";
  env.PROVIDER_DISPLAY_NAME = env.PROVIDER_DISPLAY_NAME || "Local Provider";
  env.PROVIDER_PORT = env.PROVIDER_PORT || String(providerPort);
  env.PROVIDER_AUTH_TOKEN = env.PROVIDER_AUTH_TOKEN || "dev-provider-token";
  env.CONTROLLER_BASE_URL =
    env.CONTROLLER_BASE_URL || `http://host.docker.internal:${controllerPort}`;
  env.CODEX_MODEL = normalizeCodexModel(env.CODEX_MODEL || defaultCodexModel);
  env.DOCKER_COMPOSE_FILE = env.DOCKER_COMPOSE_FILE || path.join(repoRoot, "docker", "docker-compose.runtime.yml");
  env.DOCKER_SERVICE = env.DOCKER_SERVICE || "runtime";
  env.DOCKER_PROJECT_PREFIX = env.DOCKER_PROJECT_PREFIX || "instafy-runtime-";
  env.PROXY_CODEX_VOLUME = env.PROXY_CODEX_VOLUME || resolveProxyCodexHome();
  env.RUNTIME_AGENT_WEBDEV_IMAGE = env.RUNTIME_AGENT_WEBDEV_IMAGE || "runtime-agent:webdev";
  // Compose operations are prone to flaking on Docker Desktop when many stacks churn quickly.
  // Keep concurrency low by default for local dev + Playwright.
  env.DOCKER_MAX_CONCURRENT_OPS = env.DOCKER_MAX_CONCURRENT_OPS || "1";
  const gitCanonicalEnabled = (env.GIT_CANONICAL || "").trim() === "1";
  const defaultRepoHost = gitCanonicalEnabled
    ? path.join(repoRoot, "tmp", "origin-gateway-workspaces")
    : sandboxDir;
  const runtimeRepoHostOverride =
    !gitCanonicalEnabled && (env.RUNTIME_REPO_HOST || "").trim()
      ? env.RUNTIME_REPO_HOST
      : "";
  env.DOCKER_REPO_HOST = env.DOCKER_REPO_HOST || runtimeRepoHostOverride || defaultRepoHost;
  env.DOCKER_CODEX_ROOT = env.DOCKER_CODEX_ROOT || sandboxDir;
  if (proxyByocModeEnabled()) {
    const proxyPort = getProxyConfig().port;
    env.PROXY_BASE_URL = `http://host.docker.internal:${proxyPort}`;
  }
  // Let runtime proxy bindings use random host ports to avoid conflicts with the host-level proxy.
  env.PROXY_PORT = env.PROXY_PORT || "0";
  return env;
}

function providerLogFd() {
  ensureTmpDir();
  ensureDir(logsDir);
  return fs.openSync(providerLogPath, "a");
}

async function waitForProvider(port) {
  const host = providerBaseUrl.includes("host.docker.internal") ? "127.0.0.1" : "127.0.0.1";
  const configuredAttempts = Number(process.env.RUNTIME_PROVIDER_BOOT_ATTEMPTS);
  const configuredDelayMs = Number(process.env.RUNTIME_PROVIDER_BOOT_DELAY_MS);
  const attempts =
    Number.isFinite(configuredAttempts) && configuredAttempts > 0 ? configuredAttempts : 360;
  const delayMs =
    Number.isFinite(configuredDelayMs) && configuredDelayMs > 0 ? configuredDelayMs : 500;
  return waitForPort(port, { attempts, delayMs, host });
}

async function startProviderService() {
  if (fileExists(providerPidFile)) {
    const pid = readProviderPid();
    if (pid && killPid(pid, 0)) {
      const ready = await waitForProvider(providerPort);
      if (ready) {
        console.log(`[runtime-dev] Provider already running (pid=${pid}).`);
        return { running: true, started: false, pid };
      }
    }
    clearProviderPid();
  }

  const existingPid = findProviderPidByPort();
  if (existingPid) {
    writeProviderPid(existingPid);
    console.log(`[runtime-dev] Provider already running (pid=${existingPid}).`);
    return { running: true, started: false, pid: existingPid };
  }

  const stdio = ["ignore", providerLogFd(), providerLogFd()];
  console.log(`[runtime-dev] Starting provider service on ${providerBaseUrl}...`);
  const child = spawn(
    "cargo",
    ["run", "--manifest-path", providerManifest, "--bin", "runtime-provider-service"],
    {
      cwd: repoRoot,
      env: providerEnv(),
      detached: true,
      stdio,
    }
  );
  writeProviderPid(child.pid);
  child.unref();

  const ready = await waitForProvider(providerPort);
  if (!ready) {
    await stopProviderService().catch(() => {});
    throw new Error(`provider service failed to start on port ${providerPort}. Logs: ${providerLogPath}`);
  }

  const listeningPid = findProviderPidByPort();
  if (!listeningPid || listeningPid !== child.pid || !killPid(child.pid, 0)) {
    await stopProviderService().catch(() => {});
    throw new Error(
      `provider service failed to bind on port ${providerPort} (pid=${child.pid}). ` +
        `Check for an existing process listening on ${providerPort}. Logs: ${providerLogPath}`
    );
  }

  console.log(`[runtime-dev] Provider service listening on ${providerBaseUrl} (pid=${child.pid}).`);
  return { running: true, started: true, pid: child.pid };
}

async function stopProviderService() {
  const fromFile = readProviderPid();
  const pid = fromFile && killPid(fromFile, 0) ? fromFile : findProviderPidByPort();
  if (!pid) {
    clearProviderPid();
    return false;
  }
  clearProviderPid();
  const stopped = killPid(pid, "SIGINT") || killPid(pid, "SIGTERM");
  return stopped;
}

function forceKillControllerProcess() {
  try {
    const result = spawnSync("pkill", ["-f", "runtime-controller"], {
      stdio: "ignore"
    });
    return (result.status ?? result.code ?? 0) === 0;
  } catch {
    return false;
  }
}
function parsePidOutput(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}
function isControllerProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  const result = tryCapture("ps", ["-p", String(pid), "-o", "command="]);
  if (result.code !== 0) {
    return false;
  }
  const command = (result.stdout ?? "").trim().toLowerCase();
  if (!command) {
    return false;
  }
  return command.includes("runtime-controller");
}
function listControllerPids() {
  const pids = new Set();

  const byName = tryCapture("pgrep", ["-f", "runtime-controller"]);
  if (byName.code === 0) {
    for (const pid of parsePidOutput(byName.stdout ?? "")) {
      pids.add(pid);
    }
  }

  if (pids.size === 0) {
    const byPort = tryCapture("lsof", ["-ti", `:${controllerPort}`]);
    if (byPort.code === 0 && (byPort.stdout ?? "").trim()) {
      for (const pid of parsePidOutput(byPort.stdout ?? "")) {
        if (isControllerProcess(pid)) {
          pids.add(pid);
        }
      }
    }
  }

  return Array.from(pids);
}
async function terminateControllerProcesses(pids) {
  if (!Array.isArray(pids) || pids.length === 0) {
    return false;
  }
  let signalled = false;
  const signals = ["SIGINT", "SIGTERM", "SIGKILL"];

  for (const signal of signals) {
    let anySentThisRound = false;
    for (const pid of pids) {
      if (killPid(pid, signal)) {
        signalled = true;
        anySentThisRound = true;
      }
    }
    if (!anySentThisRound) {
      continue;
    }
    await wait(signal === "SIGKILL" ? 150 : 400);
    const stillListening = await waitForPort(controllerPort, {
      attempts: 1,
      delayMs: 1,
    });
    if (!stillListening) {
      break;
    }
  }

  const closed = await waitForPortClose(controllerPort);
  if (!closed) {
    console.warn(
      `[runtime-dev] Controller port ${controllerPort} still in use after termination attempts (pids: ${pids.join(
        ", "
      )}).`
    );
  }
  return signalled && closed;
}
async function stopControllerInternal() {
  const pid = readPid();
  if (!pid) return false;
  console.log(`[runtime-dev] Stopping controller (pid=${pid})...`);
  if (!killPid(pid, "SIGINT")) {
    console.warn("[runtime-dev] SIGINT failed or not running; trying SIGTERM...");
    if (!killPid(pid, "SIGTERM")) {
      console.warn("[runtime-dev] SIGTERM failed; trying SIGKILL...");
      killPid(pid, "SIGKILL");
    }
  }
  await wait(500);
  clearPid();
  const closed = await waitForPortClose(controllerPort);
  if (!closed) {
    console.warn(
      `[runtime-dev] Controller port ${controllerPort} still in use after stopping pid ${pid}.`
    );
  }
  return closed;
}
async function startControllerIfNeeded(
  supabaseEnv,
  proxyConfig = getProxyConfig(),
  runtimeRepoHost,
  runtimeCodexRoot
) {
  if (process.env.RUNTIME_SKIP_CONTROLLER === "1") {
    console.log("[runtime-dev] Skipping controller start (RUNTIME_SKIP_CONTROLLER=1).");
    return { running: false, started: false, skipped: true };
  }

  // Reuse if already running
  const alreadyUp = await waitForPort(controllerPort, { attempts: 1, delayMs: 1 });
  if (alreadyUp) {
    let jwksReady = false;
    try {
      const response = await fetch(`${controllerBaseUrl}/.well-known/jwks.json`);
      if (response.ok) {
        const body = await response.json();
        jwksReady = Array.isArray(body?.keys) && body.keys.length > 0;
      }
    } catch {
      jwksReady = false;
    }
    if (!jwksReady) {
      console.log("[runtime-dev] Controller running without origin signing key; restarting...");
      const stopped = await stopControllerInternal().catch((error) => {
        console.warn(`[runtime-dev] Failed to stop existing controller: ${error?.message || error}`);
        return false;
      });
      if (!stopped) {
        const killed = forceKillControllerProcess();
        if (killed) {
          await waitForPortClose(controllerPort);
        }
      } else {
        await waitForPortClose(controllerPort);
      }
    } else {
      console.log(`[runtime-dev] Detected controller on ${controllerBaseUrl}; reusing existing instance.`);
      try {
        run("node", ["scripts/runtime-projects.mjs", "ensure", `--base-url=${controllerBaseUrl}`, "--quiet"]);
      } catch (error) {
        console.warn(
          `[runtime-dev] Warning: unable to ensure runtime project registry while reusing controller (${error.message}).`
        );
      }
      return { running: true, started: false };
    }
  }

  // ---- derive env from Supabase + process ----
  const dbUrl =
    process.env.DATABASE_URL ||
    supabaseEnv.DB_URL ||
    supabaseEnv.DATABASE_URL ||
    `postgresql://postgres:postgres@127.0.0.1:54322/postgres`;

  const supabaseProjectUrl =
    process.env.SUPABASE_PROJECT_URL ||
    process.env.SUPABASE_URL ||
    supabaseEnv.SUPABASE_PROJECT_URL ||
    supabaseEnv.SUPABASE_URL ||
    DEFAULT_SUPABASE_PROJECT_URL;
  if (
    !process.env.SUPABASE_PROJECT_URL &&
    !process.env.SUPABASE_URL &&
    !supabaseEnv.SUPABASE_PROJECT_URL &&
    !supabaseEnv.SUPABASE_URL
  ) {
    console.log(
      `[runtime-dev] SUPABASE_PROJECT_URL not provided; defaulting to ${DEFAULT_SUPABASE_PROJECT_URL}.`
    );
  }

  const internalToken = process.env.CONTROLLER_INTERNAL_TOKEN || "dev-internal-token";
  const proxySigningSecret = process.env.PROXY_SIGNING_SECRET || "dev-proxy-secret";
  const proxyBaseUrl = proxyConfig.baseUrl;
  const proxyTtl = process.env.PROXY_TOKEN_TTL_SECONDS || "1800";

  const workspaceRootEnv =
    process.env.WORKSPACE_ROOT || process.env.RUNTIME_REPO_HOST || sandboxDir;
  try {
    if (workspaceRootEnv) {
      fs.mkdirSync(workspaceRootEnv, { recursive: true });
    }
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to ensure WORKSPACE_ROOT directory ${workspaceRootEnv}: ${error.message}`
    );
  }

  const env = {
    ...process.env,
    PORT: String(controllerPort),
    DATABASE_URL: dbUrl,
    // Match the controller's dev-mode default so local e2e runs have a little more headroom
    // once multi-session org tests overlap with SSE + runtime status traffic.
    DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE || "12",
    SUPABASE_PROJECT_URL: supabaseProjectUrl,
    AGENT_LOGIN_KEY: process.env.AGENT_LOGIN_KEY || "dev-agent-key",
    CONTROLLER_INTERNAL_TOKEN: internalToken,
    PROXY_SIGNING_SECRET: proxySigningSecret,
    PROXY_BASE_URL: proxyBaseUrl,
    PROXY_TOKEN_TTL_SECONDS: proxyTtl,
    RUST_LOG: process.env.RUST_LOG || "runtime_controller=info",
    WORKSPACE_ROOT: workspaceRootEnv,
    // Keep dev ergonomics: longer-lived runtime tokens and dev mode on.
    RUNTIME_SIGNING_TOKEN_TTL_SECONDS:
      process.env.RUNTIME_SIGNING_TOKEN_TTL_SECONDS || "3600",
    RUNTIME_LEASE_PATH: process.env.RUNTIME_LEASE_PATH || "/agent/lease",
    RUNTIME_HEARTBEAT_PATH: process.env.RUNTIME_HEARTBEAT_PATH || "/agent/heartbeat",
    DEV_MODE: process.env.DEV_MODE || "1",
  };
  if (proxyByocModeEnabled()) {
    delete env.OPENAI_API_KEY;
  }
  if (!env.GIT_REMOTE_BASE_URL && (process.env.GIT_CANONICAL || "").trim() === "1") {
    const edgePort = Number(process.env.GIT_EDGE_PORT || 8080);
    env.GIT_REMOTE_BASE_URL = `http://host.docker.internal:${edgePort}`;
  }
  if (!env.GIT_SHARDS && (process.env.GIT_CANONICAL || "").trim() === "1") {
    env.GIT_SHARDS = process.env.GIT_SHARDS || "http://git-shard-0:8081";
  }
  if (!env.HOSTED_ORIGIN_ENDPOINT && (process.env.GIT_CANONICAL || "").trim() === "1") {
    const originGatewayPort = Number(process.env.ORIGIN_GATEWAY_PORT || 54333);
    env.HOSTED_ORIGIN_ENDPOINT = `http://127.0.0.1:${originGatewayPort}`;
  }
  if (!env.DEV_PROJECT_REGISTRY_PATH) {
    env.DEV_PROJECT_REGISTRY_PATH =
      process.env.DEV_PROJECT_REGISTRY_PATH || projectRegistryPath;
  }
  if (!env.SUPABASE_JWT_SECRET && supabaseEnv.JWT_SECRET) {
    env.SUPABASE_JWT_SECRET = supabaseEnv.JWT_SECRET;
  }
  if (!env.JWT_SECRET && supabaseEnv.JWT_SECRET) {
    env.JWT_SECRET = supabaseEnv.JWT_SECRET;
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY && supabaseEnv.SERVICE_ROLE_KEY) {
    env.SUPABASE_SERVICE_ROLE_KEY = supabaseEnv.SERVICE_ROLE_KEY;
  }

  if (!env.RUNTIME_ALLOCATOR || env.RUNTIME_ALLOCATOR.trim().length === 0) {
    env.RUNTIME_ALLOCATOR = "docker";
  }
  if (!env.RUNTIME_PROVIDERS || env.RUNTIME_PROVIDERS.trim().length === 0) {
    env.RUNTIME_PROVIDERS = JSON.stringify([
      { id: "runtime", displayName: "Local Docker", kind: "docker" },
    ]);
  }
  if (
    (!env.RUNTIME_DOCKER_REPO_HOST || env.RUNTIME_DOCKER_REPO_HOST.trim().length === 0) &&
    runtimeRepoHost
  ) {
    env.RUNTIME_DOCKER_REPO_HOST = runtimeRepoHost;
  }
  if (
    (!env.RUNTIME_DOCKER_CODEX_ROOT || env.RUNTIME_DOCKER_CODEX_ROOT.trim().length === 0) &&
    runtimeCodexRoot
  ) {
    env.RUNTIME_DOCKER_CODEX_ROOT = runtimeCodexRoot;
  }
  if (
    !env.RUNTIME_ALLOCATOR_REQUIRED ||
    env.RUNTIME_ALLOCATOR_REQUIRED.trim().length === 0
  ) {
    env.RUNTIME_ALLOCATOR_REQUIRED =
      process.env.RUNTIME_ALLOCATOR_REQUIRED || "1";
  }

  if (!env.RUNTIME_STRICT_MODE) {
    env.RUNTIME_STRICT_MODE = process.env.RUNTIME_STRICT_MODE || "0";
  }
  if (!env.RUNTIME_DEV_ISOLATION) {
    env.RUNTIME_DEV_ISOLATION = process.env.RUNTIME_DEV_ISOLATION || "0";
  }
  if (!env.RUNTIME_AUTO_CREATE_PROJECTS) {
    env.RUNTIME_AUTO_CREATE_PROJECTS =
      process.env.RUNTIME_AUTO_CREATE_PROJECTS || "1";
  }

  const originKeys = ensureOriginSigningKeys();
  env.RUNTIME_SIGNING_PRIVATE_KEY = originKeys.privateKey;
  env.RUNTIME_SIGNING_PUBLIC_KEY = originKeys.publicKey;
  env.RUNTIME_SIGNING_KEY_ID = originKeys.keyId;
  env.CREDENTIAL_ENCRYPTION_KEY = ensureCredentialEncryptionKey();
  const proxyAuthPath = resolveProxyAuthPath(resolveProxyCodexHome());
  if (fileExists(proxyAuthPath)) {
    env.CODEX_AUTH_PATH = proxyAuthPath;
  }

  if (!supabaseProjectUrl) {
    console.warn("[runtime-dev] SUPABASE project URL missing; controller will fail to verify JWTs.");
  }

  // ---- spawn detached with file-backed stdio so parent can exit ----
  ensureTmpDir();
  ensureDefaultProviderSeed();
  console.log(`[runtime-dev] Launching runtime controller (logs → ${controllerLogPath})...`);
  if (fileExists(controllerLogPath)) {
    try {
      fs.truncateSync(controllerLogPath, 0);
    } catch (error) {
      console.warn(
        `[runtime-dev] Unable to truncate existing controller log (${controllerLogPath}): ${error.message}`
      );
    }
  }

  let fd = null;
  try {
    fd = fs.openSync(controllerLogPath, "a"); // one fd for both stdout/stderr
  } catch (e) {
    console.warn(`[runtime-dev] Could not open log file (${controllerLogPath}); controller output will be discarded: ${e?.message || e}`);
  }

  const stdio = fd != null ? ["ignore", fd, fd] : ["ignore", "ignore", "ignore"];
  const shouldStreamControllerLogs =
    (process.env.RUNTIME_CONTROLLER_STREAM_LOGS || "1").toLowerCase() !== "0";
  let stopControllerLogStream = null;
  if (shouldStreamControllerLogs) {
    console.log("[runtime-dev] Streaming controller logs until startup completes...");
    stopControllerLogStream = streamFileAppends(controllerLogPath, { label: "controller" });
  }

  console.log(`[runtime-dev] Starting controller with manifest ${controllerManifest}`);
  let child;
  try {
    child = spawn(
      "cargo",
      ["run", "--manifest-path", controllerManifest],
      {
        cwd: repoRoot,
        env,
        detached: true,      // run in its own process group/session
        stdio,               // no pipes -> no active handles in parent
      }
    );
  } catch (error) {
    if (stopControllerLogStream) {
      stopControllerLogStream();
    }
    throw error;
  }

  // Close our copy of the log fd; the child inherits its own
  if (fd != null) {
    try { fs.closeSync(fd); } catch {}
  }

  console.log(`[runtime-dev] Controller started (pid=${child.pid}).`);
  // Record PID for 'down' / stop helper
  writePid(child.pid);

  // Allow parent to exit even if the child is alive
  child.unref();
  let exitInfo = { code: null, signal: null };
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  try {
    // ---- wait for readiness or fail with helpful message ----
    console.log(
      `[runtime-dev] Waiting for controller to listen on port ${controllerPort}...`
    );
    let ok = false;
    const configuredAttempts = Number(process.env.RUNTIME_CONTROLLER_BOOT_ATTEMPTS);
    const configuredDelayMs = Number(process.env.RUNTIME_CONTROLLER_BOOT_DELAY_MS);
    const ciValue = (process.env.CI || "").trim().toLowerCase();
    const isCi = ciValue === "1" || ciValue === "true" || process.env.GITHUB_ACTIONS === "true";
    const defaultAttempts = isCi ? 300 : 120; // CI runners can take longer on cold Cargo builds.
    const maxAttempts =
      Number.isFinite(configuredAttempts) && configuredAttempts > 0
        ? configuredAttempts
        : defaultAttempts;
    const waitDelayMs =
      Number.isFinite(configuredDelayMs) && configuredDelayMs > 0
        ? configuredDelayMs
        : 1000;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (child.exitCode !== null || exitInfo.code !== null || exitInfo.signal) {
        const details =
          exitInfo.signal != null
            ? `signal ${exitInfo.signal}`
            : `exit code ${exitInfo.code ?? child.exitCode ?? "unknown"}`;
        await stopControllerInternal().catch(() => {});
        throw new Error(
          `Controller exited (${details}) before listening on port ${controllerPort}. ` +
            `Check logs at: ${controllerLogPath}`
        );
      }
      ok = await waitForPort(controllerPort, { attempts: 1, delayMs: waitDelayMs });
      if (ok) break;
    }
    if (!ok) {
      await stopControllerInternal().catch(() => {});
      throw new Error(
        `Controller failed to start on port ${controllerPort} within timeout. ` +
          `Check logs at: ${controllerLogPath}`
      );
    }
    if (child.exitCode !== null || exitInfo.code !== null || exitInfo.signal) {
      const details =
        exitInfo.signal != null
          ? `signal ${exitInfo.signal}`
          : `exit code ${exitInfo.code ?? child.exitCode ?? "unknown"}`;
      await stopControllerInternal().catch(() => {});
      throw new Error(
        `Controller exited (${details}) immediately after starting. ` +
          `Check logs at: ${controllerLogPath}`
      );
    }

    console.log(`[runtime-dev] Controller is listening on ${controllerPort}.`);

    try {
      run("node", ["scripts/runtime-projects.mjs", "ensure", `--base-url=${controllerBaseUrl}`, "--quiet"]);
    } catch (error) {
      console.warn(`[runtime-dev] Warning: unable to ensure runtime project registry (${error.message}).`);
    }

    return { running: true, started: true, pid: child.pid };
  } finally {
    if (stopControllerLogStream) {
      stopControllerLogStream();
    }
  }
}

async function stopControllerIfWeStarted() {
  if (fileExists(controllerPidFile)) {
    const stopped = await stopControllerInternal();
    if (stopped) {
      return true;
    }
    console.warn(
      `[runtime-dev] Controller port ${controllerPort} still responding after managed shutdown; attempting forced cleanup.`
    );
  }

  const stillListening = await waitForPort(controllerPort, {
    attempts: 1,
    delayMs: 1,
  });
  if (!stillListening) {
    return false;
  }

  console.warn(
    `[runtime-dev] Controller still responding on ${controllerBaseUrl}; attempting forced shutdown...`
  );
  const candidatePids = listControllerPids();
  if (candidatePids.length === 0) {
    const forced = forceKillControllerProcess();
    if (forced) {
      const closed = await waitForPortClose(controllerPort);
      if (closed) {
        clearPid();
        return true;
      }
      console.warn(
        `[runtime-dev] Controller process was signalled but port ${controllerPort} is still active.`
      );
      return false;
    }
    console.warn(
      `[runtime-dev] Unable to locate a controller process to stop automatically. ` +
        `If you started it manually, terminate the process listening on port ${controllerPort}.`
    );
    return false;
  }

  const terminated = await terminateControllerProcesses(candidatePids);
  if (terminated) {
    clearPid();
    return true;
  }

  console.warn(
    `[runtime-dev] Controller processes (${candidatePids.join(
      ", "
    )}) resisted termination. Please stop them manually before restarting.`
  );
  return false;
}
async function controllerStatus() {
  const hasPid = fileExists(controllerPidFile);
  const pid = readPid();
  const ready = await waitForPort(controllerPort, { attempts: 1, delayMs: 1 });
  console.log(
    `[runtime-dev] Controller ${ready ? "UP" : "DOWN"} on ${controllerBaseUrl}${
      hasPid ? ` (pid=${pid})` : ""
    }`
  );
  if (fileExists(controllerLogPath)) {
    console.log(`Log file: ${controllerLogPath}`);
  }
}

// ───────────────────────── runtime helpers ─────────────────────────
async function buildRuntimeContext(options = {}) {
  const {
    ensureSupabase: shouldEnsureSupabase = true
  } = options;

  ensureProxyCodexHomeForMode();

  ensureComposeFile();

  if (!process.env.RUNTIME_STRICT_MODE) {
    process.env.RUNTIME_STRICT_MODE = "0";
  }
  if (!process.env.RUNTIME_DEV_ISOLATION) {
    process.env.RUNTIME_DEV_ISOLATION = "1";
  }
  if (!process.env.RUNTIME_DEV_MODE) {
    process.env.RUNTIME_DEV_MODE = "1";
  }
  
  const supabaseStatus = shouldEnsureSupabase
    ? await ensureSupabase()
    : { running: false, started: false, skipped: true };
  let supabaseEnv = {};
  try {
    const envOutput = runCaptureSupabase(["status", "--output", "env"]);
    supabaseEnv = parseEnv(envOutput);
  } catch (error) {
    if (shouldEnsureSupabase) {
      console.warn(`[runtime-dev] Unable to read Supabase env: ${error.message}`);
    } else {
      console.warn(
      `[runtime-dev] Supabase env unavailable (runtime helpers are continuing without it): ${error.message}`
      );
    }
  }

  if (shouldEnsureSupabase) {
    configureSupabaseSecrets(supabaseEnv);
  }
  const supabaseProjectUrl =
    process.env.SUPABASE_PROJECT_URL ||
    process.env.SUPABASE_URL ||
    supabaseEnv.SUPABASE_PROJECT_URL ||
    supabaseEnv.SUPABASE_URL ||
    "";


  const resolvedServiceRoleKey =
    supabaseEnv.SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    readEnvValueFromFiles(supabaseEnvCandidates, "SERVICE_ROLE_KEY") ||
    "";
  if (resolvedServiceRoleKey) {
    process.env.SUPABASE_SERVICE_ROLE_KEY = resolvedServiceRoleKey;
  }

  const resolvedJwtSecret =
    supabaseEnv.JWT_SECRET ||
    supabaseEnv.SUPABASE_JWT_SECRET ||
    process.env.SUPABASE_JWT_SECRET ||
    process.env.JWT_SECRET ||
    readEnvValueFromFiles(supabaseEnvCandidates, "JWT_SECRET") ||
    readEnvValueFromFiles(supabaseEnvCandidates, "SUPABASE_JWT_SECRET") ||
    "";
  if (resolvedJwtSecret) {
    process.env.SUPABASE_JWT_SECRET = resolvedJwtSecret;
    process.env.JWT_SECRET = resolvedJwtSecret;
  }
 
  if (shouldEnsureSupabase) {
    ensureEdgeEnvSupabase(supabaseProjectUrl);
    const authReady = await waitForSupabaseAuthReady(supabaseEnv);
    if (!authReady) {
      console.warn(
        "[runtime-dev] Supabase auth health check did not succeed; service runtime setup may fail."
      );
    }
    const adminReady = authReady
      ? await waitForSupabaseAdminReady(supabaseEnv)
      : false;
    if (!adminReady) {
      console.warn(
        "[runtime-dev] Supabase admin API not ready; skipping service runtime user setup for now."
      );
    }
    const serviceRuntime = adminReady
      ? await ensureServiceRuntimeUserId(supabaseEnv)
      : null;
    if (serviceRuntime?.id) {
      process.env.SERVICE_RUNTIME_USER_ID = serviceRuntime.id;
      setEnvFileValue(edgeEnvPath, "SERVICE_RUNTIME_USER_ID", serviceRuntime.id);
    }
  }


  ensureComposeEnv(supabaseEnv);
  reportComposeEnv();

  const runtimeRepoHost = process.env.RUNTIME_REPO_HOST ?? sandboxDir;
  const runtimeCodexHome = runtimeCodexVolume(runtimeRepoHost);
  ensureRuntimeCodexStub(runtimeCodexHome);

  const proxyCodexHome = resolveProxyCodexHome();
  if (proxyByocModeEnabled()) {
    ensureDir(proxyCodexHome);
    console.log(
      `[runtime-dev] Per-user BYOC proxy mode enabled by default; leaving ~/.codex/auth.json for Studio onboarding (${proxyCodexHome}).`
    );
  } else {
    syncProxyCodexCredentials(proxyCodexHome);
  }

  const proxyConfig = getProxyConfig();

  // Bring up a local provider service when none is specified so the controller can talk
  // to an external_http provider that wraps the docker allocator.
  if (!process.env.DEV_PROVIDER_ENDPOINT) {
    await ensureProviderStartedIfConfigured();
    process.env.DEV_PROVIDER_ENDPOINT = providerBaseUrl;
    process.env.DEV_PROVIDER_AUTH_TOKEN =
      process.env.DEV_PROVIDER_AUTH_TOKEN || "dev-provider-token";
  }

  return {
    supabaseStatus,
    supabaseEnv,
    runtimeRepoHost,
    runtimeCodexHome,
    proxyCodexHome,
    proxyConfig
  };
}

async function ensureControllerStack(ctx) {
  await startRedisComposeIfNeeded();
  await startTunnelBrokerIngressIfNeeded();
  await startControllerIfNeeded(
    ctx.supabaseEnv,
    ctx.proxyConfig,
    ctx.runtimeRepoHost,
    ctx.runtimeCodexHome
  );
  ensureProxyImage();
  await startProxyIfNeeded(ctx.runtimeRepoHost, ctx.proxyConfig);
  await startGitComposeIfEnabled();
  return ctx;
}

function listRuntimeBuildProcesses() {
  const result = tryCapture("ps", ["-Ao", "pid,etime,command"]);
  if (result.code !== 0 || !result.stdout) return [];
  const looksLikeRuntimeBuild = (line) =>
    line.includes("docker-buildx") &&
    (
      line.includes("docker-compose.runtime.yml") ||
      line.includes("runtime-agent:local") ||
      line.includes("runtime-agent:webdev") ||
      line.includes("docker/runtime/Dockerfile") ||
      line.includes("runtime-webdev") ||
      line.includes("--target runtime")
    );
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => looksLikeRuntimeBuild(line))
    .map((line) => {
      const parts = line.trim().split(/\s+/, 3);
      return {
        pid: parts[0] || "",
        elapsed: parts[1] || "",
        command: line
      };
    });
}

function reportRuntimeBuildStatus() {
  const procs = listRuntimeBuildProcesses();
  if (procs.length === 0) return;
  console.log(
    `[runtime-dev] Runtime image build in progress (${procs.length}). The hosted runtime will not register until this finishes.`
  );
  for (const proc of procs.slice(0, 3)) {
    console.log(`- pid=${proc.pid} elapsed=${proc.elapsed} cmd=${proc.command}`);
  }
  if (procs.length > 3) {
    console.log(`- ...and ${procs.length - 3} more buildx processes`);
  }
  console.log(
    "[runtime-dev] If this was triggered from the Studio (New cloud runtime), wait for the docker build to complete. Tail tmp/logs/controller.log for progress."
  );
}

function inspectImage(tag) {
  const inspected = tryCapture("docker", [
    "image",
    "inspect",
    tag,
    "--format",
    "{{.Id}}\t{{.Created}}"
  ]);
  if (inspected.code !== 0) return null;
  const line = inspected.stdout.trim();
  if (!line) return null;
  const [id = "", created = ""] = line.split(/\t+/, 2);
  return {
    tag,
    id: id.trim(),
    created: created.trim()
  };
}

function listRuntimeContainers() {
  const listed = tryCapture("docker", [
    "ps",
    "--filter",
    "label=com.docker.compose.service=runtime",
    "--format",
    "{{.Names}}\t{{.Image}}\t{{.Status}}"
  ]);
  if (listed.code !== 0) return [];
  return listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", image = "", status = ""] = line.split(/\t+/, 3);
      return { name, image, status };
    });
}

function inspectRuntimeDisplayEnv(containerName) {
  if (!containerName) return null;
  const inspected = tryCapture("docker", [
    "exec",
    containerName,
    "sh",
    "-lc",
    "printf 'DISPLAY=%s\\nINSTAFY_BROWSER_DISPLAY=%s\\nINSTAFY_ENABLE_BROWSER_SESSION=%s\\n' \"$DISPLAY\" \"$INSTAFY_BROWSER_DISPLAY\" \"$INSTAFY_ENABLE_BROWSER_SESSION\""
  ]);
  if (inspected.code !== 0) return null;
  const values = {};
  for (const rawLine of inspected.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    values[key] = value;
  }
  return values;
}

function writeRuntimeProvenanceSnapshot() {
  const runningBuilds = listRuntimeBuildProcesses();
  const runtimeLocal = inspectImage("runtime-agent:local");
  const runtimeWebdev = inspectImage("runtime-agent:webdev");
  const runtimeContainers = listRuntimeContainers();
  const firstRuntime = runtimeContainers[0]?.name || null;
  const runtimeDisplayEnv = inspectRuntimeDisplayEnv(firstRuntime);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    runtimeImages: {
      local: runtimeLocal,
      webdev: runtimeWebdev
    },
    runtimeContainers,
    runtimeDisplayEnv,
    runningBuilds
  };
  try {
    ensureTmpDir();
    fs.writeFileSync(runtimeProvenancePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    console.log(`[runtime-dev] Runtime provenance written to ${runtimeProvenancePath}`);
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to write runtime provenance snapshot: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const imageParts = [];
  if (runtimeWebdev) imageParts.push(`webdev=${runtimeWebdev.id}`);
  if (runtimeLocal) imageParts.push(`local=${runtimeLocal.id}`);
  if (imageParts.length > 0) {
    console.log(`[runtime-dev] Runtime image IDs: ${imageParts.join(" ")}`);
  }
  if (runtimeContainers.length > 0) {
    console.log(
      `[runtime-dev] Active runtime containers: ${runtimeContainers
        .map((entry) => `${entry.name}(${entry.image})`)
        .join(", ")}`
    );
  }
  if (runtimeDisplayEnv) {
    console.log(
      `[runtime-dev] Runtime display env: DISPLAY=${runtimeDisplayEnv.DISPLAY || ""} INSTAFY_BROWSER_DISPLAY=${runtimeDisplayEnv.INSTAFY_BROWSER_DISPLAY || ""} INSTAFY_ENABLE_BROWSER_SESSION=${runtimeDisplayEnv.INSTAFY_ENABLE_BROWSER_SESSION || ""}`
    );
  }
}

async function waitForRuntimeBuilds() {
  const shouldWait = (process.env.RUNTIME_WAIT_FOR_BUILD || "").trim() === "1";
  if (!shouldWait) {
    reportRuntimeBuildStatus();
    return;
  }

  const pollMs = Number(process.env.RUNTIME_WAIT_FOR_BUILD_POLL_MS || 2000);
  const timeoutMs = Number(process.env.RUNTIME_WAIT_FOR_BUILD_TIMEOUT_MS || 0);
  let procs = listRuntimeBuildProcesses();
  if (procs.length === 0) return;

  console.log(
    `[runtime-dev] Waiting for ${procs.length} runtime image build(s) to finish...`
  );

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  while (procs.length > 0) {
    if (deadline && Date.now() > deadline) {
      console.warn("[runtime-dev] Timed out waiting for runtime image build(s).");
      reportRuntimeBuildStatus();
      return;
    }
    await wait(pollMs);
    procs = listRuntimeBuildProcesses();
  }

  console.log("[runtime-dev] Runtime image build(s) completed.");
}

function ensureRuntimeImage() {
  try {
    const inspect = tryCapture("docker", ["image", "inspect", "runtime-agent:local"]);
    const missing = inspect.code !== 0;
    const forceBuild =
      process.env.STACK_FORCE_RUNTIME_BUILD === "1" || composeEnvMigratedLegacyProjectId;
    if (missing || forceBuild) {
      console.log(
        `[runtime-dev] Building runtime-agent:local (${missing ? "image missing" : "forced build"})...`
      );
      run("docker", [
        "compose",
        "-p",
        composeProject,
        "-f",
        composeFile,
        "build",
        "runtime"
      ]);
    }

    const webdevInspect = tryCapture("docker", ["image", "inspect", "runtime-agent:webdev"]);
    const webdevMissing = webdevInspect.code !== 0;
    if (webdevMissing || forceBuild) {
      console.log(
        `[runtime-dev] Building runtime-agent:webdev (${webdevMissing ? "image missing" : "forced build"})...`
      );
      run(
        "docker",
        ["compose", "-p", composeProject, "-f", composeFile, "build", "runtime"],
        {
          env: {
            ...process.env,
            RUNTIME_AGENT_BUILD_TARGET: "runtime-webdev",
            RUNTIME_AGENT_IMAGE: "runtime-agent:webdev"
          }
        }
      );
    }
  } catch (error) {
    console.warn(`[runtime-dev] Unable to build runtime image: ${error.message}`);
    throw error;
  }
}

function ensureProxyImage() {
  try {
    ensureComposeFile();
    const inspect = tryCapture("docker", ["image", "inspect", "runtime-proxy:local"]);
    const missing = inspect.code !== 0;
    const forceBuild = process.env.STACK_FORCE_PROXY_BUILD === "1";
    if (!missing && !forceBuild) {
      return;
    }
    console.log(
      `[runtime-dev] Building runtime-proxy:local (${missing ? "image missing" : "forced build"})...`
    );
    run("docker", [
      "compose",
      "-p",
      composeProject,
      "-f",
      composeFile,
      "build",
      "proxy"
    ]);
  } catch (error) {
    console.warn(`[runtime-dev] Unable to build proxy image: ${error.message}`);
    throw error;
  }
}

async function streamRuntimeLogs(options = {}) {
  const {
    tail = 200,
    follow = false,
    timeoutMs = 15000
  } = options;
  const args = [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "logs",
    "--timestamps"
  ];
  if (typeof tail === "number" && Number.isFinite(tail)) {
    args.push("--tail", String(Math.max(0, Math.trunc(tail))));
  }
  if (follow) {
    args.push("--follow");
  }
  args.push("runtime");

  return await new Promise((resolve) => {
    let timer;
    let killTimer;
    let completed = false;
    let child;
    let terminatedByTimer = false;
    const handleExit = (code) => {
      if (completed) return;
      completed = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: typeof code === "number" ? code : 0,
        terminatedEarly: terminatedByTimer
      });
    };
    try {
      child = spawn("docker", args, {
        cwd: repoRoot,
        stdio: "inherit"
      });
    } catch (error) {
      console.warn(
        `[runtime-dev] Unable to stream runtime logs: ${error instanceof Error ? error.message : String(error)}`
      );
      resolve({ exitCode: 1, terminatedEarly: false });
      return;
    }
    child.on("error", (error) => {
      if (completed) return;
      completed = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      console.warn(
        `[runtime-dev] Unable to stream runtime logs: ${error instanceof Error ? error.message : String(error)}`
      );
      resolve({ exitCode: 1, terminatedEarly: false });
    });
    child.on("exit", handleExit);
    if (follow && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        if (completed) return;
        terminatedByTimer = true;
        if (!child.killed) {
          child.kill("SIGINT");
          killTimer = setTimeout(() => {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          }, 2000);
        }
      }, timeoutMs);
    }
  });
}

async function startRuntimeCompose(
  ctx,
  {
    build = true,
    verbose = process.env.RUNTIME_VERBOSE_LOGS === "1",
    logFollowTimeoutMs = 15000,
    force = false,
    allowReuse = false
  } = {}
) {
  const statusCheck = tryCapture("docker", [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "ps",
    "--status",
    "running",
    "runtime"
  ]);
  const stdout = statusCheck.stdout ?? "";
  const alreadyRunning =
    statusCheck.code === 0 && /\bruntime\b/i.test(stdout) && /\brunning\b/i.test(stdout);
  if (alreadyRunning && !force) {
    if (allowReuse) {
      console.log("[runtime-dev] Runtime compose stack already running; reusing existing container.");
      return { alreadyRunning: true };
    }
    throw new Error(
      "Runtime compose stack is already running. Stop the existing container (pnpm runtime:down) or pass --force to reuse."
    );
  }
  console.log("[runtime-dev] Bringing up runtime compose stack...");
  if (build) {
    console.log("[runtime-dev] Building runtime docker image (this can take a few minutes)...");
  }
  ensureDockerConfig();
  const args = [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "up"
  ];
  if (build) {
    args.push("--build");
  }
  args.push("-d", "runtime");
  run("docker", args);
  console.log("[runtime-dev] Runtime docker container started, waiting for health checks...");

  if (verbose) {
    console.log("[runtime-dev] Streaming runtime container logs (boot window)...");
    const { exitCode, terminatedEarly } = await streamRuntimeLogs({
      follow: true,
      tail: 200,
      timeoutMs: logFollowTimeoutMs
    });
    if (exitCode !== 0 && !terminatedEarly) {
      console.warn("[runtime-dev] Runtime log stream exited with non-zero code during boot.");
    }
  }

  await wait(1000);
  try {
    run("docker", [
      "compose",
      "-p",
      composeProject,
      "-f",
      composeFile,
      "ps",
      "--status",
      "running",
      "runtime"
    ]);
  } catch (error) {
    console.warn("[runtime-dev] runtime container not yet running; waiting for logs...");
    if (verbose) {
      await streamRuntimeLogs({ tail: 200 });
    }
  }
}

async function stopRuntimeCompose({ remove = true } = {}) {
  ensureComposeFile();
  try {
    run("docker", [
      "compose",
      "-p",
      composeProject,
      "-f",
      composeFile,
      "stop",
      "runtime"
    ]);
  } catch (error) {
    console.warn(`[runtime-dev] Unable to stop runtime container: ${error.message}`);
  }
  if (remove) {
    try {
      run("docker", [
        "compose",
        "-p",
        composeProject,
        "-f",
        composeFile,
        "rm",
        "-f",
        "runtime"
      ]);
    } catch (error) {
      console.warn(`[runtime-dev] Unable to remove runtime container: ${error.message}`);
    }
  }
}

async function startRuntimeSimulator(options = {}) {
  const {
    ensureSupabase = false,
    composeOverrides = {},
    build = true,
    controllerCheckAttempts = 1,
    controllerCheckDelayMs = 1,
    verbose,
    logFollowTimeoutMs,
    allowReuse = false,
    force = false
  } = options;

  const ctx = await buildRuntimeContext({ ensureSupabase });
  const controllerReady = await waitForPort(controllerPort, {
    attempts: controllerCheckAttempts,
    delayMs: controllerCheckDelayMs
  });
  if (!controllerReady) {
    console.warn(
      `[runtime-dev] Controller is not reachable on ${controllerBaseUrl}. Starting the runtime simulator; it will retry until the controller comes online.`
    );
  }
  configureComposeRuntimeRole("hosted", composeOverrides);
  await startRuntimeCompose(ctx, {
    build,
    verbose,
    logFollowTimeoutMs,
    allowReuse,
    force
  });
  return {
    context: ctx,
    controllerReady
  };
}

async function stopRuntimeSimulator(options = {}) {
  const { remove = true } = options;
  await stopRuntimeCompose({ remove });
}

async function runtimeComposeStatus() {
  ensureComposeFile();
  try {
    run("docker", [
      "compose",
      "-p",
      composeProject,
      "-f",
      composeFile,
      "ps",
      "runtime"
    ]);
  } catch (error) {
    console.warn(`[runtime-dev] Runtime container status unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}

// ───────────────────────── up / down / status / test ─────────────────────────
async function up() {
  if ((process.env.GIT_CANONICAL || "").trim() === "") {
    process.env.GIT_CANONICAL = "1";
    console.log(
      "[runtime-dev] GIT_CANONICAL not set; defaulting to 1 for `up` (set GIT_CANONICAL=0 to opt out)."
    );
  }

  pruneRuntimeAgentsBeforeUp();

  const ctx = await buildRuntimeContext();
  await ensureControllerStack(ctx);
  await ensureRuntimeImage();
  await waitForRuntimeBuilds();
  writeRuntimeProvenanceSnapshot();

  console.log("\nRuntime stack is running!\n");
  console.log("- Supabase Edge functions via http://127.0.0.1:54321/functions/v1.\n");

  if (!ctx.supabaseStatus.started && !fileExists(supabaseFlag)) {
    console.log(
      "[runtime-dev] Supabase was already running; leaving it untouched."
    );
  } else {
    console.log(
      "[runtime-dev] Supabase started by this script. Run `pnpm runtime:down` to stop it."
    );
  }
}
async function down() {
  ensureComposeFile();
  console.log("[runtime-dev] Runtime compose stack disabled; skipping.");

  const gitStopped = await stopGitCompose({ remove: true });
  if (gitStopped) console.log("[runtime-dev] Git service stopped.");

  const proxyStopped = await stopProxyIfWeStarted();
  if (proxyStopped) console.log("[runtime-dev] Proxy stopped.");

  const redisStopped = await stopRedisCompose({ remove: true });
  if (redisStopped) console.log("[runtime-dev] Redis stopped.");

  const tunnelStopped = await stopTunnelBrokerIngressIfWeStarted();
  if (tunnelStopped.stopped) console.log("[runtime-dev] Tunnel-broker stopped.");

  const providerStopped = await stopProviderService();
  if (providerStopped) console.log("[runtime-dev] Provider service stopped.");

  const stopped = await stopControllerIfWeStarted();
  if (stopped) console.log("[runtime-dev] Controller stopped.");

  stopSupabaseAlways();
  console.log("Runtime stack stopped.");
}
async function testCmd(args) {
  if ((process.env.GIT_CANONICAL || "").trim() === "") {
    process.env.GIT_CANONICAL = "1";
    console.log(
      "[runtime-dev] GIT_CANONICAL not set; defaulting to 1 for `test` (set GIT_CANONICAL=0 to opt out)."
    );
  }

  await up();

  // Run Playwright via npx, if available
  try {
    const res = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["playwright", "test", ...args],
      { stdio: "inherit", cwd: repoRoot }
    );
    const code = res.status ?? res.code ?? 1;
    if (code !== 0) process.exitCode = code;
  } finally {
    if (process.env.KEEP_E2E_ENV !== "1") {
      try {
        await down();
      } catch (e) {
        console.warn(String(e?.message || e));
      }
    } else {
      console.log(
        "[runtime-dev] KEEP_E2E_ENV=1 set; leaving environment running."
      );
    }
  }
}
async function status() {
  ensureComposeFile();
  console.log("[runtime-dev] docker compose ps:");
  try {
    run("docker", ["compose", "-p", composeProject, "-f", composeFile, "ps"]);
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to read compose status: ${error.message}`
    );
  }
  console.log("\n[runtime-dev] Supabase status:");
  try {
    runSupabase(["status"]);
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to read Supabase status: ${error.message}`
    );
  }
  console.log("");
  await controllerStatus();
  await proxyStatus();
  reportRuntimeBuildStatus();
}

async function check() {
  ensureComposeFile();
  let ok = true;

  try {
    runSupabase(["status"]);
  } catch (error) {
    console.warn(`[runtime-dev] Supabase status failed: ${error.message}`);
    ok = false;
  }

  const controllerReady = await waitForPort(controllerPort, { attempts: 1, delayMs: 1 });
  if (!controllerReady) {
    console.warn(`[runtime-dev] Controller not reachable on ${controllerBaseUrl}`);
    ok = false;
  }

  const proxyConfig = getProxyConfig();
  const proxyCheckHost =
    proxyConfig.host === "host.docker.internal" ? "127.0.0.1" : proxyConfig.host;
  const proxyReady = await waitForPort(proxyConfig.port, {
    attempts: 1,
    delayMs: 1,
    host: proxyCheckHost,
  });
  if (!proxyReady) {
    console.warn(`[runtime-dev] Proxy not reachable on ${proxyConfig.baseUrl}`);
    ok = false;
  }

  if ((process.env.GIT_CANONICAL || "").trim() === "1") {
    const edgePort = Number(process.env.GIT_EDGE_PORT || 8080);
    const gitReady = await waitForPort(edgePort, { attempts: 1, delayMs: 1, host: "127.0.0.1" });
    if (!gitReady) {
      console.warn(`[runtime-dev] git-edge not reachable on 127.0.0.1:${edgePort}`);
      ok = false;
    }
    const originGatewayPort = Number(process.env.ORIGIN_GATEWAY_PORT || 54333);
    const originReady = await waitForPort(originGatewayPort, {
      attempts: 1,
      delayMs: 1,
      host: "127.0.0.1",
    });
    if (!originReady) {
      console.warn(
        `[runtime-dev] origin-gateway not reachable on 127.0.0.1:${originGatewayPort}`
      );
      ok = false;
    }
  }

  reportRuntimeBuildStatus();

  if (ok) {
    console.log("[runtime-dev] Runtime stack looks healthy.");
  } else {
    process.exitCode = 1;
  }
}

export { startRuntimeSimulator, stopRuntimeSimulator, runtimeComposeStatus };

// ───────────────────────── CLI ─────────────────────────
function printUsage() {
  console.log(`Usage: node scripts/run-e2e-dev.mjs <command>\n`);
  console.log(`Commands:`);
  console.log(`  up        Start Supabase, controller, and docker compose stack`);
  console.log(
    `  down      Stop docker compose, controller (if started by this script), and Supabase`
  );
  console.log(`  status    Show compose, Supabase, and controller status`);
  console.log(`  check     Exit with non-zero code when any runtime component is down`);
  console.log(
    `  test      Run Playwright tests after bringing the stack up (uses npx playwright test)`
  );
  console.log(`\nController helpers:`);
  console.log(`  controller:start|stop|status`);
  console.log(`\nEnv toggles:`);
  console.log(`  RUNTIME_SKIP_CONTROLLER=1   Skip starting controller`);
  console.log(`  RUNTIME_KEEP_SUPABASE=1     Do not stop Supabase on 'down'`);
  console.log(`  RUNTIME_PRUNE_ON_UP=0       Do not prune stale per-project runtimes on 'up'`);
  console.log(`  KEEP_E2E_ENV=1              Do not clean up after 'test'`);
  console.log(`  RUNTIME_SEED_WITH_REPO=1    Seed sandbox with repo snapshot`);
  console.log(`  RUNTIME_WAIT_FOR_BUILD=1    Wait for runtime image builds to finish`);
  console.log(
    `  RUNTIME_PROXY_STATIC_AUTH=1 Opt into legacy static proxy auth (default: per-user BYOC onboarding)`
  );
  console.log(
    `  GIT_CANONICAL=1             Start git-edge + git-shard-0 + origin-gateway (git-canonical)`
  );
  console.log(`\nRuntime start flags:`);
  console.log(`  --verbose                  Stream runtime container logs during startup`);
  console.log(`  --no-verbose | --quiet     Skip streaming logs (default)`);
  console.log(`  --log-timeout=<ms>         Override log follow timeout (default 15000)`);
  console.log(`  --force                    Reuse existing runtime container if already running`);
}

async function main(argv = []) {
  const [command = "help", ...args] = argv;
  loadEnvFile(stripeEnvPath);
  loadEnvFile(githubOauthEnvPath);
  loadEnvFile(geminiEnvPath);
  loadEnvFile(vapidEnvPath);
  loadEnvFile(apnsEnvPath);
  switch (command) {
    case "up":
      await up();
      break;
    case "down":
      await down();
      break;
    case "status":
      await status();
      break;
    case "check":
      await check();
      break;
    case "test":
      await testCmd(args);
      break;
    case "controller:start": {
      if ((process.env.GIT_CANONICAL || "").trim() === "") {
        process.env.GIT_CANONICAL = "1";
        console.log(
          "[runtime-dev] GIT_CANONICAL not set; defaulting to 1 for `controller:start` (set GIT_CANONICAL=0 to opt out)."
        );
      }
      const ctx = await buildRuntimeContext();
      await ensureControllerStack(ctx);
      break;
    }
    case "controller:stop":
      await stopProxyIfWeStarted();
      await stopControllerIfWeStarted();
      break;
    case "controller:status":
      await controllerStatus();
      await proxyStatus();
      break;
    case "help":
    default:
      printUsage();
      process.exitCode = 1;
  }
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === __filename;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[runtime-dev] ${error.message || error}`);
    process.exit(1);
  });
}
