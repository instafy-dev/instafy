#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

export const AUTOMATION_TMP_ROOT = path.join(repoRoot, "tmp", "automation-browsers");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeLabel(label) {
  return String(label || "automation")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "automation";
}

function resolveContainedPath(value) {
  if (!value) {
    return null;
  }
  try {
    return path.resolve(value);
  } catch {
    return null;
  }
}

function isPathInside(childPath, parentPath) {
  const child = resolveContainedPath(childPath);
  const parent = resolveContainedPath(parentPath);
  if (!child || !parent) {
    return false;
  }
  if (child === parent) {
    return true;
  }
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function extractUserDataDir(args) {
  const match = String(args).match(/--user-data-dir=([^\s]+)/u);
  return match?.[1] ?? null;
}

function extractInstafyUserDataDir(args) {
  const match = String(args).match(/--instafy-user-data-dir=([^\s]+)/u);
  return match?.[1] ?? null;
}

function extractCrashpadDatabaseDir(args) {
  const match = String(args).match(/--database=([^\s]+)/u);
  if (!match?.[1]) {
    return null;
  }
  return path.dirname(match[1]);
}

function parseElapsedToSeconds(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return 0;
  }
  const [dayPart, timePart] = value.includes("-") ? value.split("-", 2) : [null, value];
  const timeSegments = timePart.split(":").map((segment) => Number.parseInt(segment, 10));
  if (timeSegments.some((segment) => !Number.isFinite(segment) || segment < 0)) {
    return 0;
  }
  let seconds = 0;
  if (timeSegments.length === 3) {
    seconds += timeSegments[0] * 3600;
    seconds += timeSegments[1] * 60;
    seconds += timeSegments[2];
  } else if (timeSegments.length === 2) {
    seconds += timeSegments[0] * 60;
    seconds += timeSegments[1];
  } else if (timeSegments.length === 1) {
    seconds += timeSegments[0];
  }
  if (dayPart !== null) {
    const days = Number.parseInt(dayPart, 10);
    if (Number.isFinite(days) && days > 0) {
      seconds += days * 24 * 3600;
    }
  }
  return seconds;
}

function readProcessTable() {
  const stdout = execFileSync("ps", ["-axo", "pid,ppid,etime,args"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  return stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
      if (!match) {
        return null;
      }
      const [, pidRaw, ppidRaw, etime, args] = match;
      const pid = Number.parseInt(pidRaw, 10);
      const ppid = Number.parseInt(ppidRaw, 10);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
        return null;
      }
      return {
        pid,
        ppid,
        etime,
        ageSeconds: parseElapsedToSeconds(etime),
        args,
      };
    })
    .filter((row) => row !== null);
}

function isOwnedAutomationProcess(args, ownedTmpDirs) {
  const command = String(args);
  const ownedPath =
    extractInstafyUserDataDir(command) ??
    extractUserDataDir(command) ??
    extractCrashpadDatabaseDir(command);
  if (!ownedPath) {
    return false;
  }
  if (!ownedTmpDirs.some((ownedTmpDir) => isPathInside(ownedPath, ownedTmpDir))) {
    return false;
  }
  if (command.includes("Google Chrome for Testing") || command.includes("chrome_crashpad_handler")) {
    return true;
  }
  return (
    command.includes("/packages/desktop-app/") &&
    command.includes("--allow-multiple-instances") &&
    (command.includes("InstafyBluetoothElectron.app") || command.includes("/Electron "))
  );
}

function collectProcessTree(rootPids, rows) {
  const byParent = new Map();
  for (const row of rows) {
    const entries = byParent.get(row.ppid) ?? [];
    entries.push(row.pid);
    byParent.set(row.ppid, entries);
  }

  const visited = new Set();
  const queue = [...rootPids];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid || visited.has(pid)) {
      continue;
    }
    visited.add(pid);
    for (const childPid of byParent.get(pid) ?? []) {
      if (!visited.has(childPid)) {
        queue.push(childPid);
      }
    }
  }
  return [...visited].sort((left, right) => right - left);
}

export function createAutomationRunTempDir(label, env = process.env) {
  fs.mkdirSync(AUTOMATION_TMP_ROOT, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(AUTOMATION_TMP_ROOT, `${sanitizeLabel(label)}-`));
  env.TMPDIR = tempDir;
  env.TMP = tempDir;
  env.TEMP = tempDir;
  return tempDir;
}

export function createAutomationProcessTempDir(label, env = process.env) {
  fs.mkdirSync(AUTOMATION_TMP_ROOT, { recursive: true });
  const tempDir = fs.mkdtempSync(
    path.join(AUTOMATION_TMP_ROOT, `${sanitizeLabel(label)}-process-`),
  );
  env.TMPDIR = tempDir;
  env.TMP = tempDir;
  env.TEMP = tempDir;
  return tempDir;
}

