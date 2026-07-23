#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildBundleManifest,
  createBundleVersion,
  sha256Hex,
  signBufferWithRsaSha256,
} from "./lib/otaReleaseHelpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [key, inlineValue] = arg.split("=", 2);
    if (inlineValue !== undefined) {
      options.set(key, inlineValue);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      options.set(key, "true");
      continue;
    }
    options.set(key, value);
    index += 1;
  }
  return options;
}

function repoRelative(targetPath) {
  return path.relative(repoRoot, targetPath) || ".";
}

function resolveGitSha() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "local";
  }
}

function writeGitHubOutputs(outputPath, values) {
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function normalizePem(value) {
  return value.replaceAll("\\n", "\n").trim();
}

function resolveSigningPrivateKey(args) {
  const inlinePrivateKey = args.get("--private-key") || process.env.OTA_SIGNING_PRIVATE_KEY;
  if (inlinePrivateKey?.trim()) {
    return normalizePem(inlinePrivateKey);
  }

  const privateKeyPath = args.get("--private-key-file") || process.env.OTA_SIGNING_PRIVATE_KEY_FILE;
  if (privateKeyPath?.trim()) {
    const resolvedPath = path.resolve(repoRoot, privateKeyPath.trim());
    return normalizePem(fs.readFileSync(resolvedPath, "utf8"));
  }

  return null;
}

const args = parseArgs(process.argv.slice(2));
const distDir = path.resolve(repoRoot, args.get("--dist") || "packages/frontend/dist");
const outDir = path.resolve(repoRoot, args.get("--out") || "tmp/ota");

if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
  console.error(`[ota:bundle] Dist directory not found: ${distDir}`);
  process.exit(1);
}

const createdAt = args.get("--created-at") || new Date().toISOString();
const gitSha = args.get("--git-sha") || resolveGitSha();
const bundleVersion =
  args.get("--bundle-version") || createBundleVersion({ createdAt, gitSha });
const signingPrivateKey = resolveSigningPrivateKey(args);

fs.mkdirSync(outDir, { recursive: true });

const archiveFileName = `${bundleVersion}.zip`;
const archivePath = path.join(outDir, archiveFileName);
const manifestPath = path.join(outDir, `${bundleVersion}.manifest.json`);

if (fs.existsSync(archivePath)) {
  fs.rmSync(archivePath, { force: true });
}

try {
  execFileSync("zip", ["-qr", archivePath, "."], {
    cwd: distDir,
    stdio: "inherit",
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[ota:bundle] Failed to create zip archive. Ensure the `zip` command is available.");
  console.error(message);
  process.exit(1);
}

const archiveBuffer = fs.readFileSync(archivePath);
const archiveSignature = signingPrivateKey
  ? signBufferWithRsaSha256(archiveBuffer, signingPrivateKey)
  : null;
const manifest = buildBundleManifest({
  bundleVersion,
  gitSha,
  createdAt,
  archiveFileName,
  archiveSha256: sha256Hex(archiveBuffer),
  archiveSignature,
  archiveSizeBytes: archiveBuffer.byteLength,
  sourceDir: repoRelative(distDir),
});

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

writeGitHubOutputs(process.env.GITHUB_OUTPUT, {
  ota_bundle_version: bundleVersion,
  ota_archive_path: repoRelative(archivePath),
  ota_archive_file_name: archiveFileName,
  ota_manifest_path: repoRelative(manifestPath),
  ota_archive_sha256: manifest.archive_sha256,
  ota_archive_signature: manifest.archive_signature || "",
});

console.log(`[ota:bundle] bundle_version=${bundleVersion}`);
console.log(`[ota:bundle] archive=${repoRelative(archivePath)}`);
console.log(`[ota:bundle] manifest=${repoRelative(manifestPath)}`);
console.log(`[ota:bundle] signed=${archiveSignature ? "yes" : "no"}`);
