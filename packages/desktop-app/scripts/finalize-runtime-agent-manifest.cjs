const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_FILENAME = "runtime-agent-manifest.json";
const SOURCE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function packagedPlatform(electronPlatformName) {
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") return "darwin";
  if (electronPlatformName === "win32") return "win32";
  if (electronPlatformName === "linux") return "linux";
  throw new Error(`Unsupported packaged runtime platform: ${electronPlatformName}`);
}

function resolvePackagedRuntimeBundle(context) {
  const platform = packagedPlatform(context.electronPlatformName);
  const resourcesPath =
    platform === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  const directory = path.join(resourcesPath, "runtime-agent");
  const suffix = platform === "win32" ? ".exe" : "";
  const filename = `runtime-agent${suffix}`;
  const codeModeHostFilename = `codex-code-mode-host${suffix}`;
  return {
    directory,
    executablePath: path.join(directory, filename),
    filename,
    codeModeHostPath: path.join(directory, codeModeHostFilename),
    codeModeHostFilename,
    manifestPath: path.join(directory, MANIFEST_FILENAME),
    platform,
  };
}

// Size and checksum of a packaged binary, refusing anything but a regular file.
function describeBinary(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Unsafe packaged ${label}: ${filePath}`);
  }
  return {
    sizeBytes: stats.size,
    sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
  };
}

function requireStagedManifest(manifestPath, expected) {
  const stats = fs.lstatSync(manifestPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
    throw new Error(`Unsafe staged runtime-agent manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    !manifest ||
    manifest.schemaVersion !== 3 ||
    manifest.filename !== expected.filename ||
    manifest.codeModeHost?.filename !== expected.codeModeHostFilename ||
    manifest.platform !== expected.platform ||
    typeof manifest.arch !== "string" ||
    !SOURCE_SHA_PATTERN.test(manifest.sourceSha || "")
  ) {
    throw new Error(`Invalid staged runtime-agent manifest: ${manifestPath}`);
  }
  return manifest;
}

function finalizeRuntimeAgentManifest(context) {
  const bundle = resolvePackagedRuntimeBundle(context);
  const staged = requireStagedManifest(bundle.manifestPath, bundle);
  const manifest = {
    schemaVersion: 3,
    filename: bundle.filename,
    platform: bundle.platform,
    arch: staged.arch,
    ...describeBinary(bundle.executablePath, "runtime-agent executable"),
    codeModeHost: {
      filename: bundle.codeModeHostFilename,
      ...describeBinary(bundle.codeModeHostPath, "code-mode host"),
    },
    sourceSha: staged.sourceSha,
  };
  const temporaryPath = `${bundle.manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  fs.renameSync(temporaryPath, bundle.manifestPath);
  console.log(
    `[instafy-desktop] Finalized packaged runtime-agent manifest (${manifest.platform}/${manifest.arch}, source=${manifest.sourceSha}).`,
  );
  return { ...bundle, manifest };
}

async function afterPack(context) {
  finalizeRuntimeAgentManifest(context);
}

module.exports = afterPack;
module.exports.finalizeRuntimeAgentManifest = finalizeRuntimeAgentManifest;
module.exports.resolvePackagedRuntimeBundle = resolvePackagedRuntimeBundle;
