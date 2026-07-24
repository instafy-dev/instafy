import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseDbUrl,
  resolveLocalSupabaseServiceRoleKey,
} from "../../../../scripts/lib/localSupabaseEnv.mjs";
import {
  resolvePrivateEnvPath,
  writePrivateEnvFileSync,
} from "../../../../scripts/lib/privateEnvPaths.mjs";
import {
  buildCodexCredentialCleanupFilter,
  sanitizeCodexSubscriptionAuthJson,
} from "./utils/codexSubscriptionAuthJson.js";
import {
  createTemporaryCodexPreflightAuth,
  removeTemporaryCodexPreflightAuth,
  type TemporaryCodexPreflightAuth,
} from "./utils/codexPreflightAuth.js";
import {
  buildCodexPreflightProxyRunArgs,
  cleanupCodexPreflightProxy,
  configureCodexPreflightProxyEnvironment,
  type CodexPreflightDockerResult,
} from "./utils/codexPreflightProxy.js";
import { resolvePlaywrightControllerUrl } from "./utils/controllerUrl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- resolve repo root, regardless of where this file is executed from ---
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
        // your root package name:
        const hasStackScript =
          json?.scripts?.["stack:up"];
        if (json?.name === "instafy-monorepo" && hasStackScript) {
          return dir;
        }
      } catch {
        // Keep walking upward until we find the repo root marker.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate repo root with name 'instafy-monorepo'.");
}

const repoRoot = findRepoRoot(__dirname);
const privateEnvPath = (relativePath: string): string =>
  resolvePrivateEnvPath({ repoRoot, relativePath });
const stripeEnvPath = privateEnvPath(".env.stripe");
applyEnvFile(stripeEnvPath);
const userEnvPath = privateEnvPath(".env.user");
applyEnvFile(userEnvPath);
const supabaseLocalEnvPath = privateEnvPath(".env.supabase.local");
applyEnvFile(supabaseLocalEnvPath);
const githubTestingEnvPath = privateEnvPath(".env.github-testing");
applyEnvFile(githubTestingEnvPath);
const supabaseEnvPath = privateEnvPath(".env.supabase");
const EXTERNAL_BASE_URL = (process.env.PLAYWRIGHT_EXTERNAL_BASE_URL ?? "").trim();
const USE_EXTERNAL_PLAYWRIGHT_TARGET =
  EXTERNAL_BASE_URL.length > 0 || (process.env.PLAYWRIGHT_EXTERNAL_STACK ?? "").trim() === "1";
