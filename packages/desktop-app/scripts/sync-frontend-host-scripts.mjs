#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const sourceDir = path.resolve(packageRoot, "..", "frontend", "scripts");
const targetDir = path.join(packageRoot, "dist", "frontend-scripts");

export const DESKTOP_FRONTEND_RUNTIME_FILES = Object.freeze([
  "current-local-provider-registry.mjs",
  "local-provider-feature-module.mjs",
  "local-provider-host-server.mjs",
  "local-provider-host.config.json",
  "local-provider-host.mjs",
  "local-provider-registry.mjs",
  "local-speech-service.mjs",
  "providers/camera-provider.mjs",
  "providers/local-device-toggle-provider.mjs",
  "providers/speech-provider.mjs",
  "public-core-local-provider-feature-module.mjs",
  "public-local-provider-feature-manifest.mjs",
  "shared/audio-artifact.mjs",
  "shared/openai-speech-backend.mjs",
  "shared/speech-host-config.mjs",
  "shared/speech-managed-runtime.mjs",
  "speech-backend-bootstrap.mjs",
]);

const STATIC_RELATIVE_MODULE_PATTERNS = [
  /\bfrom\s*["'](\.{1,2}\/[^"']+)["']/gu,
  /\bimport\s*["'](\.{1,2}\/[^"']+)["']/gu,
  /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu,
];
const RELATIVE_RESOURCE_PATTERN =
  /\bnew\s+URL\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/gu;

function assertSafeRuntimeFile(file) {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    file !== file.trim() ||
    file !== file.split(path.sep).join("/") ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe Desktop frontend runtime allowlist path: ${String(file)}`);
  }
}

function resolveRelativeRuntimePath(importingFile, specifier) {
  const withoutSuffix = specifier.split(/[?#]/u, 1)[0];
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importingFile), withoutSuffix),
  );
  assertSafeRuntimeFile(resolved);
  return resolved;
}

function collectRelativeRuntimeDependencies(file, source) {
  const dependencies = new Set();
  for (const pattern of STATIC_RELATIVE_MODULE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      dependencies.add(resolveRelativeRuntimePath(file, match[1]));
    }
  }
  RELATIVE_RESOURCE_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(RELATIVE_RESOURCE_PATTERN)) {
    const dependency = resolveRelativeRuntimePath(file, match[1]);
    if (path.posix.extname(dependency)) {
      dependencies.add(dependency);
    }
  }
  return [...dependencies].sort();
}

async function validateRuntimeFileAllowlist(runtimeSourceDir) {
  const approved = new Set();
  for (const file of DESKTOP_FRONTEND_RUNTIME_FILES) {
    assertSafeRuntimeFile(file);
    if (approved.has(file)) {
      throw new Error(`Duplicate Desktop frontend runtime allowlist path: ${file}`);
    }
    approved.add(file);
  }

  for (const file of DESKTOP_FRONTEND_RUNTIME_FILES) {
    const sourcePath = path.join(runtimeSourceDir, ...file.split("/"));
    const stat = await fs.lstat(sourcePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Required Desktop frontend runtime file is missing or unsafe: ${file}`);
    }
    if (path.posix.extname(file) !== ".mjs") {
      continue;
    }

    const source = await fs.readFile(sourcePath, "utf8");
    for (const dependency of collectRelativeRuntimeDependencies(file, source)) {
      if (!approved.has(dependency)) {
        throw new Error(
          `Desktop frontend runtime dependency is not allowlisted: ${file} -> ${dependency}`,
        );
      }
    }
  }
}

export async function syncFrontendHostScripts({
  runtimeSourceDir = sourceDir,
  runtimeTargetDir = targetDir,
} = {}) {
  const resolvedSourceDir = path.resolve(runtimeSourceDir);
  const resolvedTargetDir = path.resolve(runtimeTargetDir);
  if (
    resolvedSourceDir === resolvedTargetDir ||
    resolvedSourceDir.startsWith(`${resolvedTargetDir}${path.sep}`) ||
    resolvedTargetDir.startsWith(`${resolvedSourceDir}${path.sep}`)
  ) {
    throw new Error("Desktop frontend runtime source and target directories cannot overlap.");
  }

  await validateRuntimeFileAllowlist(resolvedSourceDir);
  await fs.rm(resolvedTargetDir, { recursive: true, force: true });

  for (const file of DESKTOP_FRONTEND_RUNTIME_FILES) {
    const sourcePath = path.join(resolvedSourceDir, ...file.split("/"));
    const destinationPath = path.join(resolvedTargetDir, ...file.split("/"));
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
  }

  console.log(
    `Synced ${DESKTOP_FRONTEND_RUNTIME_FILES.length} allowlisted frontend runtime files to ${resolvedTargetDir}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void syncFrontendHostScripts().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