export async function cleanupOwnedAutomationProcesses({
  ownedTmpDirs,
  minAgeSeconds = 0,
  logger = console,
} = {}) {
  const candidateDirs = Array.from(
    new Set(
      (ownedTmpDirs ?? [])
        .map((value) => resolveContainedPath(value))
        .filter(Boolean),
    ),
  );
  if (candidateDirs.length === 0) {
    return { rootCount: 0, killedCount: 0 };
  }

  const rows = readProcessTable();
  const rootPids = rows
    .filter((row) => {
      return row.ageSeconds >= minAgeSeconds && isOwnedAutomationProcess(row.args, candidateDirs);
    })
    .map((row) => row.pid);

  if (rootPids.length === 0) {
    return { rootCount: 0, killedCount: 0 };
  }

  const treePids = collectProcessTree(rootPids, rows);
  if (treePids.length > 0) {
    logger.info?.(
      `[automation-cleanup] Stopping ${treePids.length} repo-owned automation process${
        treePids.length === 1 ? "" : "es"
      }.`,
    );
  }

  for (const pid of treePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore processes that already exited.
    }
  }

  await sleep(1_500);

  const remainingRows = readProcessTable();
  const remainingPids = collectProcessTree(
    remainingRows
      .filter((row) => isOwnedAutomationProcess(row.args, candidateDirs))
      .map((row) => row.pid),
    remainingRows,
  );

  for (const pid of remainingPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore processes that already exited.
    }
  }

  return {
    rootCount: rootPids.length,
    killedCount: treePids.length,
  };
}

export function cleanupOwnedAutomationTempDirs({
  ownedTmpDirs,
  removeEmptyRoot = false,
  logger = console,
} = {}) {
  const candidateDirs = Array.from(
    new Set(
      (ownedTmpDirs ?? [])
        .map((value) => resolveContainedPath(value))
        .filter(Boolean),
    ),
  );

  let removedCount = 0;
  for (const directory of candidateDirs) {
    if (!isPathInside(directory, AUTOMATION_TMP_ROOT) && directory !== resolveContainedPath(AUTOMATION_TMP_ROOT)) {
      continue;
    }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      removedCount += 1;
    } catch (error) {
      logger.warn?.(
        `[automation-cleanup] Failed to remove ${directory}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (removeEmptyRoot) {
    try {
      if (fs.existsSync(AUTOMATION_TMP_ROOT) && fs.readdirSync(AUTOMATION_TMP_ROOT).length === 0) {
        fs.rmSync(AUTOMATION_TMP_ROOT, { recursive: true, force: true });
      }
    } catch {
      // Ignore empty-root cleanup failures.
    }
  }

  return { removedCount };
}

async function main() {
  const args = process.argv.slice(2);
  const ownedTmpDirs = [];
  let minAgeSeconds = 0;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--tmp-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --tmp-dir");
      }
      ownedTmpDirs.push(value);
      index += 1;
      continue;
    }
    if (arg === "--min-age-seconds") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("Invalid value for --min-age-seconds");
      }
      minAgeSeconds = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const candidateDirs =
    ownedTmpDirs.length > 0
      ? ownedTmpDirs
      : fs.existsSync(AUTOMATION_TMP_ROOT)
        ? fs
            .readdirSync(AUTOMATION_TMP_ROOT)
            .map((entry) => path.join(AUTOMATION_TMP_ROOT, entry))
            .filter((entry) => {
              try {
                return fs.statSync(entry).isDirectory();
              } catch {
                return false;
              }
            })
        : [];

  const processSummary = await cleanupOwnedAutomationProcesses({
    ownedTmpDirs:
      candidateDirs.length > 0
        ? [AUTOMATION_TMP_ROOT, ...candidateDirs]
        : [AUTOMATION_TMP_ROOT],
    minAgeSeconds,
  });
  const tempDirSummary = cleanupOwnedAutomationTempDirs({
    ownedTmpDirs: candidateDirs,
    removeEmptyRoot: true,
  });

  const summary = {
    automationTmpRoot: AUTOMATION_TMP_ROOT,
    ownedTmpDirs: candidateDirs.map((entry) => resolveContainedPath(entry)).filter(Boolean),
    processSummary,
    tempDirSummary,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(
    `[automation-cleanup] Cleaned ${summary.processSummary.killedCount} process${
      summary.processSummary.killedCount === 1 ? "" : "es"
    } and removed ${summary.tempDirSummary.removedCount} temp director${
      summary.tempDirSummary.removedCount === 1 ? "y" : "ies"
    }.`,
  );
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