if (USE_EXTERNAL_PLAYWRIGHT_TARGET) {
  process.env.PLAYWRIGHT_ALLOW_HOSTED_SUPABASE = "1";
}
if ((process.env.PLAYWRIGHT_ALLOW_HOSTED_SUPABASE ?? "").trim() === "1") {
  applyEnvFile(supabaseEnvPath);
} else if (fs.existsSync(supabaseEnvPath)) {
  log(
    "[global-setup] Skipping .env.supabase (set PLAYWRIGHT_ALLOW_HOSTED_SUPABASE=1 to opt into hosted Supabase during tests)."
  );
}
const defaultWorkspaceRoot = path.join(repoRoot, "tmp", "runtime-sandbox");
const configuredWorkspaceRoot = process.env.WORKSPACE_ROOT || defaultWorkspaceRoot;
try {
  fs.mkdirSync(configuredWorkspaceRoot, { recursive: true });
} catch (error) {
  console.warn(
    `[global-setup] Unable to ensure WORKSPACE_ROOT directory ${configuredWorkspaceRoot}: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}
process.env.WORKSPACE_ROOT = configuredWorkspaceRoot;
const CONTROLLER_URL = resolvePlaywrightControllerUrl({
  ...process.env,
  PLAYWRIGHT_CONTROLLER_URL:
    process.env.PLAYWRIGHT_CONTROLLER_URL ??
    process.env.CONTROLLER_URL ??
    process.env.VITE_CONTROLLER_URL ??
    (USE_EXTERNAL_PLAYWRIGHT_TARGET ? "" : "http://127.0.0.1:8788"),
});
const SUPABASE_URL = (
  process.env.VITE_SUPABASE_URL ??
  process.env.SUPABASE_URL ??
  (USE_EXTERNAL_PLAYWRIGHT_TARGET ? "" : "http://127.0.0.1:54321")
).trim();
const LOCAL_PROXY_HEALTH_URL = resolveLocalProxyHealthUrl();
const DEFAULT_ANON =
  process.env.VITE_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
if (!process.env.PLAYWRIGHT_TEST_EMAIL && process.env.TEST_USER_1_EMAIL) {
  process.env.PLAYWRIGHT_TEST_EMAIL = process.env.TEST_USER_1_EMAIL;
}
if (!process.env.PLAYWRIGHT_TEST_PASSWORD && process.env.TEST_USER_1_PASSWORD) {
  process.env.PLAYWRIGHT_TEST_PASSWORD = process.env.TEST_USER_1_PASSWORD;
}
const TEST_USER_EMAIL = process.env.PLAYWRIGHT_TEST_EMAIL ?? "playwright@instafy.dev";
const TEST_USER_PASSWORD = process.env.PLAYWRIGHT_TEST_PASSWORD ?? "Playwright123!";
const DEV_ISOLATION_FLAG =
  (process.env.PLAYWRIGHT_RUNTIME_DEV_ISOLATION ??
    process.env.RUNTIME_DEV_ISOLATION ??
    "0"
  ).trim();
const RUNTIME_DEV_ISOLATION =
  DEV_ISOLATION_FLAG === "" ? "0" : DEV_ISOLATION_FLAG;
process.env.PLAYWRIGHT_RUNTIME_DEV_ISOLATION = RUNTIME_DEV_ISOLATION;
if (!process.env.RUNTIME_DEV_ISOLATION || process.env.RUNTIME_DEV_ISOLATION.trim() === "") {
  process.env.RUNTIME_DEV_ISOLATION = RUNTIME_DEV_ISOLATION;
}
// Playwright tests intentionally relax strict mode so queued jobs from previous runs
// do not surface warning toasts. TODO(instafy-runtime): add a lifecycle coverage test
// that exercises job teardown in strict mode and re-enable this flag when ready.
const RUNTIME_STRICT_MODE = "0";
process.env.RUNTIME_STRICT_MODE = RUNTIME_STRICT_MODE;
process.env.PLAYWRIGHT_RUNTIME_STRICT_MODE = RUNTIME_STRICT_MODE;
const SHOULD_FORCE_FRESH_RUNTIME = RUNTIME_DEV_ISOLATION === "1";
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PLAYWRIGHT_PROJECT_ID = resolvePlaywrightProjectId();
const dockerComposePath = path.join(repoRoot, "docker", "docker-compose.runtime.yml");
const dockerComposeEnvPath = privateEnvPath("docker/.env.local");
const dockerWorkspaceRoot = path.join(configuredWorkspaceRoot, "docker-workspaces");
const dockerCodexRoot = path.join(configuredWorkspaceRoot, ".codex-runtime");
const tunnelBrokerFlag = path.join(repoRoot, "tmp", ".tunnel-broker-fixture-started");
const benchFixtureSiteStatePath = path.join(repoRoot, "tmp", ".playwright-bench-fixture-site.json");
const touchedProjectIdsPath = path.join(repoRoot, "tmp", ".playwright-touched-project-ids.log");
const proxyCodexAuthPath = path.join(repoRoot, "tmp", "proxy-codex", "auth.json");
const machineCodexAuthPath = path.join(os.homedir(), ".codex", "auth.json");
const playwrightCanonicalCredentialLabel = "Playwright canonical local Codex auth";
const benchFixtureSiteServerPath = path.join(
  repoRoot,
  "packages",
  "frontend",
  "tests",
  "playwright",
  "bench",
  "fixture-site-server.mjs",
);
const tunnelBrokerConfigBackupDir = path.join(
  repoRoot,
  "tmp",
  "playwright-tunnel-broker-config-backup",
);
const tunnelBrokerConfigFiles = [
  {
    source: path.join(
      repoRoot,
      "packages",
      "tunnel-broker",
      "config",
      "rathole",
      "server.toml",
    ),
    backupName: "server.toml",
  },
  {
    source: path.join(
      repoRoot,
      "packages",
      "tunnel-broker",
      "config",
      "traefik",
      "dynamic.yml",
    ),
    backupName: "dynamic.yml",
  },
] as const;

try {
  fs.mkdirSync(dockerWorkspaceRoot, { recursive: true });
} catch (error) {
  console.warn(
    `[global-setup] Unable to ensure Docker runtime repo host directory ${dockerWorkspaceRoot}: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}
try {
  fs.mkdirSync(dockerCodexRoot, { recursive: true });
} catch (error) {
  console.warn(
    `[global-setup] Unable to ensure Docker runtime codex directory ${dockerCodexRoot}: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

if (!process.env.RUNTIME_ALLOCATOR || process.env.RUNTIME_ALLOCATOR.trim() === "") {
  process.env.RUNTIME_ALLOCATOR = "docker";
}
if (!process.env.RUNTIME_DOCKER_COMPOSE_FILE || process.env.RUNTIME_DOCKER_COMPOSE_FILE.trim() === "") {
  process.env.RUNTIME_DOCKER_COMPOSE_FILE = dockerComposePath;
}
if (!process.env.RUNTIME_DOCKER_REPO_HOST || process.env.RUNTIME_DOCKER_REPO_HOST.trim() === "") {
  process.env.RUNTIME_DOCKER_REPO_HOST = dockerWorkspaceRoot;
}
if (!process.env.RUNTIME_DOCKER_CODEX_ROOT || process.env.RUNTIME_DOCKER_CODEX_ROOT.trim() === "") {
  process.env.RUNTIME_DOCKER_CODEX_ROOT = dockerCodexRoot;
}

type EnvMap = Record<string, string>;
let cachedLocalSupabaseStatusEnv: EnvMap | null | undefined;

if (!process.env.RUNTIME_SEED_WITH_REPO || process.env.RUNTIME_SEED_WITH_REPO.trim() === "") {
  process.env.RUNTIME_SEED_WITH_REPO = "0";
}

async function startTunnelBrokerFixtureIfNeeded() {
  const enabled =
    (process.env.PLAYWRIGHT_TUNNEL_BROKER_SMOKE ??
      process.env.TUNNEL_BROKER_SMOKE ??
      "0"
    ).trim() === "1";
  if (!enabled) return;

  const alreadyConfigured =
    (process.env.TUNNEL_BROKER_BASE_URL ||
      process.env.VITE_TUNNEL_BROKER_BASE_URL ||
      "").trim();
  if (alreadyConfigured) {
    log("[global-setup] Tunnel broker env already set; skipping fixture start.");
    return;
  }

  if (!process.env.INGRESS_IPV4 || process.env.INGRESS_IPV4.trim() === "") {
    try {
      const resolved = run(
        "docker",
        ["exec", "supabase_kong_supabase", "getent", "hosts", "host.docker.internal"],
        { silent: true },
      )
        .trim()
        .match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+/)?.[1];
      if (resolved) {
        process.env.INGRESS_IPV4 = resolved;
        log(`[global-setup] Using INGRESS_IPV4=${resolved} for tunnel-broker ingress reachability.`);
      }
    } catch {
      // Fall back to tunnel-broker's default INGRESS_IPV4 when host lookup isn't available.
    }
  }

  snapshotTunnelBrokerFixtureConfigs();
  log("[global-setup] Starting tunnel-broker ingress fixture...");
  run("pnpm", ["-C", path.join(repoRoot, "packages", "tunnel-broker"), "ingress:up"]);

  const baseUrl = "http://127.0.0.1:8082";
  await waitUntil(
    "tunnel-broker",
    async () => reachable(`${baseUrl}/healthz`, 1_000),
    30_000,
    500,
  );
  process.env.TUNNEL_BROKER_BASE_URL = baseUrl;
  process.env.VITE_TUNNEL_BROKER_BASE_URL = baseUrl;
  process.env.TUNNEL_BROKER_TOKEN = process.env.TUNNEL_BROKER_TOKEN ?? "dev-token";

  try {
    fs.mkdirSync(path.dirname(tunnelBrokerFlag), { recursive: true });
    fs.writeFileSync(tunnelBrokerFlag, "started");
  } catch {
    // Best-effort local fixture marker only.
  }

  log("[global-setup] Tunnel-broker fixture started.");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startBenchFixtureSiteIfNeeded(): Promise<void> {
  const benchEnabled = (process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() === "1";
  if (!benchEnabled) return;

  try {
    if (fs.existsSync(benchFixtureSiteStatePath)) {
      const existing = JSON.parse(fs.readFileSync(benchFixtureSiteStatePath, "utf8")) as {
        pid?: number | null;
        port?: number | null;
      };
      const pid = typeof existing?.pid === "number" ? existing.pid : null;
      const port = typeof existing?.port === "number" ? existing.port : null;
      if (port && (!pid || isPidAlive(pid))) {
        process.env.PLAYWRIGHT_BENCH_FIXTURE_SITE_LOCAL_URL = `http://127.0.0.1:${port}`;
        process.env.PLAYWRIGHT_BENCH_FIXTURE_SITE_URL = `http://host.docker.internal:${port}`;
        log(`[global-setup] Reusing bench fixture site on port ${port}.`);
        return;
      }
      fs.rmSync(benchFixtureSiteStatePath, { force: true });
    }
  } catch {
    // best-effort only
  }

  const requestedPort = Number.parseInt((process.env.PLAYWRIGHT_BENCH_FIXTURE_SITE_PORT ?? "").trim() || "0", 10);
  const host = (process.env.PLAYWRIGHT_BENCH_FIXTURE_SITE_HOST ?? "0.0.0.0").trim() || "0.0.0.0";

  if (!fs.existsSync(benchFixtureSiteServerPath)) {
    log(`[global-setup] Bench fixture site server missing: ${benchFixtureSiteServerPath}`);
    return;
  }

  try {
    fs.mkdirSync(path.dirname(benchFixtureSiteStatePath), { recursive: true });
  } catch {
    // Best-effort state file directory only.
  }

  log("[global-setup] Starting bench fixture site…");
  const child = spawn("node", [benchFixtureSiteServerPath, String(requestedPort)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(requestedPort),
      HOST: host,
      STATE_PATH: benchFixtureSiteStatePath,
    },
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
  child.unref();

  // Wait for state file, then for /healthz to respond.
  const startedAt = Date.now();
  const deadline = startedAt + 20_000;
  let port: number | null = null;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(benchFixtureSiteStatePath)) {
        const parsed = JSON.parse(fs.readFileSync(benchFixtureSiteStatePath, "utf8")) as { port?: number | null };
        if (typeof parsed?.port === "number" && parsed.port > 0) {
          port = parsed.port;
          break;
        }
      }
    } catch {
      // Ignore transient read/parse failures until the child writes valid state.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!port) {
    log("[global-setup] WARN: bench fixture site did not report a port in time.");
    return;
  }

  const localUrl = `http://127.0.0.1:${port}`;
  await waitUntil(
    "bench fixture site health",
    async () => reachable(`${localUrl}/healthz`, 800),
    20_000,
    200,
  );

  process.env.PLAYWRIGHT_BENCH_FIXTURE_SITE_LOCAL_URL = localUrl;
  process.env.PLAYWRIGHT_BENCH_FIXTURE_SITE_URL = `http://host.docker.internal:${port}`;
  log(`[global-setup] Bench fixture site ready on port ${port}.`);
}

