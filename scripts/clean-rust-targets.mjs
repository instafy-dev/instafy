#!/usr/bin/env node
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const dryRun = process.argv.includes("--dry-run");
const repoRoot = process.cwd();
const skippedDirectoryNames = new Set([
  ".git",
  ".next",
  ".turbo",
  "dist",
  "node_modules",
  "tmp",
]);

function isDirectory(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function findCargoDirectories(startDir) {
  const cargoDirs = [];
  const stack = [startDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    let hasCargoToml = false;
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "Cargo.toml") {
        hasCargoToml = true;
        break;
      }
    }
    if (hasCargoToml) {
      cargoDirs.push(current);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (skippedDirectoryNames.has(entry.name)) {
        continue;
      }
      stack.push(path.join(current, entry.name));
    }
  }

  return cargoDirs;
}

function toRepoRelative(targetPath) {
  const relative = path.relative(repoRoot, targetPath);
  return relative && relative.length > 0 ? relative : ".";
}

const cargoDirs = findCargoDirectories(repoRoot);
const targetDirs = cargoDirs
  .map((cargoDir) => path.join(cargoDir, "target"))
  .filter((targetDir) => existsSync(targetDir) && isDirectory(targetDir))
  .sort((left, right) => left.localeCompare(right));

if (targetDirs.length === 0) {
  console.log("[clean-rust-targets] No Rust target directories found.");
  process.exit(0);
}

for (const targetDir of targetDirs) {
  console.log(
    `${dryRun ? "[dry-run] Would remove" : "[clean-rust-targets] Removing"} ${toRepoRelative(targetDir)}`
  );
  if (!dryRun) {
    rmSync(targetDir, { recursive: true, force: true });
  }
}

if (!dryRun) {
  console.log(`[clean-rust-targets] Removed ${targetDirs.length} Rust target director${targetDirs.length === 1 ? "y" : "ies"}.`);
}
