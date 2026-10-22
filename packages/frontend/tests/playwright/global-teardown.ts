import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTROLLER_URL, resolvePlaywrightControllerUrl } from "./utils/controllerUrl.js";
import { runGenericTunnelGrantCleanup } from "./utils/globalTeardownSafety.js";
import {
  findPsql,
  ownedRuntimeContainerIds,
  ownedRuntimeNetworkIds,
  readPlaywrightOwnedProjectIds,
  runtimeCleanupDisabled,
  runtimeComposeNames,
} from "./utils/runtimeCleanupScope.js";
import { resolveLocalSupabaseDbUrl } from "../../../../scripts/lib/localSupabaseEnv.mjs";
const EXTERNAL_BASE_URL = (process.env.PLAYWRIGHT_EXTERNAL_BASE_URL ?? "").trim();
const USE_EXTERNAL_PLAYWRIGHT_TARGET =
  EXTERNAL_BASE_URL.length > 0 || (process.env.PLAYWRIGHT_EXTERNAL_STACK ?? "").trim() === "1";
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function collectProjectIds(): string[] {
  const ids = new Set<string>();
  const envCandidates = [
    process.env.PLAYWRIGHT_PROJECT_ID,
    process.env.RUNTIME_PROJECT_ID,
    process.env.PROJECT_ID,
    process.env.VITE_RUNTIME_PROJECT_ID,
  ];
  for (const candidate of envCandidates) {
    if (candidate && uuidPattern.test(candidate.trim())) {
      ids.add(candidate.trim());
    }
  }

  const repoRoot = resolveRepoRoot(__dirname);
  const touchedProjectIdsPath = path.join(repoRoot, "tmp", ".playwright-touched-project-ids.log");
  if (fs.existsSync(touchedProjectIdsPath)) {
    try {
      const raw = fs.readFileSync(touchedProjectIdsPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (uuidPattern.test(trimmed)) {
          ids.add(trimmed);
        }
      }
    } catch (error) {
      console.warn(
        "[global-teardown] Failed to read touched project ids:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return [...ids];
}

function resolveRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (json?.name === "instafy-monorepo") {
          return dir;
        }
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

const repoRoot = resolveRepoRoot(__dirname);
const tunnelBrokerFlag = path.join(repoRoot, "tmp", ".tunnel-broker-fixture-started");
const benchFixtureSiteStatePath = path.join(repoRoot, "tmp", ".playwright-bench-fixture-site.json");
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

function runDocker(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const message = (result.stderr || "").trim();
    throw new Error(message || `${cmd} ${args.join(" ")} failed`);
  }
  return (result.stdout || "").toString();
}

/** The projects owned by the suite's own users; null when the local database cannot tell. */
function playwrightOwnedProjectIds(): string[] | null {
  try {
    return readPlaywrightOwnedProjectIds({
      dbUrl:
        resolveLocalSupabaseDbUrl({ env: process.env }) ||
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      cwd: repoRoot,
      env: process.env,
      psqlBin: findPsql(process.env),
    });
  } catch (error) {
    console.warn(
      "[global-teardown] Cannot tell which projects are Playwright's own; leaving runtime containers as they are:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/** Remove the runtime containers and networks of `projectIds` (the suite's own projects) only. */
function cleanupRuntimeContainers(projectIds: readonly string[]): void {
  const { prefix, baseComposeProject } = runtimeComposeNames(process.env);
  try {
    const ids = ownedRuntimeContainerIds(
      runDocker("docker", [
        "ps",
        "-a",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Label \"com.docker.compose.project\"}}",
        "--filter",
        `name=${prefix}`,
      ]),
      { prefix, baseComposeProject, projectIds },
    );
    if (ids.length > 0) {
      console.log(`[global-teardown] Removing ${ids.length} lingering runtime containers of Playwright projects...`);
      const result = spawnSync("docker", ["rm", "-f", ...ids], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr = (result.stderr || "").trim();
      if (result.status !== 0 && stderr) {
        console.warn(`[global-teardown] docker rm reported non-zero exit (${result.status}): ${stderr}`);
      }
    }
  } catch (error) {
    console.warn(
      "[global-teardown] Unable to cleanup runtime containers:",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const ids = ownedRuntimeNetworkIds(
      runDocker("docker", ["network", "ls", "--format", "{{.ID}}\t{{.Name}}", "--filter", `name=${prefix}`]),
      { prefix, projectIds },
    );
    if (ids.length > 0) {
      console.log(`[global-teardown] Removing ${ids.length} lingering runtime networks of Playwright projects...`);
      const result = spawnSync("docker", ["network", "rm", ...ids], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr = (result.stderr || "").trim();
      if (result.status !== 0 && stderr) {
        console.warn(`[global-teardown] docker network rm reported non-zero exit (${result.status}): ${stderr}`);
      }
    }
  } catch (error) {
    console.warn(
      "[global-teardown] Unable to cleanup runtime networks:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function stopTunnelBrokerFixtureIfNeeded(): Promise<void> {
  const shouldStopFixture = fs.existsSync(tunnelBrokerFlag);
  if (!shouldStopFixture && !fs.existsSync(tunnelBrokerConfigBackupDir)) return;
  const scriptCwd = repoRoot;
  try {
    if (shouldStopFixture) {
      const { spawnSync } = await import("node:child_process");
      spawnSync(
        "pnpm",
        ["-C", path.join(repoRoot, "packages", "tunnel-broker"), "ingress:down"],
        { cwd: scriptCwd, stdio: "inherit" },
      );
      fs.rmSync(tunnelBrokerFlag, { force: true });
      console.log("[global-teardown] Tunnel-broker fixture stopped.");
    }
  } catch (error) {
    console.warn(
      "[global-teardown] Failed to stop tunnel-broker fixture:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    restoreTunnelBrokerFixtureConfigs();
  }
}

async function stopBenchFixtureSiteIfNeeded(): Promise<void> {
  if (!fs.existsSync(benchFixtureSiteStatePath)) return;
  try {
    const raw = fs.readFileSync(benchFixtureSiteStatePath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number | null; port?: number | null };
    const pid = typeof parsed?.pid === "number" ? parsed.pid : null;
    const port = typeof parsed?.port === "number" ? parsed.port : null;
    if (pid && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[global-teardown] Stopped bench fixture site (pid ${pid}${port ? `, port ${port}` : ""}).`);
      } catch (error) {
        console.warn(
          "[global-teardown] Failed to stop bench fixture site:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } catch (error) {
    console.warn(
      "[global-teardown] Failed to read bench fixture site state:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    try {
      fs.rmSync(benchFixtureSiteStatePath, { force: true });
    } catch {}
  }
}

function restoreTunnelBrokerFixtureConfigs(): void {
  if (!fs.existsSync(tunnelBrokerConfigBackupDir)) {
    return;
  }
  try {
    for (const file of tunnelBrokerConfigFiles) {
      const backupPath = path.join(tunnelBrokerConfigBackupDir, file.backupName);
      if (!fs.existsSync(backupPath)) continue;
      const contents = fs.readFileSync(backupPath, "utf8");
      fs.writeFileSync(file.source, contents, "utf8");
    }
  } catch (error) {
    console.warn(
      "[global-teardown] Failed to restore tunnel-broker fixture configs:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    fs.rmSync(tunnelBrokerConfigBackupDir, { recursive: true, force: true });
  }
}

/** Stop the hosted runtimes of the projects the run touched that are the suite's own. */
async function stopHostedRuntimes(ownedProjectIds: readonly string[]): Promise<void> {
  const controllerUrl = resolvePlaywrightControllerUrl(process.env) || DEFAULT_CONTROLLER_URL;
  const serviceRole =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    "";

  if (!serviceRole) {
    console.warn("[global-teardown] Service role key unavailable; skipping hosted runtime stop.");
    return;
  }

  const projectIds = collectProjectIds().filter((id) => ownedProjectIds.includes(id.toLowerCase()));
  if (projectIds.length === 0) {
    return;
  }

  console.log(
    `[global-teardown] Attempting to stop hosted runtimes for ${projectIds.join(", ")}…`,
  );
  const noRuntimeProjectIds: string[] = [];
  const stoppedRuntimeIds: string[] = [];
  const skippedStoppedRuntimeIds: string[] = [];
  const fetchFailures: string[] = [];

  for (const projectId of projectIds) {
    try {
      const statusResponse = await fetch(
        `${controllerUrl}/projects/${projectId}/runtime/status`,
        {
          headers: {
            authorization: `Bearer ${serviceRole}`,
          },
        },
      );
      if (!statusResponse.ok) {
        if (statusResponse.status === 404) {
          continue;
        }
        fetchFailures.push(
          `${projectId} (${statusResponse.status} ${statusResponse.statusText})`,
        );
        continue;
      }

      const payload = (await statusResponse.json()) as {
        runtimes?: Array<{
          runtimeId?: string | null;
          type?: string | null;
          status?: string | null;
        }>;
      };

      const runtimes = payload.runtimes ?? [];
      if (runtimes.length === 0) {
        noRuntimeProjectIds.push(projectId);
        continue;
      }
      for (const runtime of runtimes) {
        const runtimeId = runtime.runtimeId?.trim() ?? "";
        if (!runtimeId) {
          console.log(
            `[global-teardown] Skipping runtime without id for project ${projectId}.`,
          );
          continue;
        }
        const status = (runtime.status ?? "").toLowerCase();
        if (["stopped", "offline"].includes(status)) {
          skippedStoppedRuntimeIds.push(runtimeId);
          continue;
        }
        try {
          const stopResponse = await fetch(
            `${controllerUrl}/dev/projects/${projectId}/runtime/offline`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${serviceRole}`,
              },
              body: JSON.stringify({ runtime_id: runtimeId }),
            },
          );
          if (!stopResponse.ok) {
            console.warn(
              `[global-teardown] Failed to stop runtime ${runtimeId} for project ${projectId}: ${stopResponse.status} ${stopResponse.statusText}`,
            );
          } else {
            stoppedRuntimeIds.push(runtimeId);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[global-teardown] Error stopping runtime ${runtimeId} for project ${projectId}: ${message}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fetchFailures.push(`${projectId} (${message})`);
    }
  }

  if (noRuntimeProjectIds.length > 0) {
    console.log(
      `[global-teardown] No hosted runtimes found for ${noRuntimeProjectIds.length} project(s).`,
    );
  }
  if (skippedStoppedRuntimeIds.length > 0) {
    console.log(
      `[global-teardown] ${skippedStoppedRuntimeIds.length} runtime(s) were already stopped.`,
    );
  }
  if (stoppedRuntimeIds.length > 0) {
    console.log(
      `[global-teardown] Stopped ${stoppedRuntimeIds.length} hosted runtime(s).`,
    );
  }
  if (fetchFailures.length > 0) {
    console.warn(
      `[global-teardown] Failed to inspect ${fetchFailures.length} project runtime status record(s): ${fetchFailures.join(", ")}`,
    );
  }
  console.log("[global-teardown] Hosted runtime stop attempts completed.");
}

async function purgeTouchedProjectTunnelGrants(): Promise<void> {
  const supabaseUrl = (
    process.env.VITE_SUPABASE_URL ??
    process.env.SUPABASE_URL ??
    (USE_EXTERNAL_PLAYWRIGHT_TARGET ? "" : "http://127.0.0.1:54321")
  ).trim();
  const serviceRole =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    "";

  if (!supabaseUrl || !serviceRole) {
    return;
  }

  const projectIds = collectProjectIds();
  if (projectIds.length === 0) {
    return;
  }

  const headers = {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    prefer: "return=minimal",
  };

  let purged = 0;
  for (const projectId of projectIds) {
    try {
      const response = await fetch(
        `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/runtime_tunnel_grants?project_id=eq.${encodeURIComponent(projectId)}`,
        {
          method: "DELETE",
          headers,
        },
      );
      if (!response.ok && response.status !== 404) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[global-teardown] Failed to purge tunnel grants for ${projectId}: ${response.status} ${response.statusText} ${body}`,
        );
        continue;
      }
      purged += 1;
    } catch (error) {
      console.warn(
        `[global-teardown] Failed to purge tunnel grants for ${projectId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (purged > 0) {
    console.log(`[global-teardown] Purged tunnel grants for ${purged} touched project(s).`);
  }
}

export default async function globalTeardown() {
  if (!USE_EXTERNAL_PLAYWRIGHT_TARGET) {
    try {
      const { stopDesktopOriginServer } = await import("./utils/desktopRuntimeHarness.js");
      await stopDesktopOriginServer().catch((error) => {
        console.warn("[global-teardown] Unable to stop desktop origin:", error);
      });
    } catch (error) {
      console.warn(
        "[global-teardown] Skipping desktop origin teardown:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  await stopBenchFixtureSiteIfNeeded();
  if (!USE_EXTERNAL_PLAYWRIGHT_TARGET) {
    await stopTunnelBrokerFixtureIfNeeded();
  }
  const attemptedTunnelGrantCleanup = await runGenericTunnelGrantCleanup(
    process.env,
    purgeTouchedProjectTunnelGrants,
  );
  if (!attemptedTunnelGrantCleanup) {
    console.log(
      "[global-teardown] Non-local Playwright target detected; leaving shared touched-project tunnel grants to the target-specific fixture.",
    );
  }
  try {
    const {
      cleanupOwnedAutomationProcesses,
      cleanupOwnedAutomationTempDirs,
      AUTOMATION_TMP_ROOT,
    } = await import("../../scripts/automation-cleanup.mjs");
    if (fs.existsSync(AUTOMATION_TMP_ROOT)) {
      const ownedTmpDirs = fs
        .readdirSync(AUTOMATION_TMP_ROOT)
        .map((entry) => path.join(AUTOMATION_TMP_ROOT, entry))
        .filter((entry) => {
          try {
            return fs.statSync(entry).isDirectory();
          } catch {
            return false;
          }
        });
      await cleanupOwnedAutomationProcesses({
        ownedTmpDirs,
        minAgeSeconds: 0,
      });
      cleanupOwnedAutomationTempDirs({
        ownedTmpDirs,
        removeEmptyRoot: true,
      });
    }
  } catch (error) {
    console.warn(
      "[global-teardown] Unable to cleanup automation browser processes:",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (runtimeCleanupDisabled(process.env)) {
    console.log("[global-teardown] KEEP_RUNTIME=1 or PLAYWRIGHT_CLEANUP_RUNTIME=0 -> skipping teardown");
    return;
  }
  if (USE_EXTERNAL_PLAYWRIGHT_TARGET) {
    console.log("[global-teardown] External Playwright target enabled; skipping local runtime/container teardown.");
    return;
  }
  const ownedProjectIds = playwrightOwnedProjectIds();
  if (ownedProjectIds === null) {
    return;
  }
  await stopHostedRuntimes(ownedProjectIds);
  cleanupRuntimeContainers(ownedProjectIds);
}
