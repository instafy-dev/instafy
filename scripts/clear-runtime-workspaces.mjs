#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const defaultWorkspaceRoot = path.join(repoRoot, "tmp", "runtime-sandbox");

const workspaceRoot = (process.env.WORKSPACE_ROOT ?? "").trim() || defaultWorkspaceRoot;
const dryRun = process.argv.includes("--dry-run");
const keepArgs = process.argv
  .filter((arg) => arg.startsWith("--keep="))
  .map((arg) => arg.slice("--keep=".length).trim())
  .filter(Boolean);
const keepIds = new Set(keepArgs);

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[workspace:clear] ${message}`);
}

function removeWorkspace(dir) {
  if (dryRun) {
    log(`dry-run -> would remove ${dir}`);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  log(`removed ${dir}`);
}

if (!fs.existsSync(workspaceRoot)) {
  log(`workspace root ${workspaceRoot} not found; nothing to clear.`);
  process.exit(0);
}

const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
const targets = entries
  .filter((entry) => entry.isDirectory() && uuidPattern.test(entry.name))
  .map((entry) => entry.name)
  .filter((name) => !keepIds.has(name));

if (targets.length === 0) {
  log("no UUID workspace directories found.");
  process.exit(0);
}

log(
  `clearing ${targets.length} workspace director${targets.length === 1 ? "y" : "ies"} under ${workspaceRoot}${
    dryRun ? " (dry run)" : ""
  }${keepIds.size ? `; keeping ${Array.from(keepIds).join(", ")}` : ""}`,
);

for (const name of targets) {
  const fullPath = path.join(workspaceRoot, name);
  try {
    removeWorkspace(fullPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to remove ${fullPath}: ${message}`);
  }
}

log("done.");
