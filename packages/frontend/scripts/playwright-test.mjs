import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { primeProcessEnvFromLocalSupabase } from "../../../scripts/lib/localSupabaseEnv.mjs";
import {
  AUTOMATION_TMP_ROOT,
  cleanupOwnedAutomationProcesses,
  cleanupOwnedAutomationTempDirs,
  createAutomationProcessTempDir,
  createAutomationRunTempDir,
} from "./automation-cleanup.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

if ((process.env.GIT_CANONICAL ?? "").trim() === "") {
  process.env.GIT_CANONICAL = "1";
  console.log(
    "[playwright-test] GIT_CANONICAL not set; defaulting to 1 (set GIT_CANONICAL=0 to opt out)."
  );
}

function createChildEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  env.BROWSERSLIST_IGNORE_OLD_DATA = env.BROWSERSLIST_IGNORE_OLD_DATA ?? "1";
  env.BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA =
    env.BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA ?? "1";
  delete env.NO_COLOR;
  return env;
}

function primeLocalSupabaseEnv() {
  primeProcessEnvFromLocalSupabase(process.env, {
    cwd: repoRoot,
    fillApiUrl: true,
    fillAnonKey: true,
    fillServiceRole: true,
    required: false,
  });
}

function killProcessTree(rootPid, signal) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return;
  }

  const descendants = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const currentPid = queue.shift();
    if (!currentPid) {
      continue;
    }

    let stdout = "";
    try {
      const result = spawnSync("pgrep", ["-P", String(currentPid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      stdout = result.status === 0 ? result.stdout : "";
    } catch {}

    const childPids = stdout
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);

    for (const childPid of childPids) {
      if (descendants.has(childPid)) {
        continue;
      }
      descendants.add(childPid);
      queue.push(childPid);
    }
  }

  for (const pid of [...descendants].sort((left, right) => right - left)) {
    try {
      process.kill(pid, signal);
    } catch {}
  }

  try {
    process.kill(rootPid, signal);
  } catch {}
}

function listSiblingAutomationTempDirs(currentTempDir) {
  if (!fs.existsSync(AUTOMATION_TMP_ROOT)) {
    return [];
  }
  const currentResolved = path.resolve(currentTempDir);
  return fs
    .readdirSync(AUTOMATION_TMP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(AUTOMATION_TMP_ROOT, entry.name))
    .map((entryPath) => path.resolve(entryPath))
    .filter((entryPath) => entryPath !== currentResolved);
}

async function cleanupStaleAutomationRuns(currentTempDir) {
  const staleTempDirs = listSiblingAutomationTempDirs(currentTempDir);
  await cleanupOwnedAutomationProcesses({
    ownedTmpDirs: [AUTOMATION_TMP_ROOT],
    minAgeSeconds: 0,
  });
  cleanupOwnedAutomationTempDirs({
    ownedTmpDirs: staleTempDirs,
    removeEmptyRoot: false,
  });
}

async function main() {
  primeLocalSupabaseEnv();
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const command = process.platform === "win32" ? "playwright.cmd" : "playwright";
  const automationTempDir = createAutomationRunTempDir("playwright-test");
  await cleanupStaleAutomationRuns(automationTempDir);
  const playwrightProcessTempDir = createAutomationProcessTempDir("playwright-test");

  let child;
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    await cleanupOwnedAutomationProcesses({
      ownedTmpDirs: [automationTempDir, playwrightProcessTempDir],
      minAgeSeconds: 0,
    });
    cleanupOwnedAutomationTempDirs({
      ownedTmpDirs: [automationTempDir, playwrightProcessTempDir],
      removeEmptyRoot: true,
    });
  };

  const handleSignal = async (signal, exitCode) => {
    if (child?.pid) {
      killProcessTree(child.pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (child.exitCode === null) {
        killProcessTree(child.pid, "SIGKILL");
      }
    }
    await cleanup();
    process.exit(exitCode);
  };

  process.once("SIGINT", () => {
    void handleSignal("SIGINT", 130);
  });
  process.once("SIGTERM", () => {
    void handleSignal("SIGTERM", 143);
  });

  child = spawn(command, ["test", ...args], {
    stdio: "inherit",
    env: {
      ...createChildEnv(),
      TMPDIR: playwrightProcessTempDir,
      TMP: playwrightProcessTempDir,
      TEMP: playwrightProcessTempDir,
    },
  });

  const exitCode = await new Promise((resolve) => {
    child.on("error", () => {
      resolve(1);
    });
    child.on("exit", (code) => {
      resolve(typeof code === "number" ? code : 1);
    });
  });

  await cleanup();
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
