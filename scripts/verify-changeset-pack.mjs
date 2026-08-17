#!/usr/bin/env node

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_TAR_ENTRIES = 500;
const REPOSITORY_URL = "git+https://github.com/instafy-dev/instafy.git";

const PACKAGE_POLICIES = new Map([
  [
    "@instafy/cli",
    {
      directory: "packages/instafy-cli",
      files: [
        "package/LICENSE",
        "package/README.md",
        "package/bin/instafy.js",
        "package/dist/cli.js",
        "package/package.json",
      ],
    },
  ],
  [
    "@instafy/provider-contract",
    {
      directory: "packages/provider-contract",
      files: [
        "package/LICENSE",
        "package/README.md",
        "package/builtins.d.ts",
        "package/builtins.js",
        "package/index.d.ts",
        "package/index.js",
        "package/package.json",
        "package/provider-core.d.ts",
        "package/provider-core.js",
        "package/provider-sandbox.d.ts",
        "package/provider-sandbox.js",
        "package/provider-ui-surface.d.ts",
        "package/provider-ui-surface.js",
        "package/shared.js",
      ],
    },
  ],
]);

function fail(message) {
  throw new Error(`[changeset-pack] ${message}`);
}

function readCString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function readOctal(buffer, offset, length, label) {
  const raw = readCString(buffer, offset, length).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/u.test(raw)) fail(`${label} is not an octal tar field`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is out of range`);
  return value;
}

function isZeroBlock(buffer, offset) {
  for (let index = offset; index < offset + 512; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function validateTarPath(value) {
  if (!value.startsWith("package/") || value.includes("\\") || value.includes("\0")) {
    fail(`unsafe tar path ${JSON.stringify(value)}`);
  }
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    fail(`non-canonical tar path ${JSON.stringify(value)}`);
  }
  if (value.split("/").includes("..")) fail(`traversing tar path ${JSON.stringify(value)}`);
}

function parseTarball(tarball) {
  let unpacked;
  try {
    unpacked = gunzipSync(tarball, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (error) {
    fail(`tarball is not a bounded gzip archive: ${error instanceof Error ? error.message : String(error)}`);
  }

  const files = new Map();
  let offset = 0;
  let entryCount = 0;
  let totalFileBytes = 0;
  let terminatorBlocks = 0;

  while (offset + 512 <= unpacked.length) {
    if (isZeroBlock(unpacked, offset)) {
      terminatorBlocks += 1;
      offset += 512;
      if (terminatorBlocks === 2) break;
      continue;
    }
    if (terminatorBlocks !== 0) fail("tar archive has data after a zero terminator block");

    entryCount += 1;
    if (entryCount > MAX_TAR_ENTRIES) fail(`tar archive exceeds ${MAX_TAR_ENTRIES} entries`);

    const storedChecksum = readOctal(unpacked, offset + 148, 8, "tar checksum");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 32 : unpacked[offset + index];
    }
    if (checksum !== storedChecksum) fail("tar header checksum mismatch");

    const name = readCString(unpacked, offset, 100);
    const prefix = readCString(unpacked, offset + 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    validateTarPath(entryPath);

    const typeByte = unpacked[offset + 156];
    if (typeByte !== 0 && typeByte !== "0".charCodeAt(0)) {
      fail(`tar entry ${JSON.stringify(entryPath)} is not a regular file`);
    }
    const size = readOctal(unpacked, offset + 124, 12, `size for ${entryPath}`);
    totalFileBytes += size;
    if (totalFileBytes > MAX_UNPACKED_BYTES) fail("tar file content exceeds the unpacked limit");

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > unpacked.length) fail(`tar entry ${JSON.stringify(entryPath)} is truncated`);
    if (files.has(entryPath)) fail(`duplicate tar entry ${JSON.stringify(entryPath)}`);
    files.set(entryPath, unpacked.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  if (terminatorBlocks !== 2) fail("tar archive is missing its two-block terminator");
  return files;
}

function stableVersion(value) {
  return typeof value === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value);
}

function expectedTarballPath(name, version) {
  return `packages/${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

function parsePublishPlan(value) {
  if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.plan)) {
    fail("publish-plan.json must have Changesets plan version 1");
  }
  const entries = value.plan.flatMap((wave) => {
    if (!Array.isArray(wave)) fail("publish plan waves must be arrays");
    return wave;
  });
  if (entries.length === 0) fail("publish plan is empty");

  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") fail("publish plan entries must be objects");
    const policy = PACKAGE_POLICIES.get(entry.name);
    if (!policy) fail(`unrecognized publishable package ${JSON.stringify(entry.name)}`);
    if (seen.has(entry.name)) fail(`duplicate publish plan entry for ${entry.name}`);
    seen.add(entry.name);
    if (entry.kind !== "publish") fail(`${entry.name} has unsupported plan kind ${JSON.stringify(entry.kind)}`);
    if (!stableVersion(entry.version)) fail(`${entry.name} must use a stable SemVer version`);
    if (entry.access !== "public") fail(`${entry.name} must publish with public access`);
    if (entry.tag !== "latest") fail(`${entry.name} must publish to the latest dist-tag`);
    if (!entry.tarball || typeof entry.tarball !== "object") fail(`${entry.name} is missing tarball metadata`);
    const expectedPath = expectedTarballPath(entry.name, entry.version);
    if (entry.tarball.path !== expectedPath) {
      fail(`${entry.name} tarball path must be ${expectedPath}`);
    }
    if (typeof entry.tarball.integrity !== "string" || !entry.tarball.integrity.startsWith("sha256-")) {
      fail(`${entry.name} is missing a SHA-256 pack integrity`);
    }
  }
  return entries;
}

