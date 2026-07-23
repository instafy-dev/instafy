import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeRuntimeLifecycleLogs,
  type RuntimeLifecycleSummary,
} from "./utils/runtimeLifecycleDiagnostics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const diagnosticsRoot = path.join(repoRoot, "tmp", "e2e-diagnostics");
let lifecycleCaptureSequence = 0;

type HostedComposeContainer = {
  id: string;
  composeProject: string;
  composeService: string;
};

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

function listHostedComposeContainers(
  dockerProjectPrefix: string,
  baseComposeProject: string,
): HostedComposeContainer[] {
  return runDocker("docker", [
    "ps",
    "-a",
    "--format",
    '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
    "--filter",
    `name=${dockerProjectPrefix}`,
  ])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((row) => {
      const [id, , composeProject, composeService] = row.split("\t");
      if (!id) return null;
      const project = (composeProject || "").trim();
      if (!project || project === baseComposeProject || !project.startsWith(dockerProjectPrefix)) {
        return null;
      }
      return {
        id,
        composeProject: project,
        composeService: (composeService || "").trim(),
      };
    })
    .filter((container): container is HostedComposeContainer => Boolean(container));
}

function readRuntimeLifecycleSummary(containerId: string): RuntimeLifecycleSummary | null {
  const result = spawnSync("docker", ["logs", "--timestamps", "--tail", "5000", containerId], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;

  // Docker preserves a container's stdout and stderr as separate CLI streams.
  // Parse both in memory, persist only the allowlisted aggregate, then let the
  // strings fall out of scope.
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return summarizeRuntimeLifecycleLogs(`${stdout}\n${stderr}`);
}

function captureRuntimeLifecycleDiagnostics(containers: HostedComposeContainer[]): void {
  try {
    const runtimeContainers = containers
      .filter((container) => container.composeService === "runtime")
      .sort((left, right) =>
        `${left.composeProject}\u0000${left.id}`.localeCompare(`${right.composeProject}\u0000${right.id}`),
      );
    const summaries = runtimeContainers
      .map((container) => readRuntimeLifecycleSummary(container.id))
      .filter((summary): summary is RuntimeLifecycleSummary => summary !== null)
      .map((summary, index) => ({
        ordinal: index + 1,
        ...summary,
      }));

    fs.mkdirSync(diagnosticsRoot, { recursive: true });
    lifecycleCaptureSequence += 1;
    const fileName = `runtime-lifecycle-${Date.now()}-${lifecycleCaptureSequence}.json`;
    fs.writeFileSync(
      path.join(diagnosticsRoot, fileName),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runtimeContainerCount: runtimeContainers.length,
          runtimeLogSummaryCount: summaries.length,
          containers: summaries,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    // Diagnostics are best effort and must never alter cleanup or test results.
  }
}

function cleanupRuntimeContainers(captureBeforeRemoval: boolean): void {
  const dockerProjectPrefix =
    (process.env.DOCKER_PROJECT_PREFIX ||
      process.env.RUNTIME_DOCKER_PROJECT_PREFIX ||
      "instafy-runtime-").trim() || "instafy-runtime-";
  const baseComposeProject = (process.env.COMPOSE_PROJECT_NAME || "instafy-runtime").trim() || "instafy-runtime";

  try {
    const containers = listHostedComposeContainers(dockerProjectPrefix, baseComposeProject);
    const ids = containers.map((container) => container.id);

    if (ids.length > 0) {
      if (captureBeforeRemoval) {
        captureRuntimeLifecycleDiagnostics(containers);
      }
      spawnSync("docker", ["rm", "-f", ...ids], { cwd: repoRoot, env: process.env, stdio: "ignore" });
    }
  } catch {
    // best effort cleanup; avoid failing tests due to docker hiccups
  }
}

function cleanupRuntimeNetworks(): void {
  const dockerProjectPrefix =
    (process.env.DOCKER_PROJECT_PREFIX ||
      process.env.RUNTIME_DOCKER_PROJECT_PREFIX ||
      "instafy-runtime-").trim() || "instafy-runtime-";

  try {
    const rows = runDocker("docker", [
      "network",
      "ls",
      "--format",
      "{{.ID}}\t{{.Name}}",
      "--filter",
      `name=${dockerProjectPrefix}`,
    ])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const ids = rows
      .map((row) => {
        const [id, name] = row.split("\t");
        if (!id || !name) return null;
        if (!name.startsWith(dockerProjectPrefix)) return null;
        return id;
      })
      .filter((id): id is string => Boolean(id));

    if (ids.length > 0) {
      spawnSync("docker", ["network", "rm", ...ids], { cwd: repoRoot, env: process.env, stdio: "ignore" });
    }
  } catch {
    // best effort cleanup; avoid failing tests due to docker hiccups
  }
}

function maybeCleanupDockerRuntimeResources(test: TestCase, result: TestResult): void {
  if (process.env.KEEP_RUNTIME === "1") return;
  if ((process.env.PLAYWRIGHT_CLEANUP_RUNTIME ?? "1").trim() === "0") return;

  // Avoid doing work for the setup project when only the runtime stack is starting.
  const titlePath = test.titlePath();
  if (titlePath.includes("runtime-setup")) return;

  cleanupRuntimeContainers(result.status !== test.expectedStatus);
  cleanupRuntimeNetworks();
}

export default class RuntimeCleanupReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    maybeCleanupDockerRuntimeResources(test, result);
  }
}