function snapshotTunnelBrokerFixtureConfigs() {
  try {
    fs.rmSync(tunnelBrokerConfigBackupDir, { recursive: true, force: true });
    fs.mkdirSync(tunnelBrokerConfigBackupDir, { recursive: true });
    for (const file of tunnelBrokerConfigFiles) {
      const contents = fs.readFileSync(file.source, "utf8");
      const backupPath = path.join(tunnelBrokerConfigBackupDir, file.backupName);
      fs.writeFileSync(backupPath, contents, "utf8");
    }
  } catch (error) {
    console.warn(
      `[global-setup] Failed to snapshot tunnel-broker fixture configs: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function run(cmd: string, args: string[], options: { silent?: boolean } = {}) {
  const result = spawnSync(cmd, args, {
    stdio: options.silent ? "pipe" : "inherit",
    cwd: repoRoot,
    env: process.env,
  });
  const code = result.status ?? result["code"] ?? 1;
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${code}`);
  }
  return result.stdout?.toString() ?? "";
}

function runCodexPreflightDockerCommand(
  args: readonly string[],
): CodexPreflightDockerResult {
  const result = spawnSync("docker", [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: repoRoot,
    env: process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    error: result.error,
  };
}

function finalizeCodexPreflight({
  projectName,
  containerName,
  temporaryAuth,
  restoreEnvironment,
}: {
  projectName: string;
  containerName: string;
  temporaryAuth: TemporaryCodexPreflightAuth | null;
  restoreEnvironment: () => void;
}): void {
  const cleanupErrors: unknown[] = [];
  try {
    cleanupCodexPreflightProxy(
      {
        projectName,
        composePath: dockerComposePath,
        containerName,
      },
      runCodexPreflightDockerCommand,
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    restoreEnvironment();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    removeTemporaryCodexPreflightAuth(temporaryAuth);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      "[global-setup] Multiple Codex preflight cleanup operations failed.",
    );
  }
}

function cleanupRuntimeContainers() {
  try {
    const dockerProjectPrefix =
      (process.env.DOCKER_PROJECT_PREFIX ||
        process.env.RUNTIME_DOCKER_PROJECT_PREFIX ||
        "instafy-runtime-")
        .trim() || "instafy-runtime-";
    const baseComposeProject =
      (process.env.COMPOSE_PROJECT_NAME || "instafy-runtime").trim() || "instafy-runtime";

    const rows = run(
      "docker",
      [
        "ps",
        "-a",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Label \"com.docker.compose.project\"}}",
        "--filter",
        `name=${dockerProjectPrefix}`,
      ],
      {
        silent: true,
      }
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const ids = rows
      .map((row) => {
        const [id, name, composeProject] = row.split("\t");
        if (!id) return null;
        const project = (composeProject || "").trim();
        if (project) {
          if (project !== baseComposeProject && project.startsWith(dockerProjectPrefix)) {
            return id;
          }
          return null;
        }

        const containerName = (name || "").trim();
        if (containerName.startsWith(dockerProjectPrefix)) {
          return id;
        }

        return null;
      })
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    log(`Removing ${ids.length} lingering runtime containers...`);
    run("docker", ["rm", "-f", ...ids]);
  } catch (error) {
    console.warn(
      `[global-setup] Failed to clean runtime containers: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function cleanupRuntimeNetworks() {
  try {
    const ids = run("docker", ["network", "ls", "-q", "--filter", "name=instafy-runtime-"], {
      silent: true,
    })
      .split(/\r?\n/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    log(`Removing ${ids.length} lingering runtime networks...`);
    for (const id of ids) {
      try {
        run("docker", ["network", "rm", id], { silent: true });
      } catch {
        // ignore: network may still be in use
      }
    }
  } catch (error) {
    console.warn(
      `[global-setup] Failed to clean runtime networks: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function cleanupRuntimeTables() {
  try {
    log(
      "Clearing runtime tables (runtime_tunnel_grants, origin_instances, runtime_leases, runtimes)..."
    );
    const dbUrl = resolveSupabaseDbUrl();
    if (!dbUrl) {
      log("Skipping runtime table cleanup: Supabase DB URL unavailable.");
      return;
    }
    const sql =
      "update runtimes set active_lease_id = null; delete from runtime_tunnel_grants; delete from origin_instances; delete from runtimes; delete from runtime_leases;";
    const psqlBin = resolveBinary("psql");
    const result = psqlBin
      ? spawnSync(
          psqlBin,
          ["-d", dbUrl, "-v", "ON_ERROR_STOP=1", "-c", sql],
          {
            cwd: repoRoot,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          }
        )
      : (() => {
          if (!isLocalSupabaseDbUrl(dbUrl)) {
            throw new Error(
              "host psql is unavailable and the configured Supabase DB URL is not local"
            );
          }
          const dockerBin = resolveBinary("docker") ?? "docker";
          return spawnSync(
            dockerBin,
            [
              "exec",
              "supabase_db_supabase",
              "psql",
              "-U",
              "postgres",
              "-d",
              "postgres",
              "-v",
              "ON_ERROR_STOP=1",
              "-c",
              sql,
            ],
            {
              cwd: repoRoot,
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            }
          );
        })();
    const exitCode = result.status ?? result["code"] ?? 1;
    if (exitCode !== 0) {
      throw new Error(formatSpawnFailure(result, exitCode, "runtime table cleanup"));
    }
  } catch (error) {
    console.warn(
      `[global-setup] Failed to clear runtime tables: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function log(s: string) {
  console.log(`[global-setup] ${s}`);
}

function formatSpawnFailure(
  result: {
    error?: Error;
    stderr?: string | Buffer | null;
    stdout?: string | Buffer | null;
  },
  exitCode: number,
  label: string,
): string {
  const errorMessage = result.error?.message?.trim();
  if (errorMessage) {
    return `${label} failed: ${errorMessage}`;
  }
  const stderr =
    typeof result.stderr === "string"
      ? result.stderr.trim()
      : result.stderr?.toString().trim();
  if (stderr && stderr.length > 0) {
    return stderr;
  }
  const stdout =
    typeof result.stdout === "string"
      ? result.stdout.trim()
      : result.stdout?.toString().trim();
  if (stdout && stdout.length > 0) {
    return stdout;
  }
  return `${label} exited with code ${exitCode}`;
}

function isLocalSupabaseDbUrl(dbUrl: string): boolean {
  try {
    const host = new URL(dbUrl).hostname.trim().toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

let initialRuntimeCleanupDone = false;

function ensureInitialRuntimeCleanup() {
  if (USE_EXTERNAL_PLAYWRIGHT_TARGET || initialRuntimeCleanupDone) {
    return;
  }
  initialRuntimeCleanupDone = true;
  cleanupRuntimeContainers();
  cleanupRuntimeNetworks();
  cleanupRuntimeTables();
}

async function ensureControllerProviders(serviceRoleKey: string) {
  const endpoint =
    process.env.DEV_PROVIDER_ENDPOINT?.trim() ||
    process.env.RUNTIME_PROVIDER_ENDPOINT?.trim() ||
    "http://127.0.0.1:9090";
  const authToken =
    process.env.DEV_PROVIDER_AUTH_TOKEN?.trim() ||
    process.env.RUNTIME_PROVIDER_AUTH_TOKEN?.trim() ||
    "dev-provider-token";

  // Bench runs must exercise the local runtime-agent changes (ex: /learn optimizer) rather than
  // whatever runtime-agent image is currently published. We do that by forcing the provider
  // metadata to request the local webdev build target and the stable local image tag that
  // `pnpm stack:refresh` / manual local rebuilds produce.
  //
  // This is intentionally gated behind PLAYWRIGHT_RUN_BENCH so the normal e2e suite stays fast.
  const benchEnabled = (process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() === "1";
  const benchRuntimeMetadata = (() => {
    if (!benchEnabled) return {};
    return {
      runtimeAgentImage: "runtime-agent:webdev",
      env: {
        // Triggers docker allocator to run `docker compose build runtime` before `up`.
        RUNTIME_AGENT_BUILD_TARGET: "runtime-webdev",
      },
    };
  })();

  const baseUrl = CONTROLLER_URL.replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  } as const;

  const providers = [
    {
      id: "runtime",
      displayName: "Local Provider",
      kind: "external_http",
    },
    {
      id: "instafy-cloud",
      displayName: "Instafy Cloud (local)",
      kind: "external_http",
    },
    {
      id: "self-hosted",
      displayName: "Self-hosted Provider",
      kind: "external_http",
    },
  ] as const;

  for (const provider of providers) {
    try {
      const response = await fetch(`${baseUrl}/providers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...provider,
          endpoint,
          authToken,
          metadata: benchRuntimeMetadata,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        log(
          `WARN: unable to upsert provider ${provider.id} (status ${response.status}): ${body.slice(0, 160)}`,
        );
      }
    } catch (error) {
      log(
        `WARN: unable to upsert provider ${provider.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function resolveBinary(bin: string): string | null {
  const envKey = `${bin.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`;
  const envOverride = process.env[envKey];
  if (envOverride && envOverride.trim().length > 0) {
    const candidate = envOverride.trim();
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const which = spawnSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"] });
  if ((which.status ?? which["code"] ?? 1) === 0) {
    const output = which.stdout?.toString().trim();
    if (output && fs.existsSync(output)) {
      return output;
    }
  }

  const fallbacks =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
      : process.platform === "linux"
        ? ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]
        : ["/usr/local/bin", "/usr/bin", "C:\\Program Files\\Docker\\Docker\\resources\\bin"];

  for (const dir of fallbacks) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function assertBin(bin: string, args: string[] = ["--version"]) {
  const binaryPath = resolveBinary(bin) ?? bin;
  const res = spawnSync(binaryPath, args, { stdio: ["ignore", "ignore", "inherit"] });
  if ((res.status ?? res["code"] ?? 1) !== 0) {
    throw new Error(`Required binary '${bin}' missing or not runnable.`);
  }
  if (binaryPath !== bin) {
    process.env[`${bin.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`] = binaryPath;
  }
}

function applyEnvFile(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const map = parseEnv(content);
    for (const [key, value] of Object.entries(map)) {
      if (!key || !value || process.env[key]) continue;
      process.env[key] = value;
    }
    log(`Loaded ${Object.keys(map).length} vars from ${path.basename(filePath)}.`);
  } catch (error) {
    log(
      `Unable to load ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

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

function normalizeRuntimeComposeEnv(): void {
  try {
    if (!fs.existsSync(dockerComposeEnvPath)) {
      return;
    }

    const content = fs.readFileSync(dockerComposeEnvPath, "utf8");
    const envMap = parseEnv(content);
    const lines = content.split(/\r?\n/);
    const uuidPattern =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const legacyProjectId =
      envMap.PROJECT_ID && uuidPattern.test(envMap.PROJECT_ID.trim())
        ? envMap.PROJECT_ID.trim()
        : null;
    const spaceId =
      envMap.SPACE_ID && uuidPattern.test(envMap.SPACE_ID.trim())
        ? envMap.SPACE_ID.trim()
        : legacyProjectId;
    let modified = false;

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

    const gitCanonicalEnabled = (process.env.GIT_CANONICAL ?? "1").trim() === "1";
    const remoteIdx = lines.findIndex((line) => line.startsWith("ORIGIN_GIT_REMOTE_URL="));
    if (spaceId && gitCanonicalEnabled) {
      const desiredRemoteLine = `ORIGIN_GIT_REMOTE_URL=http://git-edge:8080/${spaceId}.git`;
      if (remoteIdx === -1) {
        lines.push(desiredRemoteLine);
        modified = true;
      } else if (lines[remoteIdx] !== desiredRemoteLine) {
        lines[remoteIdx] = desiredRemoteLine;
        modified = true;
      }
    } else if (!gitCanonicalEnabled && remoteIdx !== -1) {
      lines.splice(remoteIdx, 1);
      modified = true;
    }

    if (!modified) {
      return;
    }

    const next = lines.filter((line, index) => line || index === lines.length - 1);
    const writtenPath = writePrivateEnvFileSync({
      repoRoot,
      relativePath: "docker/.env.local",
      data: `${next.join("\n").replace(/\n+$/, "\n")}\n`,
    });
    if (writtenPath !== dockerComposeEnvPath) {
      throw new Error("private env path changed between resolution and write");
    }
    log("Normalized docker/.env.local to mirror SPACE_ID into local runtime identifiers.");
  } catch (error) {
    console.warn(
      `[global-setup] Failed to normalize docker/.env.local: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function resolveSupabaseDbUrl(): string | null {
  return (
    resolveLocalSupabaseDbUrl({
      env: process.env,
      statusEnv: readCachedLocalSupabaseStatusEnv() ?? undefined,
    }) || "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
  );
}

function readServiceRoleKeyFromMap(map: EnvMap): string | null {
  const candidates = [
    map.SUPABASE_SERVICE_ROLE_KEY,
    map.SERVICE_ROLE_KEY
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
    log(
      `Unable to read ${filePath} while resolving Supabase service role key: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

function readCachedLocalSupabaseStatusEnv(): EnvMap | null {
  if (cachedLocalSupabaseStatusEnv !== undefined) {
    return cachedLocalSupabaseStatusEnv;
  }
  cachedLocalSupabaseStatusEnv = readLocalSupabaseStatusEnv({
    cwd: repoRoot,
    required: false,
  });
  return cachedLocalSupabaseStatusEnv;
}

function readServiceRoleKeyFromSupabaseStatus(): string | null {
  const statusEnv = readCachedLocalSupabaseStatusEnv();
  return resolveLocalSupabaseServiceRoleKey({ env: {}, statusEnv }) || null;
}

function isLocalSupabaseUrl(rawUrl: string): boolean {
  const url = (rawUrl ?? "").trim().toLowerCase();
  return (
    url.includes("127.0.0.1") ||
    url.includes("localhost") ||
    url.includes("host.docker.internal")
  );
}

function resolveServiceRoleKey(options: { allowStatus?: boolean } = {}): string | null {
  const allowStatus = options.allowStatus ?? false;
  if (allowStatus && isLocalSupabaseUrl(SUPABASE_URL)) {
    const key = readServiceRoleKeyFromSupabaseStatus();
    if (key) {
      return key;
    }
  }

  const fromEnv = readServiceRoleKeyFromMap(process.env as EnvMap);
  if (fromEnv) {
    return fromEnv;
  }

  const dockerEnv = privateEnvPath("docker/.env.local");
  const dockerExample = path.join(repoRoot, "docker", ".env");
  const supabaseDev = privateEnvPath("supabase/.env.dev.local");

  for (const candidate of [dockerEnv, dockerExample, supabaseDev]) {
    const key = readServiceRoleKeyFromFile(candidate);
    if (key) {
      return key;
    }
  }

  if (allowStatus && isLocalSupabaseUrl(SUPABASE_URL)) {
    return readServiceRoleKeyFromSupabaseStatus();
  }

  return null;
}

function applyServiceRoleKey(key: string) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY.trim()) {
    process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  }
  if (!process.env.SERVICE_ROLE_KEY || !process.env.SERVICE_ROLE_KEY.trim()) {
    process.env.SERVICE_ROLE_KEY = key;
  }
}

function resolveLocalProxyHealthUrl(): string {
  const configured = (
    process.env.PLAYWRIGHT_PROXY_URL ??
    process.env.PROXY_BASE_URL ??
    "http://127.0.0.1:8789"
  ).trim();

  try {
    const url = new URL(configured || "http://127.0.0.1:8789");
    if (url.hostname === "proxy" || url.hostname === "host.docker.internal") {
      url.hostname = "127.0.0.1";
    }
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/healthz`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "http://127.0.0.1:8789/healthz";
  }
}

async function reachable(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return !!res;
  } catch {
    return false;
  }
}

type RecognizedProxyHealth = {
  status: "ok";
  backend: string;
  requiresCredential: boolean;
};

async function fetchRecognizedProxyHealth(
  url: string,
  timeoutMs = 1500,
): Promise<RecognizedProxyHealth | null> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: ac.signal });
    if (!response.ok) {
      return null;
    }
    const health = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      health?.status === "ok" &&
      typeof health.backend === "string" &&
      typeof health.requiresCredential === "boolean"
    ) {
      return {
        status: "ok",
        backend: health.backend,
        requiresCredential: health.requiresCredential,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function dockerImageExists(imageName: string): boolean {
  const result = spawnSync("docker", ["image", "inspect", imageName], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return (result.status ?? 1) === 0;
}

/**
 * Non-secret freshness summary of the canonical local Codex login for
 * skip-message diagnostics. Only ages and timestamps are reported, never
 * token material.
 */
function describeCodexAuthFreshness(): string {
  try {
    const authPath = fs.existsSync(machineCodexAuthPath)
      ? machineCodexAuthPath
      : proxyCodexAuthPath;
    if (!fs.existsSync(authPath)) {
      return "[codex-auth: no local Codex login present]";
    }
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
      auth_mode?: string;
      last_refresh?: string;
      tokens?: { access_token?: string };
    };
    const parts: string[] = [];
    if (parsed.auth_mode) {
      parts.push(`mode=${parsed.auth_mode}`);
    }
    if (parsed.last_refresh) {
      const refreshedAt = Date.parse(parsed.last_refresh);
      if (Number.isFinite(refreshedAt)) {
        const ageDays = (Date.now() - refreshedAt) / 86_400_000;
        parts.push(`last_refresh ${ageDays.toFixed(1)}d ago`);
        if (ageDays > 25) {
          parts.push("LIKELY STALE — renew the local Codex login before retrying");
        }
      }
    }
    const accessToken = parsed.tokens?.access_token ?? "";
    if (accessToken.split(".").length === 3) {
      try {
        const payload = JSON.parse(
          Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")
        ) as { exp?: number };
        if (typeof payload.exp === "number") {
          const remainingH = (payload.exp * 1000 - Date.now()) / 3_600_000;
          parts.push(
            remainingH < 0
              ? `access_token expired ${(-remainingH).toFixed(1)}h ago (refresh flow must work)`
              : `access_token valid ${remainingH.toFixed(1)}h`
          );
        }
      } catch {
        parts.push("access_token claims unreadable");
      }
    }
    return parts.length > 0 ? `[codex-auth: ${parts.join("; ")}]` : "[codex-auth: present]";
  } catch {
    return "[codex-auth: unreadable]";
  }
}

async function preflightCodexBackend(): Promise<void> {
  if ((process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1") {
    return;
  }

  // With CODEX_PREFLIGHT_STRICT=1 (the canary and any suite whose whole point
  // is model coverage), a failed preflight FAILS the run instead of silently
  // skipping the Codex-dependent specs. A green-but-vacuous run already hid a
  // real regression for weeks once; and CI must never be tempted to fall back
  // to a paid OPENAI_API_KEY when the ChatGPT auth.json is invalid — the
  // correct signal is a loud failure. (2026-07-06)
  const strictPreflight = (process.env.CODEX_PREFLIGHT_STRICT ?? "").trim() === "1";
  const skipOrFailCodex = (reason: string): void => {
    if (strictPreflight) {
      throw new Error(
        `[global-setup] ${reason} — CODEX_PREFLIGHT_STRICT=1, failing the run instead of skipping.`
      );
    }
    log(`[global-setup] ${reason}`);
    process.env.PLAYWRIGHT_SKIP_CODEX = "1";
  };

  const hasMachineAuth = fs.existsSync(machineCodexAuthPath);
  const hasAuthFile = fs.existsSync(proxyCodexAuthPath);
  const sourceAuthPath = hasMachineAuth
    ? machineCodexAuthPath
    : hasAuthFile
      ? proxyCodexAuthPath
      : null;
  const openAiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!openAiKey && !sourceAuthPath) {
    skipOrFailCodex(
      "Codex auth missing; skipping Codex-dependent specs. (Set OPENAI_API_KEY or run `codex login`.)"
    );
    return;
  }

  const projectSuffix = PLAYWRIGHT_PROJECT_ID
    ? PLAYWRIGHT_PROJECT_ID.slice(0, 8)
    : randomUUID().slice(0, 8);
  const projectName = `instafy-codex-preflight-${projectSuffix}`;
  const containerName = `${projectName}-proxy`;
  const port = Number(process.env.PLAYWRIGHT_CODEX_PREFLIGHT_PORT ?? "8799");
  let temporaryAuth: TemporaryCodexPreflightAuth | null = null;
  let restorePreflightEnvironment = () => {};
  // The maintained local Codex login is authoritative. Never let an ambient
  // paid API key shadow it in the temporary preflight proxy. Mount a disposable
  // copy because the proxy may refresh auth.json; ~/.codex must remain untouched.
  const shouldBuildProxyImage =
    (process.env.PLAYWRIGHT_CODEX_PREFLIGHT_FORCE_BUILD ??
      process.env.STACK_FORCE_PROXY_BUILD ??
      ""
    ).trim() === "1" || !dockerImageExists("runtime-proxy:local");

  try {
    if (sourceAuthPath) {
      temporaryAuth = createTemporaryCodexPreflightAuth(
        sourceAuthPath,
        path.join(repoRoot, "tmp"),
      );
    }
    // The proxy enforces proxy JWT auth whenever controller integration is enabled (via
    // CONTROLLER_INTERNAL_TOKEN). Preflight validates only the upstream Codex credentials,
    // so its scoped environment disables controller integration.
    restorePreflightEnvironment = configureCodexPreflightProxyEnvironment(
      process.env,
      {
        hostPort: port,
        authDirectory: temporaryAuth?.directory ?? null,
      },
    );

    run(
      "docker",
      buildCodexPreflightProxyRunArgs({
        projectName,
        composePath: dockerComposePath,
        containerName,
        hostPort: port,
        build: shouldBuildProxyImage,
      }),
    );

    await waitUntil(
      "Codex proxy preflight",
      async () => reachable(`http://127.0.0.1:${port}/v1/responses`, 800),
      30_000,
      500
    );

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: (process.env.PLAYWRIGHT_CODEX_PREFLIGHT_MODEL ?? process.env.CODEX_MODEL ?? "gpt-5.5").trim() || "gpt-5.5",
            prompt: "Playwright preflight ping"
          }),
          signal: controller.signal
        }).catch((error) => {
          throw error instanceof Error ? error : new Error(String(error));
        });

        if (response.ok) {
          log("[global-setup] Codex backend available.");
          return;
        }

        const body = await response.text().catch(() => "");
        const lowered = body.toLowerCase();
        const rateLimited =
          lowered.includes("usage_limit_reached") ||
          lowered.includes("too many requests") ||
          lowered.includes("rate limit") ||
          lowered.includes("429");

        if (rateLimited) {
          // A hard plan quota ("usage_limit_reached") won't clear within a run,
          // so skip it fast. But a plain transient 429 / "too many requests"
          // usually clears in seconds — retry with backoff before giving up.
          // (Codex works locally with the same auth, so the account HAS quota;
          // CI was just hitting momentary throttling and skipping instantly.)
          const hardQuota = lowered.includes("usage_limit_reached");
          if (!hardQuota && attempt < maxAttempts) {
            const backoffMs = 5_000 * attempt;
            log(
              `[global-setup] Codex backend throttled (429) on preflight attempt ${attempt}/${maxAttempts}; retrying in ${backoffMs / 1000}s...`
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          log(
            `[global-setup] Codex preflight rejected the request (${hardQuota ? "usage limit" : "rate limit"}; HTTP ${response.status}).`,
          );
          skipOrFailCodex(
            `Codex backend ${hardQuota ? "quota exhausted (usage_limit_reached)" : "still throttled"} after ${attempt} attempt(s); skipping Codex-dependent specs. (Provide Codex auth: OPENAI_API_KEY or ~/.codex/auth.json.) ${describeCodexAuthFreshness()}`
          );
          return;
        }

        const retryableStatus = response.status >= 500 && response.status < 600;
        if (retryableStatus && attempt < maxAttempts) {
          log(
            `[global-setup] Codex backend returned ${response.status} on preflight attempt ${attempt}/${maxAttempts}; retrying...`
          );
          await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
          continue;
        }

        skipOrFailCodex(
          `Codex backend returned ${response.status}; skipping Codex-dependent specs. (Provide Codex auth: OPENAI_API_KEY or ~/.codex/auth.json.) ${describeCodexAuthFreshness()}`
        );
        return;
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lowered = message.toLowerCase();
    const aborted =
      lowered.includes("this operation was aborted") ||
      lowered.includes("aborterror") ||
      lowered.includes("aborted");

    if (aborted) {
      skipOrFailCodex(`Codex preflight timed out; skipping Codex-dependent specs: ${message}`);
      return;
    }

    skipOrFailCodex(`Codex preflight failed; skipping Codex-dependent specs: ${message}`);
  } finally {
    finalizeCodexPreflight({
      projectName,
      containerName,
      temporaryAuth,
      restoreEnvironment: restorePreflightEnvironment,
    });
  }
}

async function waitUntil(label: string, fn: () => Promise<boolean>, timeoutMs: number, every = 500) {
  log(`Waiting for ${label} (${Math.round(timeoutMs / 1000)}s)…`);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      log(`Checking ${label}…`);
      if (await fn()) {
        log(`${label} is reachable.`);
          return;
      }
      log(`Retrying ${label} in ${every}ms…`);
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await new Promise(r => setTimeout(r, every));
  }
  const suffix =
    lastError instanceof Error
      ? ` Last error: ${lastError.message}`
      : lastError
        ? ` Last error: ${String(lastError)}`
        : "";
  log(`Timed out waiting for ${label}.${suffix}`);
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

async function purgeControllerQueues(
  headers: Record<string, string>,
  projectId: string | null,
) {
  if (!projectId) {
    log("Skipping Supabase conversation purge because PLAYWRIGHT_PROJECT_ID is unavailable.");
    return;
  }
  const tables = [
    "conversation_messages",
    "agent_jobs",
    "runs",
    "prompts",
    "conversations"
  ];
  for (const table of tables) {
    const filter = `project_id=eq.${encodeURIComponent(projectId)}`;
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
        method: "DELETE",
        headers
      });
      if (!response.ok && response.status !== 404) {
        const body = await response.text();
        log(`WARN: Failed to purge ${table} (${response.status}): ${body}`);
      } else {
        log(`Purged ${table} for Playwright project ${projectId}.`);
      }
    } catch (error) {
      log(`WARN: Unable to purge ${table}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function ensureTestUser(supabaseUrl: string, serviceRoleKey: string | null) {
  if (!serviceRoleKey) {
    log("Supabase service role key unavailable; skipping test user provisioning.");
    return;
  }
  try {
    const anonKey = (
      process.env.VITE_SUPABASE_ANON_KEY ??
      process.env.SUPABASE_ANON_KEY ??
      DEFAULT_ANON
    ).trim();
    const verifyExistingCredentials = async () => {
      if (!anonKey) {
        return false;
      }
      const client = createClient(supabaseUrl, anonKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      });
      const { data, error } = await client.auth.signInWithPassword({
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD
      });
      await client.auth.signOut().catch(() => {});
      return !error && Boolean(data.session);
    };

    if (await verifyExistingCredentials()) {
      log(`Reusing existing Playwright test user ${TEST_USER_EMAIL}.`);
      return;
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: TEST_USER_EMAIL,
      email_confirm: true,
      password: TEST_USER_PASSWORD
    });

    if (createError) {
      const message =
        createError instanceof Error ? createError.message : String(createError);
      const normalized = message.toLowerCase();
      const looksLikeExistingUser =
        normalized.includes("already been registered") ||
        normalized.includes("already registered") ||
        normalized.includes("email_exists");
      if (!looksLikeExistingUser) {
        throw createError;
      }
      if (await verifyExistingCredentials()) {
        log(`Reusing existing Playwright test user ${TEST_USER_EMAIL}.`);
        return;
      }
      log(
        `Playwright test user ${TEST_USER_EMAIL} already exists, but password verification failed; leaving the existing user unchanged.`
      );
      return;
    }

    if (created?.user?.id) {
      await admin.auth.admin.updateUserById(created.user.id, {
        password: TEST_USER_PASSWORD
      });
      log(`Provisioned Playwright test user ${TEST_USER_EMAIL}.`);
    }
  } catch (error) {
    log(
      `Failed to ensure Playwright test user: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function ensureTestUserDefaultCodexCredential(
  proxyHealth: RecognizedProxyHealth,
  serviceRoleKey: string,
): Promise<void> {
  const normalizedBackend = proxyHealth.backend.trim().toLowerCase();
  const hasMachineCodexAuth = fs.existsSync(machineCodexAuthPath);
  if (hasMachineCodexAuth && normalizedBackend !== "remote_dynamic") {
    throw new Error(
      "The application-facing AI proxy is not using the BYOC backend; refusing managed/static AI access while ~/.codex/auth.json is available.",
    );
  }
  if (normalizedBackend !== "remote_dynamic") {
    if (proxyHealth.requiresCredential) {
      throw new Error(
        "The application-facing AI proxy requires a user credential but is not using the BYOC backend.",
      );
    }
    return;
  }
  const canonicalAuthPath = fs.existsSync(machineCodexAuthPath)
    ? machineCodexAuthPath
    : proxyCodexAuthPath;
  if (!fs.existsSync(canonicalAuthPath)) {
    throw new Error(
      "The application-facing AI proxy requires a user credential, but no local Codex login is available. Run `codex login`.",
    );
  }
  let authJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(canonicalAuthPath, "utf8")) as unknown;
    authJson = sanitizeCodexSubscriptionAuthJson(parsed);
  } catch {
    throw new Error("The local auth.json does not contain a usable Codex subscription login.");
  }

  const anonKey = (
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    DEFAULT_ANON
  ).trim();
  const client = createClient(SUPABASE_URL, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: TEST_USER_EMAIL,
    password: TEST_USER_PASSWORD,
  });
  const accessToken = data.session?.access_token?.trim() ?? "";
  const userId = data.user?.id?.trim() ?? "";
  if (error || !accessToken || !userId) {
    throw new Error("Unable to authenticate the Playwright user for local Codex onboarding.");
  }

  try {
    // Credential deletion intentionally preserves user-created agent profiles.
    // This canonical test credential is recreated on every runtime-stack
    // setup, so remove only its exact Playwright-owned profiles first. Without
    // this, repeated local runs accumulate handle variants until the
    // controller's bounded handle allocator reaches its collision limit.
    const staleAgentFilter = new URLSearchParams();
    staleAgentFilter.set("user_id", `eq.${userId}`);
    staleAgentFilter.set("display_name", `eq.${playwrightCanonicalCredentialLabel}`);
    const removeStaleAgents = await fetch(
      `${SUPABASE_URL}/rest/v1/user_agents?${staleAgentFilter.toString()}`,
      {
        method: "DELETE",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          prefer: "return=minimal",
        },
      },
    );
    if (!removeStaleAgents.ok) {
      throw new Error(
        `Unable to replace the Playwright local Codex agent profile (HTTP ${removeStaleAgents.status}).`,
      );
    }

    const staleCredentialFilter = buildCodexCredentialCleanupFilter({
      userId,
      label: playwrightCanonicalCredentialLabel,
    });
    const removeStale = await fetch(
      `${SUPABASE_URL}/rest/v1/user_credentials?${staleCredentialFilter.toString()}`,
      {
        method: "DELETE",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          prefer: "return=minimal",
        },
      },
    );
    if (!removeStale.ok) {
      throw new Error(
        `Unable to replace the Playwright local Codex credential (HTTP ${removeStale.status}).`,
      );
    }

    const createCredential = await fetch(`${CONTROLLER_URL}/me/credentials/codex`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        authJson,
        label: playwrightCanonicalCredentialLabel,
        makeDefault: true,
      }),
    });
    if (!createCredential.ok) {
      throw new Error(
        `Unable to onboard the Playwright local Codex credential (HTTP ${createCredential.status}).`,
      );
    }
    const created = (await createCredential.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (
      created?.kind !== "codex_auth_json" ||
      created.isDefault !== true ||
      typeof created.credentialId !== "string"
    ) {
      throw new Error("The controller did not confirm a default Codex auth.json credential.");
    }
    log("Onboarded the canonical local Codex login for the Playwright user.");
  } finally {
    await client.auth.signOut().catch(() => {});
  }
}

export default async function globalSetup() {
  process.env.PLAYWRIGHT_CONTROLLER_REUSED = "0";
  process.env.PLAYWRIGHT_STACK_MODE = USE_EXTERNAL_PLAYWRIGHT_TARGET ? "external" : "controller";
  process.env.PLAYWRIGHT_USE_EXISTING_STACK = "1";
  fs.rmSync(touchedProjectIdsPath, { force: true });
  ensureInitialRuntimeCleanup();
  if (!USE_EXTERNAL_PLAYWRIGHT_TARGET) {
    normalizeRuntimeComposeEnv();
  }
  log(
    `Runtime flags -> strict_mode=${RUNTIME_STRICT_MODE}, dev_isolation=${RUNTIME_DEV_ISOLATION}`
  );

  if (!USE_EXTERNAL_PLAYWRIGHT_TARGET) {
    await startTunnelBrokerFixtureIfNeeded();
  }

  let projectStateCleaned = false;

  // Pass URLs/keys to app + tests
  process.env.PLAYWRIGHT_CONTROLLER_URL = CONTROLLER_URL;
  process.env.VITE_CONTROLLER_URL = CONTROLLER_URL;
  process.env.VITE_SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? SUPABASE_URL;
  process.env.VITE_SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? DEFAULT_ANON;

  if (USE_EXTERNAL_PLAYWRIGHT_TARGET) {
    if (!CONTROLLER_URL) {
      throw new Error(
        "PLAYWRIGHT_EXTERNAL_BASE_URL requires VITE_CONTROLLER_URL (or PLAYWRIGHT_CONTROLLER_URL) to be set."
      );
    }
    if (!SUPABASE_URL) {
      throw new Error(
        "PLAYWRIGHT_EXTERNAL_BASE_URL requires VITE_SUPABASE_URL (or SUPABASE_URL) to be set."
      );
    }
    if (!(process.env.VITE_SUPABASE_ANON_KEY ?? "").trim()) {
      throw new Error(
        "PLAYWRIGHT_EXTERNAL_BASE_URL requires VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY) to be set."
      );
    }

    await waitUntil("external-controller", () => reachable(CONTROLLER_URL, 1_000), 30_000);
    log(`External controller reachable at ${CONTROLLER_URL}.`);
    await waitUntil("external-supabase", () => reachable(SUPABASE_URL, 1_000), 30_000);
    log(`External Supabase reachable at ${SUPABASE_URL}.`);
    await startBenchFixtureSiteIfNeeded();
    log("External Playwright target enabled; skipping local stack provisioning and cleanup.");
    process.env.PLAYWRIGHT_CONTROLLER_REUSED = "1";
    return;
  }

  const controllerTokenAlreadySet = (process.env.CONTROLLER_INTERNAL_TOKEN ?? "").trim();
  if (!controllerTokenAlreadySet && CONTROLLER_URL.includes("127.0.0.1")) {
    process.env.CONTROLLER_INTERNAL_TOKEN = "dev-internal-token";
  }
  const controllerAdminToken =
    (process.env.CONTROLLER_INTERNAL_TOKEN ?? "").trim() ||
    (process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN ?? "").trim() ||
    "";

  let serviceRoleKey = resolveServiceRoleKey({ allowStatus: true });
  if (serviceRoleKey) {
    applyServiceRoleKey(serviceRoleKey);
    if (!projectStateCleaned && PLAYWRIGHT_PROJECT_ID && controllerAdminToken) {
      await cleanupProjectRuntimeState(
        PLAYWRIGHT_PROJECT_ID,
        CONTROLLER_URL,
        controllerAdminToken,
        serviceRoleKey
      );
      projectStateCleaned = true;
    }
  }
  let supabaseAdminHeaders: Record<string, string> | null = serviceRoleKey
    ? {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        prefer: "return=minimal"
      }
    : null;

  // Tool sanity checks
  assertBin("docker", ["--version"]);
  assertBin("pnpm", ["--version"]);
  assertBin("cargo", ["--version"]);

  const skipRuntimeAgentBinaryCheck =
    (process.env.INSTAFY_TEST_E2E_SKIP_RUNTIME_AGENT_BIN ?? "").trim() === "1";
  if (!skipRuntimeAgentBinaryCheck) {
    const runtimeAgentCandidates = [
      path.join(repoRoot, "target", "debug", "runtime-agent"),
      path.join(repoRoot, "target", "release", "runtime-agent"),
      path.join(repoRoot, "packages", "runtime-agent", "target", "debug", "runtime-agent"),
      path.join(repoRoot, "packages", "runtime-agent", "target", "release", "runtime-agent"),
    ];
    const runtimeAgentBin = process.env.INSTAFY_RUNTIME_AGENT_BIN?.trim();
    const hasRuntimeAgent =
      (runtimeAgentBin && fs.existsSync(runtimeAgentBin)) ||
      runtimeAgentCandidates.some((candidate) => fs.existsSync(candidate));
    if (!hasRuntimeAgent) {
      log("[global-setup] runtime-agent binary missing; building via Cargo...");
      run("cargo", [
        "build",
        "--manifest-path",
        path.join(repoRoot, "packages", "runtime-agent", "Cargo.toml"),
      ]);
    }
  } else {
    log("[global-setup] skipping local runtime-agent binary check");
  }

  // Local Supabase can take a couple seconds to respond under load; give it a
  // longer leash so the suite doesn't flake on transient slow startups.
  const controllerUp = await reachable(CONTROLLER_URL, 5_000);
  const supabaseUp = await reachable(SUPABASE_URL, 5_000);
  const proxyHealth = await fetchRecognizedProxyHealth(LOCAL_PROXY_HEALTH_URL, 5_000);
  const stackFullyUp = controllerUp && supabaseUp && proxyHealth !== null;
  if (stackFullyUp && !SHOULD_FORCE_FRESH_RUNTIME) {
    if (!supabaseAdminHeaders) {
      serviceRoleKey = resolveServiceRoleKey({ allowStatus: true });
      if (serviceRoleKey) {
        applyServiceRoleKey(serviceRoleKey);
        supabaseAdminHeaders = {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          prefer: "return=minimal"
        };
        if (!projectStateCleaned && PLAYWRIGHT_PROJECT_ID && controllerAdminToken) {
          await cleanupProjectRuntimeState(
            PLAYWRIGHT_PROJECT_ID,
            CONTROLLER_URL,
            controllerAdminToken,
            serviceRoleKey
          );
          projectStateCleaned = true;
        }
      }
    }
    if (supabaseAdminHeaders) {
      await purgeControllerQueues(supabaseAdminHeaders, PLAYWRIGHT_PROJECT_ID);
      await ensureTestUser(SUPABASE_URL, serviceRoleKey ?? null);
      if (serviceRoleKey && proxyHealth) {
        await ensureControllerProviders(serviceRoleKey);
        await ensureTestUserDefaultCodexCredential(proxyHealth, serviceRoleKey);
      }
      await preflightCodexBackend();
      await startBenchFixtureSiteIfNeeded();
      log("Detected existing controller/Supabase/proxy stack; reusing.");
      process.env.PLAYWRIGHT_CONTROLLER_REUSED = "1";
      return;
    }
    log(
      "Supabase service role key unavailable; recycling runtime stack instead of reusing existing instance."
    );
  }

  if (!stackFullyUp) {
    throw new Error(
      [
        "Controller, Supabase, or the application-facing AI proxy is not reachable for Playwright setup.",
        `Checked controller at ${CONTROLLER_URL}`,
        `Checked Supabase at ${SUPABASE_URL}`,
        `Checked AI proxy at ${LOCAL_PROXY_HEALTH_URL}`,
        "Start the controller stack with `pnpm controller:up` before running tests."
      ].join(" ")
    );
  }

  if (SHOULD_FORCE_FRESH_RUNTIME) {
    log("Dev isolation enabled; clearing controller state without restarting containers.");
  } else {
    log("Reusing controller stack but service role key is unavailable; attempting cleanup without restart.");
  }
  process.env.PLAYWRIGHT_CONTROLLER_REUSED = "1";

  if (!serviceRoleKey) {
    serviceRoleKey = resolveServiceRoleKey({ allowStatus: true });
    if (serviceRoleKey) {
      applyServiceRoleKey(serviceRoleKey);
      supabaseAdminHeaders = {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        prefer: "return=minimal"
      };
      if (!projectStateCleaned && PLAYWRIGHT_PROJECT_ID && controllerAdminToken) {
        await cleanupProjectRuntimeState(
          PLAYWRIGHT_PROJECT_ID,
          CONTROLLER_URL,
          controllerAdminToken,
          serviceRoleKey
        );
        projectStateCleaned = true;
      }
    }
  }

  await waitUntil("controller", () => reachable(CONTROLLER_URL, 1000), 1e4);
  log("Controller is up.");
  await waitUntil("supabase", () => reachable(SUPABASE_URL, 1000), 1e4);
  log("Supabase is up.");
  if (!supabaseAdminHeaders) {
    serviceRoleKey = resolveServiceRoleKey({ allowStatus: true });
    if (serviceRoleKey) {
      applyServiceRoleKey(serviceRoleKey);
      supabaseAdminHeaders = {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        prefer: "return=minimal"
      };
    }
  }
  if (supabaseAdminHeaders) {
    await purgeControllerQueues(supabaseAdminHeaders, PLAYWRIGHT_PROJECT_ID);
  } else {
    log("Supabase service role key still unavailable; skipping controller schema purge.");
  }
  await ensureTestUser(SUPABASE_URL, serviceRoleKey ?? null);
  if (!serviceRoleKey) {
    throw new Error(
      "Supabase service role key is required to onboard the local Codex login for Playwright.",
    );
  }
  if (!proxyHealth) {
    throw new Error(
      "The application-facing AI proxy health contract is unavailable; refusing to continue without BYOC verification.",
    );
  }
  await ensureControllerProviders(serviceRoleKey);
  await ensureTestUserDefaultCodexCredential(proxyHealth, serviceRoleKey);
  await preflightCodexBackend();
  await startBenchFixtureSiteIfNeeded();
  log("Global setup complete.");
}
function resolvePlaywrightProjectId(): string | null {
  const candidates = [
    process.env.PLAYWRIGHT_PROJECT_ID,
    process.env.RUNTIME_PROJECT_ID,
    process.env.PROJECT_ID,
    process.env.VITE_RUNTIME_PROJECT_ID
  ];
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed && UUID_REGEX.test(trimmed)) {
      return trimmed;
    }
  }
  try {
    const runtimeEnvPath = privateEnvPath("docker/.env.local");
    if (!fs.existsSync(runtimeEnvPath)) {
      return null;
    }
    const content = fs.readFileSync(runtimeEnvPath, "utf8");
    const envMap = parseEnv(content);
    const fileCandidates = [
      envMap.SPACE_ID,
      envMap.PROJECT_ID,
    ];
    for (const value of fileCandidates) {
      const trimmed = value?.trim();
      if (trimmed && UUID_REGEX.test(trimmed)) {
        return trimmed;
      }
    }
  } catch (error) {
    log(
      `WARN: Failed to resolve Playwright project id from docker/.env.local: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return null;
}

async function cleanupProjectRuntimeState(
  projectId: string,
  controllerUrl: string,
  controllerAdminToken: string,
  supabaseServiceRoleKey: string
) {
  const cleanedUrl = controllerUrl.replace(/\/+$/, "");
  const controllerHeaders = {
    authorization: `Bearer ${controllerAdminToken}`,
    accept: "application/json"
  } as const;

  try {
    const statusResponse = await fetch(
      `${cleanedUrl}/projects/${encodeURIComponent(projectId)}/runtime/status`,
      { headers: controllerHeaders }
    );
    if (statusResponse.ok) {
      const payload = (await statusResponse.json()) as {
        runtimes?: Array<{ runtimeId?: string | null; id?: string | null }>;
      };
      const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];
      for (const runtime of runtimes) {
        const runtimeId =
          typeof runtime?.runtimeId === "string" && runtime.runtimeId.trim().length > 0
            ? runtime.runtimeId.trim()
            : typeof runtime?.id === "string" && runtime.id.trim().length > 0
              ? runtime.id.trim()
              : null;
        if (!runtimeId) continue;
        try {
          await fetch(`${cleanedUrl}/runtime/stop`, {
            method: "POST",
            headers: {
              ...controllerHeaders,
              "content-type": "application/json"
            },
            body: JSON.stringify({ runtime_id: runtimeId, reason: "playwright-reset" })
          });
        } catch (error) {
          log(
            `WARN: Unable to stop runtime ${runtimeId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
  } catch (error) {
    log(
      `WARN: Failed to inspect runtime status for cleanup: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    await fetch(
      `${cleanedUrl}/projects/${encodeURIComponent(projectId)}/runtime/preference`,
      {
        method: "POST",
        headers: {
          ...controllerHeaders,
          "content-type": "application/json"
        },
        body: JSON.stringify({ runtimeId: null, source: "playwright-reset" })
      }
    );
  } catch (error) {
    log(
      `WARN: Failed to clear controller runtime preference: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    await fetch(`${cleanedUrl}/projects/${encodeURIComponent(projectId)}/workspaces/local`, {
      method: "DELETE",
      headers: {
        ...controllerHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({ deviceId: null })
    });
  } catch (error) {
    log(
      `WARN: Failed to clear controller local workspaces: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    const supabaseHeaders = {
      apikey: supabaseServiceRoleKey,
      authorization: `Bearer ${supabaseServiceRoleKey}`,
      prefer: "return=minimal"
    } as const;
    const tables = [
      "runtime_tunnel_grants",
      "origin_instances",
      "runtimes",
      "runtime_leases",
      "workspace_origins",
      "workspace_leases",
      "origin_presence",
      "workspace_commit_receipts",
      "origin_access_grants"
    ];
    for (const table of tables) {
      try {
        await fetch(
          `${SUPABASE_URL}/rest/v1/${table}?project_id=eq.${encodeURIComponent(projectId)}`,
          {
            method: "DELETE",
            headers: supabaseHeaders
          }
        );
      } catch (tableError) {
        log(
          `WARN: Failed to purge Supabase ${table} records: ${
            tableError instanceof Error
              ? tableError.message
              : String(tableError)
          }`
        );
      }
    }
  } catch (error) {
    log(
      `WARN: Failed to purge Supabase runtime state: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