async function listPackFiles(root) {
  const output = [];
  async function visit(directory, relativeDirectory = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) fail(`pack contains symlink ${JSON.stringify(relativePath)}`);
      if (stat.isDirectory()) {
        await visit(fullPath, relativePath);
      } else if (stat.isFile()) {
        output.push({ relativePath, fullPath, size: stat.size });
      } else {
        fail(`pack contains non-regular entry ${JSON.stringify(relativePath)}`);
      }
    }
  }
  await visit(root);
  return output;
}

function validatePackageManifest(entry, manifest) {
  const policy = PACKAGE_POLICIES.get(entry.name);
  if (!manifest || typeof manifest !== "object") fail(`${entry.name} package.json is not an object`);
  if (manifest.name !== entry.name || manifest.version !== entry.version) {
    fail(`${entry.name} tarball manifest identity does not match the publish plan`);
  }
  if (manifest.private === true || manifest.publishConfig?.access !== "public") {
    fail(`${entry.name} tarball manifest is not public`);
  }
  if (
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== policy.directory
  ) {
    fail(`${entry.name} tarball repository metadata is not canonical`);
  }
}

async function registryPackageIntegrity(name, version) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { redirect: "error", signal: AbortSignal.timeout(15_000) },
  );
  if (response.status === 404) return null;
  if (!response.ok) fail(`npm registry returned HTTP ${response.status} for ${name}@${version}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) fail(`npm registry response for ${name}@${version} is too large`);
  const body = JSON.parse(text);
  return typeof body?.dist?.integrity === "string" ? body.dist.integrity : null;
}

async function verifyRegistry(entry, sha512, mode) {
  const attempts = mode === "after" ? 10 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const registryIntegrity = await registryPackageIntegrity(entry.name, entry.version);
    if (registryIntegrity === sha512) return true;
    if (registryIntegrity && registryIntegrity !== sha512) {
      fail(`npm already has different bytes for ${entry.name}@${entry.version}`);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (mode === "after") fail(`npm did not expose ${entry.name}@${entry.version} with the expected integrity`);
  return false;
}

export async function verifyPackDirectory(packDirectory, options = {}) {
  const root = await fs.realpath(packDirectory);
  const files = await listPackFiles(root);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_PACK_BYTES) fail("pack exceeds the total compressed-size limit");

  const planFile = files.find((file) => file.relativePath === "publish-plan.json");
  if (!planFile || planFile.size > MAX_PLAN_BYTES) fail("publish-plan.json is missing or too large");
  const plan = JSON.parse(await fs.readFile(planFile.fullPath, "utf8"));
  const entries = parsePublishPlan(plan);

  const expectedFiles = new Set(["publish-plan.json", ...entries.map((entry) => entry.tarball.path)]);
  const actualFiles = new Set(files.map((file) => file.relativePath));
  if (
    expectedFiles.size !== actualFiles.size ||
    [...expectedFiles].some((file) => !actualFiles.has(file))
  ) {
    fail("pack contains missing or unexpected files");
  }

  if (options.sourceSha !== undefined && !/^[0-9a-f]{40}$/u.test(options.sourceSha)) {
    fail("source SHA must be a full lowercase Git commit");
  }
  const receiptPackages = [];
  for (const entry of entries) {
    const tarballPath = path.join(root, ...entry.tarball.path.split("/"));
    const tarball = await fs.readFile(tarballPath);
    if (tarball.length === 0 || tarball.length > MAX_TARBALL_BYTES) {
      fail(`${entry.name} tarball size is outside the allowed range`);
    }
    const sha256Bytes = createHash("sha256").update(tarball).digest();
    const sha256 = `sha256-${sha256Bytes.toString("base64")}`;
    if (sha256 !== entry.tarball.integrity) fail(`${entry.name} SHA-256 integrity mismatch`);
    const sha512 = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

    const tarFiles = parseTarball(tarball);
    const policy = PACKAGE_POLICIES.get(entry.name);
    const expectedPackageFiles = [...policy.files].sort();
    const actualPackageFiles = [...tarFiles.keys()].sort();
    if (
      expectedPackageFiles.length !== actualPackageFiles.length ||
      expectedPackageFiles.some((file, index) => file !== actualPackageFiles[index])
    ) {
      fail(`${entry.name} tarball file boundary is not exact`);
    }
    let manifest;
    try {
      manifest = JSON.parse(tarFiles.get("package/package.json").toString("utf8"));
    } catch (error) {
      fail(`${entry.name} package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    validatePackageManifest(entry, manifest);

    let alreadyPublished = null;
    if (options.registry === "before" || options.registry === "after") {
      alreadyPublished = await verifyRegistry(entry, sha512, options.registry);
    }
    receiptPackages.push({
      name: entry.name,
      version: entry.version,
      tag: entry.tag,
      bytes: tarball.length,
      sha256,
      sha512,
      alreadyPublished,
    });
  }

  const receipt = {
    schemaVersion: "instafy-npm-release-receipt-v1",
    sourceSha: options.sourceSha ?? null,
    packages: receiptPackages.sort((left, right) => left.name.localeCompare(right.name)),
  };
  if (options.output) {
    await fs.writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return receipt;
}

function parseArgs(argv) {
  const options = { registry: "none" };
  let directory;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--source-sha") options.sourceSha = argv[++index];
    else if (value === "--output") options.output = argv[++index];
    else if (value === "--registry") options.registry = argv[++index];
    else if (value.startsWith("-")) fail(`unknown option ${value}`);
    else if (directory) fail("expected exactly one pack directory");
    else directory = value;
  }
  if (!directory) fail("usage: verify-changeset-pack.mjs <pack-directory> [--source-sha SHA] [--registry none|before|after] [--output FILE]");
  if (!new Set(["none", "before", "after"]).has(options.registry)) fail("registry mode must be none, before, or after");
  return { directory, options };
}

if (
  process.argv[1] &&
  (await fs.realpath(process.argv[1])) === (await fs.realpath(fileURLToPath(import.meta.url)))
) {
  const { directory, options } = parseArgs(process.argv.slice(2));
  try {
    const receipt = await verifyPackDirectory(directory, options);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
