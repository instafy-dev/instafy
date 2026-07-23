#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  const exitCode = result.status ?? result.code ?? 1;
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`);
  }
}

function tryCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
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

function listComposeProjectsFromCompose() {
  const res = tryCapture("docker", ["compose", "ls", "--format", "json"]);
  if (res.code !== 0) {
    return [];
  }
  try {
    const rows = JSON.parse(res.stdout);
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => row?.Name).filter(Boolean);
  } catch {
    return [];
  }
}

function listComposeProjectsFromContainers() {
  const res = tryCapture("docker", [
    "ps",
    "-a",
    "--format",
    "{{.Label \"com.docker.compose.project\"}}",
  ]);
  if (res.code !== 0) {
    return [];
  }
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniq(values) {
  return Array.from(new Set(values));
}

function listDockerIds(args) {
  const res = tryCapture("docker", args);
  if (res.code !== 0) {
    return [];
  }
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function pruneComposeProject(projectName) {
  const label = `label=com.docker.compose.project=${projectName}`;
  const containerIds = listDockerIds(["ps", "-a", "--filter", label, "--format", "{{.ID}}"]);
  const networkIds = listDockerIds(["network", "ls", "--filter", label, "--format", "{{.ID}}"]);
  const volumeNames = listDockerIds(["volume", "ls", "--filter", label, "--format", "{{.Name}}"]);

  if (!containerIds.length && !networkIds.length && !volumeNames.length) {
    console.log(`[runtime-dev] No docker resources found for ${projectName}.`);
    return;
  }

  if (containerIds.length) {
    console.log(`[runtime-dev] Removing containers for ${projectName}...`);
    run("docker", ["rm", "-f", ...containerIds]);
  }
  if (networkIds.length) {
    console.log(`[runtime-dev] Removing networks for ${projectName}...`);
    try {
      run("docker", ["network", "rm", ...networkIds]);
    } catch (error) {
      console.warn(`[runtime-dev] Unable to remove networks for ${projectName}: ${error.message}`);
    }
  }
  if (volumeNames.length) {
    console.log(`[runtime-dev] Removing volumes for ${projectName}...`);
    try {
      run("docker", ["volume", "rm", ...volumeNames]);
    } catch (error) {
      console.warn(`[runtime-dev] Unable to remove volumes for ${projectName}: ${error.message}`);
    }
  }
}

const composeProject = (process.env.COMPOSE_PROJECT_NAME || "instafy-runtime").trim();
const projectPrefix = (
  process.env.DOCKER_PROJECT_PREFIX ||
  process.env.RUNTIME_DOCKER_PROJECT_PREFIX ||
  "instafy-runtime-"
).trim();

if (!projectPrefix || projectPrefix.length < 3) {
  console.warn("[runtime-dev] Docker project prefix is empty; skipping prune.");
  process.exit(0);
}

const candidates = uniq([
  ...listComposeProjectsFromCompose(),
  ...listComposeProjectsFromContainers(),
]);
const targets = candidates.filter(
  (name) => name.startsWith(projectPrefix) && name !== composeProject
);

if (!targets.length) {
  console.log(
    `[runtime-dev] No runtime compose projects found with prefix "${projectPrefix}".`
  );
  process.exit(0);
}

console.log(
  `[runtime-dev] Pruning runtime compose projects with prefix "${projectPrefix}" (excluding "${composeProject}")...`
);

for (const projectName of targets) {
  try {
    pruneComposeProject(projectName);
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to prune ${projectName}: ${error.message || error}`
    );
  }
}
